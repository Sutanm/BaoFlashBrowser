interface TabAPI {
  create(tabId: string, url: string): Promise<void>;
  close(tabId: string): Promise<void>;
  activate(tabId: string): Promise<void>;
  navigate(tabId: string, url: string): Promise<void>;
  goBack(tabId: string): Promise<void>;
  goForward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  stop(tabId: string): Promise<void>;
  zoom(tabId: string, factor: number): Promise<void>;
  mute(tabId: string, muted: boolean): Promise<void>;
  devtools(tabId: string): Promise<void>;
  find(tabId: string, text: string, options?: any): Promise<void>;
  stopFind(tabId: string, action: string): Promise<void>;
  setBounds(x: number, y: number, w: number, h: number): Promise<void>;
}

interface ElectronAPI {
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  webviewPreloadPath: string;
  tab: TabAPI;
  win: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    unmaximize(): Promise<void>;
    close(): Promise<void>;
    setFullscreen(fullscreen: boolean): Promise<void>;
    toggleFullscreen(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
