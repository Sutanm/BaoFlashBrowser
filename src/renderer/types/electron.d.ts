interface ElectronAPI {
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  webviewPreloadPath: string;
  win: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    unmaximize(): Promise<void>;
    close(): Promise<void>;
    setFullscreen(fullscreen: boolean): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
