import log from 'electron-log';
// 复用 DPAPI 后端的子进程运行器：同一套纪律（stdin 传参、stdout 首行契约、超时 kill）。
// 不复制第二份，避免两条实现漂移。
import { runPowerShell, type PsOutcome } from './keyring-win-dpapi';
import type { OsVerifyBackend, OsVerifyResult } from './view-gate';

/**
 * view-gate-win.ts — Windows OS 身份验证后端（规格 §3，G5）。
 *
 * 用 `CredUIPromptForWindowsCredentials` 让**系统**收集凭据：明文密码完全不进入本应用进程
 * （不做应用内输入框 + LogonUser 的形态，那会让明文经过渲染层与 IPC）。
 * packed 凭据在 PowerShell 子进程内解包，再经 `LogonUserW` 校验，
 * 最后用返回 token 的 **SID 与当前进程用户比对**（正确处理本地/域/Microsoft 账户）。
 *
 * 安全约束：
 * - 口令绝不进命令行、绝不进 stdout、绝不落文件；stdout 只有 `OK granted` / `ERR <code>`。
 * - 交互式对话框，预算默认 120s（`BFB_VIEWGATE_TIMEOUT_MS` 覆盖）；用户取消会立即返回。
 * - dev-only 钩子 `BFB_VIEWGATE_SKIP_PROMPT=1`：跳过对话框、凭据走 stdin。
 *   仅用于失败路径与 SID 路径的自动化验证；**不降低安全性**（仍必须通过 LogonUser 校验）。
 */

const WIN32_ERROR_CANCELLED = 1223;
const LOGON32_LOGON_NETWORK = 3;
const LOGON32_PROVIDER_DEFAULT = 0;
/** CRED_PACK_PROTECTED_CREDENTIALS：in-buffer 用调用方登录会话加密（Chromium 同款）。 */
const CRED_PACK_PROTECTED_CREDENTIALS = 0x1;
/**
 * CREDUIWIN_ENUMERATE_CURRENT_USER | CREDUIWIN_SECURE_PROMPT。
 *
 * 刻意**不用** `CREDUIWIN_GENERIC`：generic 形态只给一个空的用户名/密码框，
 * 用户名要用户自己敲（实测 2026-09-22，用户反馈"用户名就是当前登录用户，为什么还要输"）。
 * 走 logon 形态 + 把当前用户名打包进 in-auth-buffer，对话框才会预填用户名——这也是
 * Chromium 的做法。见下方 `CredPackAuthenticationBufferW` 的用法。
 */
const CREDUI_FLAGS = 0x200 | 0x1000;

const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

/**
 * CredUI 对话框正文。
 *
 * **绝不放进脚本字符串**：脚本经 `powershell.exe -Command <script>` 传入，而 Windows
 * PowerShell 5.1 按控制台 ANSI 代码页解码命令行与 .ps1 文件（无 BOM 时），非 ASCII 会被
 * 错误解码并吃掉引号 → 整段脚本语法错误。2026-09-22 本机实跑即撞上此坑。
 * 因此：脚本保持纯 ASCII，文案与凭据一律走 stdin（base64 + UTF-8）。
 */
export const VIEW_PROMPT_TEXT = '验证 Windows 账户身份后才能查看密码明文';

/**
 * 属主窗口句柄提供者（组合根在 `src/main/index.ts` 注入）。
 *
 * 为什么必须有属主：CredUI 对话框是 **powershell.exe 子进程**创建的顶层窗口，而该进程
 * 既不是前台进程、也没有窗口。没有属主时它与浏览器窗口之间没有任何 Z 序关系，
 * 系统"显示但不激活"它 → 用户看到的是被压在浏览器窗口后面（或只有任务栏闪一下），
 * 也就是 2026-11-08 反馈的"验证窗没有置顶到前台"。传属主窗口是 Chromium/Edge 的同款做法：
 * 属主窗口的子窗口恒在其属主之上。
 *
 * 刻意**不** import './window'：window.ts 顶层 `import { app, BrowserWindow } from 'electron'`，
 * 会让本模块的单测（无 Electron 进程）在导入期就炸掉。注入式依赖也让它可被单测替换。
 */
let _ownerHwndProvider: () => string | null = () => null;

export function setViewGateOwnerWindow(provider: () => string | null): void {
  _ownerHwndProvider = provider;
}

/** 十进制字符串形式的 HWND；取不到就返回 null（对话框退回无属主，行为与改动前一致）。 */
function ownerHwnd(): string | null {
  try {
    const value = _ownerHwndProvider();
    return value && value !== '0' ? value : null;
  } catch {
    return null;
  }
}

function verifyBudgetMs(): number {
  const raw = Number(process.env.BFB_VIEWGATE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VERIFY_TIMEOUT_MS;
}

/** 机器码清洗：stdout 只允许 ASCII，落到渲染层的 reason 也必须是 ASCII。 */
function asciiCode(raw: string): string {
  const stripped = raw.replace(/[^\x20-\x7E]/g, '').trim();
  return stripped.slice(0, 120) || 'unknown';
}

const PS_VERIFY = [
  "$ErrorActionPreference = 'Stop'",
  // 进度记录会被 powershell.exe 序列化成 CLIXML 混进输出流，直接关掉。
  "$ProgressPreference = 'SilentlyContinue'",
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  '',
  'public class BaoCredUi {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct CREDUI_INFOW {',
  '    public int cbSize;',
  '    public IntPtr hwndParent;',
  '    public string pszMessageText;',
  '    public string pszCaptionText;',
  '    public IntPtr hbmBanner;',
  '  }',
  '',
  '  [DllImport("credui.dll", CharSet = CharSet.Unicode)]',
  '  public static extern int CredUIPromptForWindowsCredentialsW(',
  '    ref CREDUI_INFOW pUiInfo, int dwAuthError, ref uint pulAuthPackage,',
  '    IntPtr pvInAuthBuffer, uint ulInAuthBufferSize, out IntPtr ppvOutAuthBuffer,',
  '    out uint pulOutAuthBufferSize, ref bool pfSave, int dwFlags);',
  '',
  '  [DllImport("credui.dll", CharSet = CharSet.Unicode)]',
  '  public static extern bool CredUnPackAuthenticationBufferW(',
  '    int dwFlags, IntPtr pAuthBuffer, uint cbAuthBuffer,',
  '    StringBuilder pszUserName, ref uint pcchMaxUserName,',
  '    StringBuilder pszDomainName, ref uint pcchMaxDomainName,',
  '    StringBuilder pszPassword, ref uint pcchMaxPassword);',
  '',
  '  [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern bool CredPackAuthenticationBufferW(',
  '    int dwFlags, string pszUserName, string pszPassword,',
  '    IntPtr pPackedCredentials, ref uint pcbPackedCredentials);',
  '',
  // CoTaskMemFree 在 ole32.dll（credui.dll 不导出它）。写在 credui.dll 上会在
  // 对话框刚成功、准备释放 out-buffer 时抛 EntryPointNotFoundException——
  // 表现为"输入密码后直接报错"，且异常文案是中文 → 再叠加下游的乱码。
  '  [DllImport("ole32.dll")]',
  '  public static extern void CoTaskMemFree(IntPtr pv);',
  '',
  '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern bool LogonUserW(',
  '    string lpszUsername, string lpszDomain, string lpszPassword,',
  '    int dwLogonType, int dwLogonProvider, out IntPtr phToken);',
  '',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  public static extern bool CloseHandle(IntPtr hObject);',
  '}',
  "'@",
  '',
  '$script:tokenHandle = [IntPtr]::Zero',
  '$script:ownToken = $false',
  '',
  'function Fail([string]$code) {',
  '  Write-Output ("ERR " + $code)',
  '  if ($script:ownToken -and $script:tokenHandle.ToInt64() -ne 0) {',
  '    [BaoCredUi]::CloseHandle($script:tokenHandle) | Out-Null',
  '  }',
  '  exit 1',
  '}',
  '',
  'try {',
  '  $line = [Console]::In.ReadLine()',
  '  $parts = @()',
  '  if (-not [string]::IsNullOrEmpty($line)) {',
  '    $plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))',
  "    $parts = $plain -split '\\n'",
  '  }',
  "  $user = ''",
  "  $domain = ''",
  "  $pass = ''",
  "  $msg = 'Verify your Windows account to view the saved password'",
  '',
  "  if ($env:BFB_VIEWGATE_SKIP_PROMPT -eq '1') {",
  '    if ($parts.Length -ge 1) { $user = $parts[0] }',
  '    if ($parts.Length -ge 2) { $pass = $parts[1] }',
  '    if ($parts.Length -ge 3) { $domain = $parts[2] }',
  '    if ([string]::IsNullOrEmpty($user)) {',
  '      # Self-check: use the current process token; same SID comparison path.',
  '      # Hold the WindowsIdentity in a script-scoped variable: it OWNS the token handle',
  '      # and closes it when finalized. Reading .Token off a temporary leaves a dangling',
  '      # handle, and constructing WindowsIdentity from it then throws',
  '      # "invalid impersonation token".',
  '      # Measured 2026-09-22: the temporary form passes under -File but fails under',
  '      # -Command; forcing a GC makes even -File fail -> it is a lifetime bug, not a',
  '      # delivery-mode bug. Never go back to the one-liner.',
  '      $script:ownIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()',
  '      $script:tokenHandle = $script:ownIdentity.Token',
  '    }',
  '  } else {',
  '    if ($parts.Length -ge 1 -and -not [string]::IsNullOrEmpty($parts[0])) { $msg = $parts[0] }',
  '    # Owner window (decimal HWND, 2nd stdin line): the dialog is created by this child process,',
  '    # which has no window of its own, so without an owner it can end up behind the browser.',
  '    $owner = [IntPtr]::Zero',
  '    if ($parts.Length -ge 2 -and -not [string]::IsNullOrEmpty($parts[1])) {',
  '      $owner = [IntPtr]([int64]$parts[1])',
  '    }',
  '    $info = New-Object BaoCredUi+CREDUI_INFOW',
  '    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][BaoCredUi+CREDUI_INFOW])',
  '    $info.hwndParent = $owner',
  "    $info.pszCaptionText = 'BaoFlashBrowser'",
  '    $info.pszMessageText = $msg',
  '    $info.hbmBanner = [IntPtr]::Zero',
  '',
  '    $authPackage = 0',
  '    $save = $false',
  '    $outBuf = [IntPtr]::Zero',
  '    $outSize = 0',
  '',
  '    # Pre-fill the user name: pack the CURRENT user with an empty password and hand it to',
  '    # CredUI as the in-auth-buffer. Without this the dialog opens with a blank user name',
  '    # and asks the user to retype who they already are. (Chromium does the same.)',
  '    $curUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name',
  '    $inSize = 0',
  '    $inBuf = [IntPtr]::Zero',
  '    $haveInBuf = $false',
  `    $null = [BaoCredUi]::CredPackAuthenticationBufferW(${CRED_PACK_PROTECTED_CREDENTIALS}, $curUser, '', [IntPtr]::Zero, [ref]$inSize)`,
  '    if ($inSize -gt 0) {',
  '      $inBuf = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$inSize)',
  `      $haveInBuf = [BaoCredUi]::CredPackAuthenticationBufferW(${CRED_PACK_PROTECTED_CREDENTIALS}, $curUser, '', $inBuf, [ref]$inSize)`,
  '      if (-not $haveInBuf) {',
  '        [Runtime.InteropServices.Marshal]::FreeHGlobal($inBuf)',
  '        $inBuf = [IntPtr]::Zero',
  '        $inSize = 0',
  '      }',
  '    }',
  '    if ($env:BFB_VIEWGATE_DUMP_INBUF -eq \'1\') {',
  '      # dev-only: report that the pre-fill buffer was built, without opening a dialog.',
  '      # Deliberately NOT an "OK ..." line: stdout must stay exactly two shapes',
  '      # (OK granted / ERR <code>) so nothing diagnostic can ever look like a verdict.',
  '      # (The classifier only accepts "granted" anyway, so it always fails closed.)',
  '      if ($haveInBuf) { [Runtime.InteropServices.Marshal]::FreeHGlobal($inBuf) }',
  '      Write-Output ("DIAG inbuf size=" + $inSize + " user=" + $curUser)',
  '      exit 0',
  '    }',
  '',
  '    $rc = [BaoCredUi]::CredUIPromptForWindowsCredentialsW(',
  '      [ref]$info, 0, [ref]$authPackage, $inBuf, $inSize,',
  '      [ref]$outBuf, [ref]$outSize, [ref]$save, ' + CREDUI_FLAGS + ')',
  '    if ($haveInBuf) { [Runtime.InteropServices.Marshal]::FreeHGlobal($inBuf) }',
  '    if ($rc -ne 0 -and $rc -ne ' + WIN32_ERROR_CANCELLED + ' -and $haveInBuf) {',
  '      # The pre-fill buffer was rejected (e.g. by policy). Retry with an empty in-buffer:',
  '      # the user then has to type the name, but must never be blocked from viewing.',
  "      [Console]::Error.WriteLine('viewgate: prefill rejected rc=' + $rc + ', retrying without it')",
  '      $authPackage = 0',
  '      $rc = [BaoCredUi]::CredUIPromptForWindowsCredentialsW(',
  '        [ref]$info, 0, [ref]$authPackage, [IntPtr]::Zero, 0,',
  '        [ref]$outBuf, [ref]$outSize, [ref]$save, ' + CREDUI_FLAGS + ')',
  '    }',
  `    if ($rc -eq ${WIN32_ERROR_CANCELLED}) { Fail 'cancelled' }`,
  "    if ($rc -ne 0) { Fail ('prompt-failed:' + $rc) }",
  '',
  '    $u = New-Object Text.StringBuilder 514',
  '    $d = New-Object Text.StringBuilder 514',
  '    $p = New-Object Text.StringBuilder 514',
  '    $uLen = 514',
  '    $dLen = 514',
  '    $pLen = 514',
  '    $unpacked = [BaoCredUi]::CredUnPackAuthenticationBufferW(',
  '      0, $outBuf, $outSize, $u, [ref]$uLen, $d, [ref]$dLen, $p, [ref]$pLen)',
  '    [BaoCredUi]::CoTaskMemFree($outBuf) | Out-Null',
  "    if (-not $unpacked) { Fail 'unpack-failed' }",
  '    $user = $u.ToString()',
  '    $domain = $d.ToString()',
  '    $pass = $p.ToString()',
  '  }',
  '',
  '  if ($script:tokenHandle.ToInt64() -eq 0) {',
  "    if ([string]::IsNullOrEmpty($user)) { Fail 'no-credential' }",
  '    # CredUnPackAuthenticationBufferW returns a fully qualified name with an empty domain',
  '    # (measured 2026-09-22: user="BATEST\\95470", domain=""), while LogonUserW wants the',
  '    # account name plus the domain in its own parameter. Split explicitly.',
  "    if ($user.Contains('\\')) {",
  "      $sep = $user.LastIndexOf('\\')",
  '      if ([string]::IsNullOrEmpty($domain)) { $domain = $user.Substring(0, $sep) }',
  '      $user = $user.Substring($sep + 1)',
  '    }',
  '    if ($domain -eq \'.\') { $domain = $env:COMPUTERNAME }',
  '    $logonDomain = $domain',
  '    # LogonUserW wants NULL (not an empty string) for a UPN-style name; PowerShell coerces',
  '    # $null to "" when binding to a [string] parameter, so a real null needs NullString.',
  "    if ([string]::IsNullOrEmpty($logonDomain) -and $user.Contains('@')) { $logonDomain = [NullString]::Value }",
  `    $ok = [BaoCredUi]::LogonUserW($user, $logonDomain, $pass, ${LOGON32_LOGON_NETWORK}, ${LOGON32_PROVIDER_DEFAULT}, [ref]$script:tokenHandle)`,
  '    if (-not $ok) {',
  '      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()',
  "      if ($code -eq 1326) { Fail 'bad-credential' }",
  "      if ($code -eq 1909) { Fail 'account-locked' }",
  "      if ($code -eq 1327) { Fail 'unusable-account:1327' }",
  "      if ($code -eq 1330) { Fail 'unusable-account:1330' }",
  "      if ($code -eq 1331) { Fail 'unusable-account:1331' }",
  "      if ($code -eq 1385) { Fail 'denied:1385' }",
  "      Fail ('logon-failed:' + $code)",
  '    }',
  '    $script:ownToken = $true',
  '  }',
  '',
  '  $tokenSid = (New-Object Security.Principal.WindowsIdentity -ArgumentList @($script:tokenHandle)).User.Value',
  '  $selfSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  "  if ($tokenSid -ne $selfSid) { Fail 'not-current-user' }",
  '',
  '  if ($script:ownToken) { [BaoCredUi]::CloseHandle($script:tokenHandle) | Out-Null }',
  '  Write-Output \'OK granted\'',
  '}',
  'catch {',
  // stdout 只允许 ASCII：Windows PowerShell 5.1 的控制台编码不是 UTF-8，异常文案（中文）
  // 经 stdout 回传必然乱码。细节走 stderr（只进日志），stdout 只给稳定机器码。
  "  [Console]::Error.WriteLine('viewgate: ' + $_.Exception.GetType().Name)",
  "  Fail 'exception'",
  '}',
].join('\n');

/**
 * Windows Hello（`UserConsentVerifier`）——Edge 同款的"验证你的身份"PIN/指纹对话框。
 *
 * 与 CredUI 的区别：Hello 只回答"当前登录用户是否已确认"，不回传口令，因此没有
 * LogonUser + SID 比对那一步（也不需要）；这正是浏览器查看已保存密码时的系统形态。
 *
 * WinRT 异步在 PowerShell 5.1 里必须自己接：`AsTask` 的泛型参数取不到（枚举类型无法用
 * `[Type,Assembly,ContentType=WindowsRuntime]` 解析），所以从方法签名的返回类型反射拿。
 */
const PS_HELLO = [
  "$ErrorActionPreference = 'Stop'",
  // 进度记录会被 powershell.exe 序列化成 CLIXML 混进输出流，直接关掉。
  "$ProgressPreference = 'SilentlyContinue'",
  '',
  'function Fail([string]$code) {',
  '  Write-Output ("ERR " + $code)',
  '  exit 1',
  '}',
  '',
  'try {',
  '  $line = [Console]::In.ReadLine()',
  "  $msg = 'Verify your identity to view the saved password'",
  '  if (-not [string]::IsNullOrEmpty($line)) {',
  '    $msg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))',
  '  }',
  '',
  '  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
  '  $verifier = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]',
  '  $mi = $verifier.GetMethods() | Where-Object { $_.Name -eq "RequestVerificationAsync" } | Select-Object -First 1',
  '  $enumType = $mi.ReturnType.GenericTypeArguments[0]',
  // PowerShell 里反引号在双引号内是转义符，`"IAsyncOperation`1"` 会被吃成 IAsyncOperation1，
  // 所以这里的类型名必须用单引号字面量。
  '  $asTaskM = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq \'IAsyncOperation`1\' })[0]',
  '',
  '  $op = $verifier::RequestVerificationAsync($msg)',
  '  $task = $asTaskM.MakeGenericMethod($enumType).Invoke($null, @($op))',
  '  $task.Wait(-1) | Out-Null',
  // UserConsentVerificationResult: 0 Verified / 5 RetriesExhausted / 6 Canceled / 其他 = 后端不可用
  '  $code = [int]$task.Result',
  '  if ($code -eq 0) { Write-Output \'OK granted\'; exit 0 }',
  "  if ($code -eq 6) { Fail 'cancelled' }",
  "  if ($code -eq 5) { Fail 'denied:retries-exhausted' }",
  "  Fail ('hello-unavailable:' + $code)",
  '}',
  'catch {',
  "  [Console]::Error.WriteLine('viewgate-hello: ' + $_.Exception.GetType().Name)",
  "  Fail 'hello-unavailable:exception'",
  '}',
].join('\n');

/**
 * 系统凭据窗口的窗口类名（Windows Hello 与 CredUI 共用同一个 XAML 宿主窗口）。
 * 2026-11-08 本机实测：`EnumWindows` 找到的弹窗是 `Credential Dialog Xaml Host` +
 * 标题「Windows 安全中心」，且**属于另一个进程**（系统凭据宿主，pid 与我们的 PowerShell
 * 子进程不同）、`GetForegroundWindow()` 不是它、ex-style 无 `WS_EX_APPWINDOW`。
 */
const SYSTEM_PROMPT_WINDOW_CLASS = 'Credential Dialog Xaml Host';
const RAISE_PROMPT_BUDGET_MS = 10_000;

/**
 * 把系统凭据窗口拎到前台（用户反馈 2026-11-08：弹窗被浏览器完全挡住、任务栏还没图标，
 * 必须手动点一下才能输入 PIN）。
 *
 * 根因：那个窗口是**系统凭据宿主进程**创建的，属主与激活都由宿主决定。宿主是后台进程，
 * 撞上 Windows 前台锁定规则（`SetForegroundWindow` 只对"前台进程 / 由前台进程启动 /
 * 收到最后一次输入"的进程放行）→ 系统"只显示不激活"。它又是个无属主、也没有
 * `WS_EX_TOOLWINDOW` 的顶层窗口，所以 shell 照常给它一个任务栏按钮；而宿主进程没有图标
 * 资源，那个按钮就是空白的（2026-11-08 实测：owner=0，ex-style=0x200100）。
 *
 * 窗口本身我们改不了（不属于本进程）：实测 `SetWindowLong(GWL_EXSTYLE, WS_EX_TOOLWINDOW)`
 * 返回 `ERROR_ACCESS_DENIED` —— 宿主是高完整性进程，UIPI 拦掉了跨进程改样式。能用的只有
 * shell 层的 `ITaskbarList::DeleteTab(hwnd)`：它只是请求 explorer 撤掉按钮，不写目标窗口。
 * 2026-11-08 用 UIA 实测同一窗口：`AddTab` 让任务栏多出一个无图标的 `…\CredentialUIBroker.exe`
 * 按钮（这正是用户看到的那个空白按钮），`DeleteTab` 又让它消失。
 *
 * 而**发起方可以抢**：本脚本由主进程直接 spawn，满足"由前台进程启动"这条豁免，
 * 因此可以合法地 `SetForegroundWindow`；同时用 `SetWindowPos(HWND_TOP)` 兜底 Z 序——
 * 即使激活仍被拒，也保证它压在浏览器窗口之上、用户能看见。
 *
 * 注意：拿不到窗口类（未实测过的 Windows 版本）时它只是空转到超时，不影响验证本身，
 * 也就是退化成改动前的行为。
 */
const PS_RAISE = [
  "$ErrorActionPreference = 'Stop'",
  // 进度记录会被 powershell.exe 序列化成 CLIXML 混进输出流，直接关掉。
  "$ProgressPreference = 'SilentlyContinue'",
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  '',
  // ITaskbarList：shell 层的"从任务栏撤掉某个窗口的按钮"接口。它只向 explorer 提请求，
  // 不写目标窗口，因此不受 UIPI 限制（改样式那条路实测 ERROR_ACCESS_DENIED）。
  '[ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  'public interface IBaoTaskbarList {',
  '  [PreserveSig] int HrInit();',
  '  [PreserveSig] int AddTab(IntPtr hwnd);',
  '  [PreserveSig] int DeleteTab(IntPtr hwnd);',
  '  [PreserveSig] int ActivateTab(IntPtr hwnd);',
  '  [PreserveSig] int SetActiveAlt(IntPtr hwnd);',
  '}',
  '',
  'public class BaoRaise {',
  '  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
  '',
  '  [DllImport("user32.dll")]',
  '  public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool IsWindowVisible(IntPtr hWnd);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)]',
  '  public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);',
  '  [DllImport("user32.dll")]',
  '  public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")]',
  '  public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool BringWindowToTop(IntPtr hWnd);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool SetWindowPos(',
  '    IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool AllowSetForegroundWindow(int dwProcessId);',
  '',
  '  public static IntPtr Find(string cls) {',
  '    IntPtr found = IntPtr.Zero;',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      if (!IsWindowVisible(h)) return true;',
  '      StringBuilder sb = new StringBuilder(256);',
  '      GetClassNameW(h, sb, 256);',
  '      if (string.Equals(sb.ToString(), cls, StringComparison.Ordinal)) { found = h; return false; }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return found;',
  '  }',
  '',
  '  public static void DeleteTab(IntPtr hwnd) {',
  '    try {',
  '      var t = (IBaoTaskbarList)Activator.CreateInstance(',
  '        Type.GetTypeFromCLSID(new Guid("56FDF344-FD6D-11d0-958A-006097C9A090")));',
  '      t.HrInit();',
  '      t.DeleteTab(hwnd);',
  '      Marshal.ReleaseComObject(t);',
  '    } catch { }',
  '  }',
  '}',
  "'@",
  '',
  `$cls = '${SYSTEM_PROMPT_WINDOW_CLASS}'`,
  '$budget = ' + String(RAISE_PROMPT_BUDGET_MS),
  '$deadline = [DateTime]::UtcNow.AddMilliseconds($budget)',
  '$found = $false',
  // 连续几轮确认前台才收工：任务栏按钮是 explorer 异步补的，抢一次就退会漏掉它。
  '$raised = 0',
  'while ([DateTime]::UtcNow -lt $deadline) {',
  '  $h = [BaoRaise]::Find($cls)',
  '  if ($h -ne [IntPtr]::Zero) {',
  '    $found = $true',
  '    [BaoRaise]::AllowSetForegroundWindow(-1) | Out-Null',
  '    [BaoRaise]::ShowWindow($h, 5) | Out-Null',
  // HWND_TOP(0) | SWP_NOSIZE(0x1) | SWP_NOMOVE(0x2) | SWP_SHOWWINDOW(0x40)
  '    [BaoRaise]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x43) | Out-Null',
  '    [BaoRaise]::BringWindowToTop($h) | Out-Null',
  '    [BaoRaise]::SetForegroundWindow($h) | Out-Null',
  // 必须在 ShowWindow/激活之后：这两步都会让 explorer 把按钮补回来。
  '    [BaoRaise]::DeleteTab($h)',
  '    if ([BaoRaise]::GetForegroundWindow() -eq $h) {',
  '      $raised++',
  "      if ($raised -ge 4) { Write-Output 'OK raised'; exit 0 }",
  '    } else {',
  '      $raised = 0',
  '    }',
  '  }',
  '  Start-Sleep -Milliseconds 150',
  '}',
  // 找到过窗口但始终没拿到前台：Z 序仍按上面抬高过，退化为"至少看得见"。
  "if ($found) { Write-Output 'OK zorder-only'; exit 0 }",
  "Write-Output 'ERR not-found'",
  'exit 2',
].join('\n');

/** 生产用：拉起看门脚本抢前台。故意不 await——它与验证对话框并行，失败也不影响验证。 */
export function raiseSystemPrompt(): void {
  void runPowerShell(PS_RAISE, '', RAISE_PROMPT_BUDGET_MS + 5_000)
    .then((outcome) => {
      if (outcome.code === 'ok') {
        log.info(`[view-gate] system prompt ${outcome.value}`);
        return;
      }
      log.warn(`[view-gate] system prompt raise failed: ${outcome.code}`);
    });
}

/** 脚本侧机器码 → 语义分类（纯函数，可单测）。 */
export function classifyVerifyOutcome(outcome: PsOutcome): OsVerifyResult {
  if (outcome.code === 'ok') {
    if (outcome.value.trim() !== 'granted') {
      return { ok: false, kind: 'unavailable', reason: 'unexpected-payload' };
    }
    return { ok: true };
  }
  switch (outcome.code) {
    case 'spawn-error':
      return { ok: false, kind: 'unavailable', reason: 'no-powershell' };
    case 'timeout':
      return { ok: false, kind: 'unavailable', reason: 'timeout' };
    case 'bad-response':
      return { ok: false, kind: 'unavailable', reason: 'bad-response' };
    case 'exit-error': {
      const code = outcome.message.trim();
      if (code === 'cancelled') return { ok: false, kind: 'cancelled' };
      if (code === 'bad-credential') return { ok: false, kind: 'bad-credential' };
      if (code === 'not-current-user') return { ok: false, kind: 'not-current-user' };
      if (code === 'account-locked') return { ok: false, kind: 'account-locked' };
      if (code.startsWith('unusable-account')) return { ok: false, kind: 'unusable-account', reason: code };
      if (code.startsWith('denied')) return { ok: false, kind: 'denied', reason: code };
      // `exception:<message>` 曾把 PowerShell 的中文异常文案透传到渲染层 → 乱码。
      // 现在只回一个稳定的 ASCII 码；细节在 stderr/日志里。
      if (code.startsWith('exception')) return { ok: false, kind: 'unavailable', reason: 'exception' };
      return { ok: false, kind: 'unavailable', reason: asciiCode(code) };
    }
  }
}

export class WinCredUiBackend implements OsVerifyBackend {
  readonly id = 'win-credui' as const;

  constructor(
    private readonly exec: (payloadB64: string, timeoutMs: number) => Promise<PsOutcome> =
      (payloadB64, timeoutMs) => runPowerShell(PS_VERIFY, payloadB64, timeoutMs),
    // 默认 no-op：单测构造后端时不该真的去 spawn 进程。生产由 createWin*Backend 注入。
    private readonly raisePrompt: () => void = () => {},
  ) {}

  async available(): Promise<boolean> {
    return process.platform === 'win32';
  }

  /** 弹系统对话框验证当前用户身份。 */
  async verify(): Promise<OsVerifyResult> {
    // 对话框由系统宿主进程渲染，抢前台要由我们主动发起（见 PS_RAISE）。
    // 尽力而为：抢不到也必须继续弹对话框，绝不能把验证本身卡死。
    try { this.raisePrompt(); } catch { /* ignore */ }
    // 提示文案经 stdin（UTF-8/base64）传入：Windows PowerShell 5.1 按 ANSI 解码 `-Command`
    // 里的非 ASCII，中文会直接破坏脚本语法（2026-09-22 本机实跑发现）。脚本本体保持纯 ASCII。
    // 第 2 行（可选）= 属主窗口 HWND，缺省时对话框退回无属主。
    const lines = [VIEW_PROMPT_TEXT];
    const owner = ownerHwnd();
    if (owner) lines.push(owner);
    const payloadB64 = Buffer.from(lines.join('\n'), 'utf8').toString('base64');
    const outcome = await this.exec(payloadB64, verifyBudgetMs());
    const result = classifyVerifyOutcome(outcome);
    if (!result.ok) {
      log.warn(`[view-gate] win verify kind=${result.kind}${result.reason ? ` reason=${result.reason}` : ''}`);
    }
    return result;
  }

  /**
   * dev-only：跳过对话框，用给定凭据走同一条 LogonUser + SID 路径。
   * 需调用方先置 `BFB_VIEWGATE_SKIP_PROMPT=1`（脚本侧读环境变量）。
   */
  async verifyWithCredentials(user: string, pass: string, domain = ''): Promise<OsVerifyResult> {
    if (process.env.BFB_VIEWGATE_SKIP_PROMPT !== '1') {
      throw new Error('BFB_VIEWGATE_SKIP_PROMPT must be set for verifyWithCredentials');
    }
    const payloadB64 = Buffer.from(`${user}\n${pass}\n${domain}`, 'utf8').toString('base64');
    return classifyVerifyOutcome(await this.exec(payloadB64, verifyBudgetMs()));
  }
}

/** 供 view-gate.ts 按平台构造（也可被测试直接构造）。 */
export function createWinCredUiBackend(): WinCredUiBackend {
  return new WinCredUiBackend(undefined, raiseSystemPrompt);
}

/** Windows Hello 后端（Edge 同款的 PIN/指纹对话框）。 */
export class WinHelloBackend implements OsVerifyBackend {
  readonly id = 'win-hello' as const;

  constructor(
    private readonly exec: (payloadB64: string, timeoutMs: number) => Promise<PsOutcome> =
      (payloadB64, timeoutMs) => runPowerShell(PS_HELLO, payloadB64, timeoutMs),
    // 默认 no-op：单测构造后端时不该真的去 spawn 进程。生产由 createWin*Backend 注入。
    private readonly raisePrompt: () => void = () => {},
  ) {}

  async available(): Promise<boolean> {
    return process.platform === 'win32';
  }

  async verify(): Promise<OsVerifyResult> {
    // Hello 弹窗同样由系统凭据宿主渲染（实测窗口类 Credential Dialog Xaml Host），
    // 不抢就压在浏览器窗口后面（2026-11-08 反馈）。看门脚本与下面的调用并行，不阻塞。
    try { this.raisePrompt(); } catch { /* 尽力而为，绝不影响验证 */ }
    const payloadB64 = Buffer.from(VIEW_PROMPT_TEXT, 'utf8').toString('base64');
    const result = classifyVerifyOutcome(await this.exec(payloadB64, verifyBudgetMs()));
    if (!result.ok) {
      log.warn(`[view-gate] hello verify kind=${result.kind}${result.reason ? ` reason=${result.reason}` : ''}`);
    }
    return result;
  }
}

export function createWinHelloBackend(): WinHelloBackend {
  return new WinHelloBackend(undefined, raiseSystemPrompt);
}

/**
 * Windows 查看门禁：**Hello 优先，CredUI 兜底**。
 *
 * 顺序的理由：Hello 是系统里"礼貌"的那个（PIN/指纹，不要求敲账户口令）；只有当 Hello
 * 在本机不可用（未配置/被策略禁用/设备不支持）时才退到 CredUI 的凭据对话框。
 *
 * 回退条件刻意收窄到 `hello-unavailable:*`：用户取消、重试耗尽、以及验证通过都必须直接采用，
 * 否则同一次查看会连弹两个系统对话框（2026-11-08 实测形态）。
 */
export class WinViewVerifyBackend implements OsVerifyBackend {
  readonly id = 'win-os' as const;

  constructor(
    private readonly hello: OsVerifyBackend = createWinHelloBackend(),
    private readonly credUi: OsVerifyBackend = createWinCredUiBackend(),
  ) {}

  async available(): Promise<boolean> {
    return process.platform === 'win32';
  }

  async verify(): Promise<OsVerifyResult> {
    const hello = await this.hello.verify();
    if (!hello.ok && hello.kind === 'unavailable' && (hello.reason ?? '').startsWith('hello-unavailable')) {
      log.info(`[view-gate] Windows Hello unavailable (${hello.reason}); falling back to CredUI`);
      return this.credUi.verify();
    }
    return hello;
  }
}

/** 生产用：Windows 上走 Hello 优先 + CredUI 兜底。 */
export function createWinViewVerifyBackend(): WinViewVerifyBackend {
  return new WinViewVerifyBackend();
}

/** 导出脚本本体供本机验证用（不参与生产逻辑）。 */
export const _psVerifyScript = PS_VERIFY;
export const _psHelloScript = PS_HELLO;
export const _psRaiseScript = PS_RAISE;

/** 导出脚本里插值的常量，供单测把"对话框形态"与"in-buffer 打包方式"钉死。 */
export const _psVerifyFacts = {
  credUiFlags: CREDUI_FLAGS,
  credPackProtected: CRED_PACK_PROTECTED_CREDENTIALS,
  systemPromptWindowClass: SYSTEM_PROMPT_WINDOW_CLASS,
};
