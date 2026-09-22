export interface PasswordEntry {
  id: string;
  host: string;
  origin: string;
  title: string;
  username: string;
  updatedAt: number;
}

export type PasswordTier = 'A' | 'C' | 'none';

/** 密钥可用性（规格 D7）：ok=可用；loading=正在获取；retrying=瞬时失败自动重试中；blocked=需用户决策。 */
export type PasswordKeyStatus = 'ok' | 'loading' | 'retrying' | 'blocked';

export interface PasswordKeyIssue {
  kind: 'transient' | 'deterministic';
  /** 归一化机器码，如 'timeout' / 'decrypt-failed' / 'key-material-missing'。 */
  reason: string;
  backend?: string | null;
  attempts: number;
  nextRetryInMs?: number;
  hint?: 'wait' | 'rebuild' | 'no-backend';
}

export type ViewGuardMode = 'os-win' | 'os-mac' | 'keyring' | 'password' | 'none';

export interface ViewGuardStatus {
  /** 查看明文密码的门禁形态（规格 2026-09-22 §2）。'password' = 用户自定义查看密码。 */
  mode: ViewGuardMode;
  /** 查看密码是否已设置（仅 'password' 模式有意义）。 */
  passwordSet: boolean;
  /** 诊断原因（如 not-initialized / key-unavailable / tier-c / no-os-auth-backend）。 */
  reason?: string;
  /** 锁定期剩余毫秒；未锁定时为 undefined。 */
  lockedForMs?: number;
  /** 还剩几次尝试机会；锁定期间为 0。 */
  remainingAttempts?: number;
}

export interface PasswordStoreStatus {
  enabled: boolean;
  /** v2 vault 已建立。 */
  initialized: boolean;
  /** auto-fill 档位：A=OS 密钥库 / C=本地弱保护 / none=未启用或未初始化。 */
  tier: PasswordTier;
  autoCapture: boolean;
  autoFill: boolean;
  /** auto-fill 是否就绪（开关开 + vault 已建 + DEK 在内存）。 */
  autoFillReady: boolean;
  /** 密钥可用性：只有 'ok' 才代表 DEK 真的可用（规格 D7）。 */
  keyStatus: PasswordKeyStatus;
  keyIssue?: PasswordKeyIssue;
  viewGuard: ViewGuardStatus;
  excludedSites: string[];
}

/** password:retry-key 结果：强制失效探测缓存并重试一次，返回最新状态。 */
export interface KeyRetryResult {
  keyStatus: PasswordKeyStatus;
  keyIssue?: PasswordKeyIssue;
  ready: boolean;
}

/** password:rebuild-vault 结果（危险操作，需 confirm='REBUILD'）。 */
export interface RebuildVaultResult {
  success: boolean;
  tier: PasswordTier;
}

/** password:reveal 结果（门禁授权制，规格 2026-09-22 G11）。 */
export interface RevealPasswordResult {
  password?: string;
  error?: RevealErrorCode;
  /** 仅 wrong-credential：还剩几次机会。 */
  remainingAttempts?: number;
  /** 仅 locked：剩余毫秒。 */
  lockedForMs?: number;
  /** 当前门禁形态，省掉 UI 再查一次 status 的往返。 */
  mode?: ViewGuardMode;
  /** 机器码补充（如 bad-credential / not-current-user / timeout），供 UI 分类提示。 */
  reason?: string;
}

/**
 * 门禁校验结果码（view-gate 与 reveal 共用；放在 shared 以免 shared ← main 反向依赖）。
 * 语义与"是否计入失败"见规格 §9 的表。
 */
export type ViewAuthCode =
  /** 通过。 */
  | 'ok'
  /** 锁定期内（含口令正确也拒绝；不累加、不延长）。 */
  | 'locked'
  /** 尚未设置查看密码 → 引导设置。 */
  | 'needs-setup'
  /** 密码模式但本次没带口令。 */
  | 'needs-input'
  /** 口令/凭据错误（**计入失败**；触发锁定时附 lockedForMs）。 */
  | 'wrong-credential'
  /** 用户取消了系统验证对话框（不计入失败）。 */
  | 'cancelled'
  /** 验证通道不可用/超时，fail closed（不计入失败）。 */
  | 'unavailable'
  /** Windows 账户已被系统锁定（不计入失败）。 */
  | 'account-locked'
  /** OS 验证不可用，已降级为查看密码（不计入失败）。 */
  | 'degraded'
  /** 无门禁可用（未建库 / 密钥不可用）。 */
  | 'none';

/** reveal 的错误码：门禁码去掉 ok，加上 IPC 层自己的两种。 */
export type RevealErrorCode = Exclude<ViewAuthCode, 'ok'> | 'not-authorized' | 'missing';

/** password:set-view-password 结果（设置/修改查看密码）。 */
export interface SetViewPasswordResult {
  success: boolean;
  error?: 'weak-password' | 'current-required' | 'locked' | 'wrong-credential' | 'not-available';
  remainingAttempts?: number;
  lockedForMs?: number;
}

/** password:reset-os-auth 结果：清掉"OS 验证不可用"的降级标记后返回最新门禁状态。 */
export interface ResetOsAuthResult {
  viewGuard: ViewGuardStatus;
}

/** Sent from main → renderer via password:captured. Does NOT contain password. */
export interface CaptureNotification {
  captureId: string;
  host: string;
  username: string;
}

export type ActivePanel = 'favorites' | 'history' | 'downloads' | 'automation' | 'passwords' | 'userscripts' | 'settings' | null;
