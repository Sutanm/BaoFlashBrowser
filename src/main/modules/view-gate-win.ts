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
/** CREDUIWIN_GENERIC | CREDUIWIN_ENUMERATE_CURRENT_USER | CREDUIWIN_SECURE_PROMPT */
const CREDUI_FLAGS = 0x1 | 0x200 | 0x1000;

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

function verifyBudgetMs(): number {
  const raw = Number(process.env.BFB_VIEWGATE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VERIFY_TIMEOUT_MS;
}

const PS_VERIFY = [
  "$ErrorActionPreference = 'Stop'",
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
  '  [DllImport("credui.dll")]',
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
  '      $script:tokenHandle = [Security.Principal.WindowsIdentity]::GetCurrent().Token',
  '    }',
  '  } else {',
  '    if ($parts.Length -ge 1 -and -not [string]::IsNullOrEmpty($parts[0])) { $msg = $parts[0] }',
  '    $info = New-Object BaoCredUi+CREDUI_INFOW',
  '    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][BaoCredUi+CREDUI_INFOW])',
  '    $info.hwndParent = [IntPtr]::Zero',
  "    $info.pszCaptionText = 'BaoFlashBrowser'",
  '    $info.pszMessageText = $msg',
  '    $info.hbmBanner = [IntPtr]::Zero',
  '',
  '    $authPackage = 0',
  '    $save = $false',
  '    $outBuf = [IntPtr]::Zero',
  '    $outSize = 0',
  '    $rc = [BaoCredUi]::CredUIPromptForWindowsCredentialsW(',
  '      [ref]$info, 0, [ref]$authPackage, [IntPtr]::Zero, 0,',
  '      [ref]$outBuf, [ref]$outSize, [ref]$save, ' + CREDUI_FLAGS + ')',
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
  "  Fail ('exception:' + $_.Exception.Message)",
  '}',
].join('\n');

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
      return { ok: false, kind: 'unavailable', reason: code.slice(0, 120) || 'unknown' };
    }
  }
}

export class WinCredUiBackend implements OsVerifyBackend {
  readonly id = 'win-credui' as const;

  constructor(
    private readonly exec: (payloadB64: string, timeoutMs: number) => Promise<PsOutcome> =
      (payloadB64, timeoutMs) => runPowerShell(PS_VERIFY, payloadB64, timeoutMs),
  ) {}

  async available(): Promise<boolean> {
    return process.platform === 'win32';
  }

  /** 弹系统对话框验证当前用户身份。 */
  async verify(): Promise<OsVerifyResult> {
    // 提示文案经 stdin（UTF-8/base64）传入：Windows PowerShell 5.1 按 ANSI 解码 `-Command`
    // 里的非 ASCII，中文会直接破坏脚本语法（2026-09-22 本机实跑发现）。脚本本体保持纯 ASCII。
    const payloadB64 = Buffer.from(VIEW_PROMPT_TEXT, 'utf8').toString('base64');
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
  return new WinCredUiBackend();
}

/** 导出脚本本体供本机验证用（不参与生产逻辑）。 */
export const _psVerifyScript = PS_VERIFY;
