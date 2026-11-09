import { app, dialog } from 'electron';
import type { OpenDialogOptions } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createEventHandler } from '../utils/ipc-wrapper';
import { createDiagnosticReport } from '../modules/diagnostics';
import { uiText } from '../modules/ui-language';

export interface DiagnosticExportResult {
  saved: boolean;
  canceled: boolean;
}

/**
 * 诊断相关 IPC（P4a）：对话框属主 = 发起请求的窗口。
 * 原来固定取 getMainWindow()，从窗口 B 导出时模态框会压在 A 上。
 */
export function registerDiagnosticsIPC(): void {
  createEventHandler<undefined, string | null>('file:open-swf', async ({ window: win }) => {
    const options: OpenDialogOptions = {
      title: uiText('打开本地 SWF 游戏', 'Open a local SWF game'),
      properties: ['openFile'],
      filters: [{ name: uiText('Flash 游戏', 'Flash games'), extensions: ['swf'] }],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = result.filePaths[0];
    if (path.extname(selected).toLowerCase() !== '.swf') return null;
    return pathToFileURL(selected).toString();
  });

  createEventHandler<undefined, DiagnosticExportResult>('diagnostics:export', async ({ window: win }) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const options = {
      title: uiText('导出 BaoFlashBrowser 诊断报告', 'Export BaoFlashBrowser diagnostics'),
      defaultPath: path.join(app.getPath('downloads'), `BaoFlashBrowser-diagnostics-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false, canceled: true };
    const report = await createDiagnosticReport();
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { saved: true, canceled: false };
  });
}
