import type {
  ShortcutAction, TabUpdatedPayload, DownloadProgressPayload, NewWindowPayload,
  TabFoundPayload, TabLoadErrorPayload, TabCrashedPayload,
  Aria2StatusPayload, PasswordCapturedPayload, PasswordChangedPayload, PasswordFilledPayload,
  RuffleDiagnosticPayload,
} from '@shared/types/ipc';
import type { PasswordStoreStatus } from '@shared/types/passwords';
import type { DownloadEngine, DownloadItem } from '@shared/types/downloads';
import type { FlashPluginChannel } from '@shared/types/flash';
import type { SessionRecoveryStatus } from '@shared/types/session';
import type { AutomationMessage } from '@shared/automation/types';

interface MainConfig {
  flashVersion: string;
  flashPluginChannel: FlashPluginChannel;
  lowEndMode: boolean;
  downloadEngine: DownloadEngine;
  downloadDir: string;
  screenshotDir: string;
  userscriptMaxResponseMB: number;
  userscriptTimeoutSeconds: number;
  userscriptMaxConcurrentPerScript: number;
  userscriptMaxConcurrentGlobal: number;
  userscriptDownloadMaxMB: number;
  userscriptDownloadConcurrent: number;
  userscriptMaxValueKB: number;
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

interface PasswordOperationResult {
  success: boolean;
  error?: string;
}

interface ScreenshotResult {
  success: boolean;
  code?: string;
  data?: string;
  filePath?: string;
  width?: number;
  height?: number;
  error?: string;
}

interface ScreenshotOptions {
  save?: boolean;
  savePath?: string;
  returnData?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

interface ScreenshotSetDirResult {
  success: boolean;
  canceled?: boolean;
  dir?: string;
  code?: string;
  error?: string;
}

interface PasswordEnabledResult {
  enabled: boolean;
}

interface PasswordFillOperationResult {
  success: boolean;
  filledFields: number;
  filledCredentials: number;
  reason?: 'no-credential' | 'no-form' | 'debugger-unavailable' | 'destroyed';
}

interface AutomationStatus {
  enabled: boolean;
  state: 'idle' | 'checking' | 'ready' | 'countdown' | 'running' | 'completed' | 'failed' | 'cancelled';
  packageId?: string;
  workflowName?: string;
  tabId?: string;
  message?: AutomationMessage;
  currentStep?: AutomationMessage;
  executedSteps?: number;
  debugMode?: boolean;
  debugPaused?: boolean;
  logs?: Array<{
    id: number; timestamp: number; level: 'info' | 'success' | 'warning' | 'error'; message: AutomationMessage; step?: number;
  }>;
}

interface AutomationRunRecord {
  id: string; packageId: string; workflowName: string; tabId: string; mode: 'run' | 'debug';
  startedAt: number; finishedAt: number; state: 'completed' | 'failed' | 'cancelled'; executedSteps: number;
  logs: NonNullable<AutomationStatus['logs']>;
}

interface AutomationPackageDiagnostic {
  packageId: string; valid: boolean; assetCount: number; assetBytes: number; referencedAssets: number;
  unreferencedAssets: string[]; missingAssets: string[]; stepCount: number; maxDepth: number; capabilities: string[];
  issues: Array<{ level: 'info' | 'warning' | 'error'; code: string; detail: string }>;
}

declare global {
  interface Window {
    electronAPI: {
      on(channel: 'shortcut', cb: (action: ShortcutAction) => void): () => void;
      on(channel: 'tab:updated', cb: (payload: TabUpdatedPayload) => void): () => void;
      on(channel: 'tab:found', cb: (payload: TabFoundPayload) => void): () => void;
      on(channel: 'tab:load-error', cb: (payload: TabLoadErrorPayload) => void): () => void;
      on(channel: 'automation:status-changed', cb: (payload: AutomationStatus) => void): () => void;
      on(channel: 'tab:crashed', cb: (payload: TabCrashedPayload) => void): () => void;
      on(channel: 'tab:newwindow', cb: (payload: NewWindowPayload) => void): () => void;
      on(channel: 'download:progress', cb: (payload: DownloadProgressPayload) => void): () => void;
      on(channel: 'aria2:status', cb: (data: Aria2StatusPayload) => void): () => void;
      on(channel: 'navigate-url', cb: (url: string) => void): () => void;
      on(channel: 'password:captured', cb: (payload: PasswordCapturedPayload) => void): () => void;
      on(channel: 'password:changed', cb: (payload: PasswordChangedPayload) => void): () => void;
      on(channel: 'password:filled', cb: (payload: PasswordFilledPayload) => void): () => void;
      on(channel: 'ruffle:diagnostic', cb: (payload: RuffleDiagnosticPayload) => void): () => void;
      on(channel: string, cb: (...args: unknown[]) => void): () => void;

      invoke(channel: 'load-config'): Promise<MainConfig | null>;
      invoke(channel: 'save-config', payload: Partial<MainConfig>): Promise<boolean>;
      invoke(channel: 'download:aria2-status'): Promise<Aria2StatusPayload | null>;
      invoke(channel: 'download:get-dir'): Promise<string>;
      invoke(channel: 'download:set-dir', payload: { title?: string }): Promise<string>;
      invoke(channel: 'download:delete-file', payload: { savePath: string }): Promise<boolean>;
      invoke(channel: 'download:list'): Promise<DownloadItem[]>;
      invoke(channel: 'tab:create', payload: { tabId: string; url: string }): Promise<void>;
      invoke(channel: 'tab:close' | 'tab:suspend' | 'tab:activate' | 'tab:goBack' | 'tab:goForward' | 'tab:reload' | 'tab:stop' | 'tab:devtools', payload: { tabId: string }): Promise<void>;
      invoke(channel: 'tab:navigate', payload: { tabId: string; url: string }): Promise<void>;
      invoke(channel: 'tab:zoom', payload: { tabId: string; factor: number }): Promise<void>;
      invoke(channel: 'tab:mute', payload: { tabId: string; muted: boolean }): Promise<void>;
      invoke(channel: 'tab:find', payload: { tabId: string; text: string; options?: Electron.FindInPageOptions }): Promise<void>;
      invoke(channel: 'tab:stopFind', payload: { tabId: string; action: string }): Promise<void>;
      invoke(channel: 'tab:setBounds', payload: { x: number; y: number; w: number; h: number }): Promise<void>;
      invoke(channel: 'tab:setRuffleMode', payload: { tabId: string; enabled: boolean; source: 'bundled' | 'cdn' }): Promise<void>;
      invoke(channel: 'password:status'): Promise<PasswordStoreStatus>;
      invoke(channel: 'password:setup', payload: { password: string }): Promise<PasswordOperationResult>;
      invoke(channel: 'password:unlock', payload: { password: string }): Promise<PasswordOperationResult>;
      invoke(channel: 'password:lock'): Promise<PasswordOperationResult>;
      invoke(channel: 'password:toggle-enabled'): Promise<PasswordEnabledResult>;
      invoke(channel: 'password:set-auto-capture', payload: { enabled: boolean }): Promise<{ enabled: boolean }>;
      invoke(channel: 'password:set-auto-fill', payload: { enabled: boolean }): Promise<{ enabled: boolean; ready: boolean }>;
      invoke(channel: 'password:list'): Promise<PasswordEntryMeta[]>;
      invoke(channel: 'password:save-confirm', payload: { captureId: string }): Promise<PasswordSaveResult>;
      invoke(channel: 'password:ignore', payload: { captureId: string }): Promise<PasswordOperationResult>;
      invoke(channel: 'password:delete', payload: { id: string }): Promise<PasswordOperationResult>;
      invoke(channel: 'password:get-password', payload: { id: string }): Promise<string | null>;
      invoke(channel: 'password:set-default', payload: { id: string }): Promise<PasswordOperationResult>;
      invoke(channel: 'password:fill', payload: { tabId: string; id: string }): Promise<PasswordFillOperationResult>;
      invoke(channel: 'password:reset'): Promise<PasswordOperationResult>;
      invoke(channel: 'diagnostics:export'): Promise<{ saved: boolean; canceled: boolean }>;
      invoke(channel: 'file:open-swf'): Promise<string | null>;
      invoke(channel: 'session:recovery-status'): Promise<SessionRecoveryStatus>;
      invoke(channel: 'session:resolve-recovery'): Promise<void>;
      invoke(channel: 'win:minimize' | 'win:maximize' | 'win:unmaximize' | 'win:close' | 'win:toggleFullscreen'): Promise<void>;
      invoke(channel: 'win:setFullscreen', fullscreen: boolean): Promise<void>;
      invoke(channel: 'win:isMaximized'): Promise<boolean>;
      invoke(channel: 'screenshot:capture', payload: { tabId: string } & ScreenshotOptions): Promise<ScreenshotResult>;
      invoke(channel: 'screenshot:capture-active', payload: ScreenshotOptions): Promise<ScreenshotResult>;
      invoke(channel: 'screenshot:reveal', payload: { filePath: string }): Promise<{ success: boolean; code?: string; error?: string }>;
      invoke(channel: 'screenshot:set-dir', payload: { title?: string }): Promise<ScreenshotSetDirResult>;
      invoke(channel: string, ...args: unknown[]): Promise<unknown>;

      webviewPreloadPath: string;

      tab: {
        create(tabId: string, url: string, ruffleConfig?: { enabled: boolean; source: 'bundled' | 'cdn' }): Promise<void>;
        close(tabId: string): Promise<void>;
        suspend(tabId: string): Promise<void>;
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
        setDir(title?: string): Promise<string>;
        deleteFile(savePath: string): Promise<boolean>;
        list(): Promise<DownloadItem[]>;
        syncRecords(records: DownloadItem[]): Promise<DownloadItem[]>;
        removeRecord(id: string): Promise<{ success: boolean }>;
        clearFinished(): Promise<{ success: boolean }>;
      };

      pwd: {
        status(): Promise<PasswordStoreStatus>;
        setup(password: string): Promise<PasswordOperationResult>;
        unlock(password: string): Promise<PasswordOperationResult>;
        lock(): Promise<PasswordOperationResult>;
        toggleEnabled(): Promise<PasswordEnabledResult>;
        setAutoCapture(enabled: boolean): Promise<{ enabled: boolean }>;
        setAutoFill(enabled: boolean): Promise<{ enabled: boolean; ready: boolean }>;
        setExcludedSites(sites: string[]): Promise<{ excludedSites: string[] }>;
        list(): Promise<PasswordEntryMeta[]>;
        saveConfirm(captureId: string): Promise<PasswordSaveResult>;
        ignore(captureId: string): Promise<PasswordOperationResult>;
        delete(id: string): Promise<PasswordOperationResult>;
        getPassword(id: string): Promise<string | null>;
        setDefault(id: string): Promise<PasswordOperationResult>;
        fill(tabId: string, id: string): Promise<PasswordFillOperationResult>;
        resetAll(): Promise<PasswordOperationResult>;
      };

      diagnostics: {
        export(): Promise<{ saved: boolean; canceled: boolean }>;
      };

      file: {
        openSwf(): Promise<string | null>;
      };

      session: {
        recoveryStatus(): Promise<SessionRecoveryStatus>;
        resolveRecovery(): Promise<void>;
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

      userscripts: {
        list(): Promise<{ scripts: import('@shared/userscript-types').InstalledUserscript[] }>;
        getSource(id: string): Promise<{ source: string | null }>;
        parseSource(source: string): Promise<
          { ok: true; preview: import('@shared/userscript-types').ParsedUserscriptMetadata }
          | { ok: false; error: string }
        >;
        installSource(source: string, enabled?: boolean): Promise<import('@shared/userscript-types').InstalledUserscript | { ok: false; error: string }>;
        installFile(title?: string): Promise<{ source: string } | { ok: false; error: string }>;
        installUrl(url: string): Promise<{ source: string } | { ok: false; error: string }>;
        uninstall(id: string): Promise<{ ok: boolean }>;
        setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean }>;
        updateSource(id: string, source: string): Promise<import('@shared/userscript-types').InstalledUserscript | { ok: false; error: string }>;
        forTab(tabId: string, url: string): Promise<{
          scripts: Array<{ id: string; name: string; enabled: boolean }>;
          commands: Array<{ commandId: string; title: string; scriptId: string }>;
        }>;
        invokeCommand(tabId: string, commandId: string): Promise<{ ok: boolean }>;
        checkUpdates(): Promise<{
          updates: Array<{ id: string; name: string; currentVersion: string; latestVersion: string; updateUrl: string }>;
        }>;
        applyUpdate(id: string): Promise<{ ok: boolean; error?: string }>;
        backgroundStatus(): Promise<{
          scripts: Array<{ scriptId: string; running: boolean; crashedCount: number; stopped: boolean }>;
          stopped: boolean;
        }>;
        backgroundRestart(id?: string): Promise<{ ok: boolean }>;
        exportSource(id: string, title?: string): Promise<{ ok: boolean; path?: string; error?: string }>;
        listValues(id: string): Promise<{ values: Record<string, unknown> }>;
        setValueAdmin(id: string, key: string, value: unknown): Promise<{ ok: boolean }>;
        deleteValueAdmin(id: string, key: string): Promise<{ ok: boolean }>;
        onChanged(callback: () => void): () => void;
      };

      screenshot: {
        capture(tabId: string, opts?: ScreenshotOptions): Promise<ScreenshotResult>;
        captureActive(opts?: ScreenshotOptions): Promise<ScreenshotResult>;
        reveal(filePath: string): Promise<{ success: boolean; code?: string; error?: string }>;
        setDir(title?: string): Promise<ScreenshotSetDirResult>;
      };

      automation: {
        capabilities(): Promise<AutomationStatus>;
        validateWorkflow(workflow: unknown): Promise<
          { valid: true; workflow: import('@shared/automation/types').AutomationWorkflow }
          | { valid: false; issues: Array<{ path: string; message: string }> }
        >;
        openPackage(i18n?: { title?: string; filterName?: string; replace?: string; cancel?: string; existsTitle?: string; existsMessage?: string }): Promise<
          { canceled: true }
          | { canceled: false; packageId: string; id: string; name: string; assets: string[] }
        >;
        status(): Promise<AutomationStatus>;
        listPackages(): Promise<Array<{ packageId: string; id: string; name: string; assets: string[] }>>;
        getPackage(packageId: string): Promise<{
          packageId: string;
          workflow: import('@shared/automation/types').AutomationWorkflow;
          assets: string[];
        }>;
        getAssetPreview(packageId: string, asset: string): Promise<{
          asset: string; width: number; height: number; bytes: number; dataUrl: string;
        }>;
        diagnosePackage(packageId: string): Promise<AutomationPackageDiagnostic>;
        listRunHistory(packageId?: string): Promise<AutomationRunRecord[]>;
        clearRunHistory(packageId?: string): Promise<{ success: boolean }>;
        openTestScene(i18n?: { title?: string; filterName?: string }): Promise<{
          canceled: boolean; token?: string; name?: string; dataUrl?: string; previewWidth?: number; previewHeight?: number; sourceWidth?: number; sourceHeight?: number;
        }>;
        captureTestSceneTab(tabId: string): Promise<{
          token: string; name: string; dataUrl: string; previewWidth: number; previewHeight: number; sourceWidth: number; sourceHeight: number;
        }>;
        testAssetOnScene(packageId: string, token: string, asset: string, threshold: number, scales?: number[], mask?: 'auto' | 'none' | 'alpha'): Promise<{
          candidate: { x: number; y: number; width: number; height: number; score: number; scale?: number; matchMs?: number; masked?: boolean; lowVariance?: boolean; templateStdDev?: number } | null;
          matched: boolean; threshold: number;
        }>;
        warmupVision(packageId: string): Promise<{ ready: boolean }>;
        importAssetFiles(packageId: string, i18n?: { title?: string; filterName?: string }): Promise<{ canceled: boolean; assets?: string[] }>;
        getAssetReferences(packageId: string, asset: string): Promise<{ referenced: boolean }>;
        deleteAsset(packageId: string, asset: string): Promise<{ assets: string[] }>;
        replaceAsset(packageId: string, asset: string, i18n?: { title?: string; filterName?: string }): Promise<{ canceled: boolean; assets?: string[] }>;
        captureAssetFrame(tabId: string): Promise<{
          token: string; dataUrl: string; previewWidth: number; previewHeight: number; sourceWidth: number; sourceHeight: number;
        }>;
        saveCapturedAsset(packageId: string, token: string, asset: string, rect: { x: number; y: number; width: number; height: number }): Promise<{
          asset: string; width: number; height: number; assets: string[];
        }>;
        updateWorkflow(packageId: string, workflow: unknown): Promise<import('@shared/automation/types').AutomationWorkflow>;
        createPackage(id: string, name: string): Promise<{ packageId: string; id: string; name: string; assets: string[] }>;
        duplicatePackage(packageId: string, id: string, name: string): Promise<{ packageId: string; id: string; name: string; assets: string[] }>;
        deletePackage(packageId: string): Promise<{ success: boolean }>;
        importAssets(packageId: string, i18n?: { title?: string }): Promise<{ canceled: boolean; assets?: string[] }>;
        linkAssetFolder(packageId: string, i18n?: { title?: string }): Promise<{ canceled: boolean; token?: string; name?: string; files?: Array<{ asset: string; bytes: number }> }>;
        syncAssetFolder(packageId: string, token: string): Promise<{ assets: string[]; addedOrUpdated: string[]; missingFromFolder: string[] }>;
        exportPackage(packageId: string, i18n?: { title?: string; filterName?: string }): Promise<{ canceled: boolean; filePath?: string }>;
        checkReady(packageId: string, tabId: string): Promise<boolean>;
        testAsset(packageId: string, tabId: string, asset: string, threshold: number, scales?: number[], mask?: 'auto' | 'none' | 'alpha'): Promise<{
          x: number; y: number; width: number; height: number; score: number; scale?: number; matchMs?: number; masked?: boolean;
        } | null>;
        start(packageId: string, tabId: string, countdownMs?: number): Promise<boolean>;
        debugStart(packageId: string, tabId: string): Promise<boolean>;
        debugContinue(): Promise<boolean>;
        cancel(): Promise<void>;
      };
    };
  }
}

export {};
