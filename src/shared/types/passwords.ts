export interface PasswordEntry {
  id: string;
  host: string;
  origin: string;
  title: string;
  username: string;
  updatedAt: number;
}

export interface PasswordStoreStatus {
  initialized: boolean;
  unlocked: boolean;
  enabled: boolean;
  autoCapture: boolean;
  autoFill: boolean;
  autoFillReady: boolean;
  excludedSites: string[];
}

/** Sent from main → renderer via password:captured. Does NOT contain password. */
export interface CaptureNotification {
  captureId: string;
  host: string;
  username: string;
}

export type ActivePanel = 'favorites' | 'history' | 'downloads' | 'settings' | 'passwords' | null;
