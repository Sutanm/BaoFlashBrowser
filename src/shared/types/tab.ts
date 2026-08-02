export interface Tab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  zoomFactor: number;
  isLoading: boolean;
  isAudible: boolean;
  isMuted: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  createdAt: number;
  ruffleMode: 'ppapi' | 'ruffle';
  suspended?: boolean;
}

export interface TabCreateOptions {
  url: string;
  active?: boolean;
}
