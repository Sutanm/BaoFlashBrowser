export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted';

export interface DownloadItem {
  id: string;
  url: string;
  filename: string;
  state: DownloadState;
  progress: number;
  speed: string;
  receivedBytes: number;
  totalBytes: number;
  mimeType: string;
  savePath: string;
  startTime: number;
}
