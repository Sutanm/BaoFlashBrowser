export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'paused';
export type DownloadEngine = 'chromium' | 'aria2';

export interface DownloadItem {
  id: string;
  url: string;
  filename: string;
  state: DownloadState;
  progress: number;
  speed: number;
  receivedBytes: number;
  totalBytes: number;
  savePath: string;
  engine?: DownloadEngine;
}
