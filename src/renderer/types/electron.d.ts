import type {
  ShortcutAction, TabUpdatedPayload, DownloadProgressPayload, NewWindowPayload,
  TabFoundPayload, TabLoadErrorPayload, TabCrashedPayload,
  Aria2StatusPayload, PasswordCapturedPayload, PasswordChangedPayload,
} from '@shared/types/ipc';
import type { PasswordStoreStatus } from '@shared/types/passwords';
import type { DownloadEngine } from '@shared/types/settings';

interface MainConfig {
  flashVersion: string;
  lowEndMode: boolean;
  downloadEngine: DownloadEngine;
  downloadDir: string;
}

interface PasswordEntryMeta {
  id: string;
  host: string;
  origin: string;
  title: string;
  username: string;
  updatedAt: number;
}

interface PasswordSaveResult {
  success: boolean;
  error?: string;
  id?: string;
}

declare global {
  interface Window {
    electronAPI: {
      on(channel: 'shortcut', cb: (action: ShortcutAction) => void): () => void;
      on(channel: 'tab:updated', cb: (payload: TabUpdatedPayload) => void): () => void;
      on(channel: 'tab:found', cb: (payload: TabFoundPayload) => void): () => void;
      on(channel: 'tab:load-error', cb: (payload: TabLoadErrorPayload) => void): () => void;
      on(channel: 'tab:crashed', cb: (payload: TabCrashedPayload) => void): () => void;
      on(channel: 'tab:newwindow', cb: (payload: NewWindowPayload) => void): () => void;
      on(channel: 'download:progress', cb: (payload: DownloadProgressPayload) => void): () => void;
      on(channel: 'aria2:status', cb: (data: Aria2StatusPayload) => void): () => void;
      on(channel: 'navigate-url', cb: (url: string) => void): () => void;
      on(channel: 'password:captured', cb: (payload: PasswordCapturedPayload) => void): () => void;
      on(channel: 'password:changed', cb: (payload: PasswordChangedPayload) => void): () => void;
      on(channel: string, cb: (...args: unknown[]) => void): () => void;

      invoke(channel: 'load-config'): Promise<MainConfig | null>;
      invoke(channel: 'save-config', payload: Partial<MainConfig>): Promise<boolean>;
      invoke(channel: 'download:aria2-status'): Promise<Aria2StatusPayload | null>;
      invoke(channel: 'download:get-dir'): Promise<string>;
      invoke(channel: 'download:set-dir'): Promise<string>;
      invoke(channel: 'download:delete-file', payload: { savePath: string }): Promise<boolean>;
      invoke(channel: 'tab:create', payload: { tabId: string; url: string }): Promise<void>;
      invoke(channel: 'tab:close' | 'tab:activate' | 'tab:goBack' | 'tab:goForward' | 'tab:reload' | 'tab:stop' | 'tab:devtools', payload: { tabId: string }): Promise<void>;
      invoke(channel: 'tab:navigate', payload: { tabId: string; url: string }): Promise<void>;
      invoke(channel: 'tab:zoom', payload: { tabId: string; factor: number }): Promise<void>;
      invoke(channel: 'tab:mute', payload: { tabId: string; muted: boolean }): Promise<void>;
      invoke(channel: 'tab:find', payload: { tabId: string; text: string; options?: Electron.FindInPageOptions }): Promise<void>;
      invoke(channel: 'tab:stopFind', payload: { tabId: string; action: string }): Promise<void>;
      invoke(channel: 'tab:setBounds', payload: { x: number; y: number; w: number; h: number }): Promise<void>;
      invoke(channel: 'tab:setRuffleMode', payload: { tabId: string; enabled: boolean; source: 'bundled' | 'cdn' }): Promise<void>;
      invoke(channel: 'password:status'): Promise<PasswordStoreStatus>;
      invoke(channel: 'password:setup', payload: { password: string }): Promise<boolean>;
      invoke(channel: 'password:unlock', payload: { password: string }): Promise<boolean>;
      invoke(channel: 'password:lock'): Promise<void>;
      invoke(channel: 'password:toggle-enabled'): Promise<boolean>;
      invoke(channel: 'password:list'): Promise<PasswordEntryMeta[]>;
      invoke(channel: 'password:save-confirm', payload: { captureId: string }): Promise<PasswordSaveResult>;
      invoke(channel: 'password:ignore', payload: { captureId: string }): Promise<boolean>;
      invoke(channel: 'password:delete', payload: { id: string }): Promise<boolean>;
      invoke(channel: 'password:get-password', payload: { id: string }): Promise<string | null>;
      invoke(channel: 'password:set-default', payload: { id: string }): Promise<void>;
      invoke(channel: 'password:reset'): Promise<boolean>;
      invoke(channel: 'win:minimize' | 'win:maximize' | 'win:unmaximize' | 'win:close' | 'win:toggleFullscreen'): Promise<void>;
      invoke(channel: 'win:setFullscreen', fullscreen: boolean): Promise<void>;
      invoke(channel: 'win:isMaximized'): Promise<boolean>;
      invoke(channel: string, ...args: unknown[]): Promise<unknown>;

      webviewPreloadPath: string;

      tab: {
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
        find(tabId: string, text: string, options?: Electron.FindInPageOptions): Promise<void>;
        stopFind(tabId: string, action: string): Promise<void>;
        setBounds(x: number, y: number, w: number, h: number): Promise<void>;
        setRuffleMode(tabId: string, enabled: boolean, source: 'bundled' | 'cdn'): Promise<void>;
      };

      config: {
        get(): Promise<MainConfig | null>;
      };

      dl: {
        start(url: string, filename?: string): void;
        cancel(id: string): void;
        pause(id: string): void;
        resume(id: string): void;
        open(savePath: string): void;
        openDir(savePath: string): void;
        getDir(): Promise<string>;
        setDir(): Promise<string>;
        deleteFile(savePath: string): Promise<boolean>;
      };

      pwd: {
        status(): Promise<PasswordStoreStatus>;
        setup(password: string): Promise<boolean>;
        unlock(password: string): Promise<boolean>;
        lock(): Promise<void>;
        toggleEnabled(): Promise<boolean>;
        list(): Promise<PasswordEntryMeta[]>;
        saveConfirm(captureId: string): Promise<PasswordSaveResult>;
        ignore(captureId: string): Promise<boolean>;
        delete(id: string): Promise<boolean>;
        getPassword(id: string): Promise<string | null>;
        setDefault(id: string): Promise<void>;
        resetAll(): Promise<boolean>;
      };

      win: {
        minimize(): Promise<void>;
        maximize(): Promise<void>;
        unmaximize(): Promise<void>;
        close(): Promise<void>;
        setFullscreen(fullscreen: boolean): Promise<void>;
        toggleFullscreen(): Promise<void>;
        isMaximized(): Promise<boolean>;
      };
    };
  }
}

export {};
