import { app, dialog } from 'electron';
import type { OpenDialogOptions } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createHandler } from '../utils/ipc-wrapper';
import { createDiagnosticReport } from '../modules/diagnostics';
import { getMainWindow } from '../modules/window';

export interface DiagnosticExportResult {
  saved: boolean;
  canceled: boolean;
}

export function registerDiagnosticsIPC(): void {
  createHandler<void, string | null>('file:open-swf', async () => {
    const win = getMainWindow();
    const options: OpenDialogOptions = {
      title: 'Open a local SWF game',
      properties: ['openFile'],
      filters: [{ name: 'Flash games', extensions: ['swf'] }],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = result.filePaths[0];
    if (path.extname(selected).toLowerCase() !== '.swf') return null;
    return pathToFileURL(selected).toString();
  });

  createHandler<void, DiagnosticExportResult>('diagnostics:export', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const options = {
      title: 'Export BaoFlashBrowser diagnostics',
      defaultPath: path.join(app.getPath('downloads'), `BaoFlashBrowser-diagnostics-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const win = getMainWindow();
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false, canceled: true };
    const report = await createDiagnosticReport();
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { saved: true, canceled: false };
  });
}
