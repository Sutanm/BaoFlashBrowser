export interface PasswordEntry {
  id: string;
  host: string;
  origin: string;
  title: string;
  username: string;
  updatedAt: number;
}

export type PasswordTier = 'A' | 'C' | 'none';

export type ViewGuardMode = 'os-win' | 'os-mac' | 'keyring' | 'none';

export interface ViewGuardStatus {
  /** 查看明文密码的门禁形态（Task 5/6 由 view-gate 模块填充真实值）。 */
  mode: ViewGuardMode;
  /** C′ 可选兜底查看密码是否已启用。 */
  fallbackEnabled: boolean;
  /** 诊断原因（如无 OS 密钥库）。 */
  reason?: string;
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
  viewGuard: ViewGuardStatus;
  excludedSites: string[];
}

/** password:reveal 结果（Task 5 起按 view-gate 授权）。 */
export interface RevealPasswordResult {
  password?: string;
  error?: 'not-authorized' | 'missing';
}

/** Sent from main → renderer via password:captured. Does NOT contain password. */
export interface CaptureNotification {
  captureId: string;
  host: string;
  username: string;
}

export type ActivePanel = 'favorites' | 'history' | 'downloads' | 'automation' | 'passwords' | 'userscripts' | 'settings' | null;
