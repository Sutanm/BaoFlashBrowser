export interface AppUpdateResult {
  status: 'available' | 'current' | 'error';
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
}
