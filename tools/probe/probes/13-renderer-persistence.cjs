// Real Chromium IndexedDB checks, using production db.ts in an isolated session.
'use strict';

const http = require('http');
const { execFileSync } = require('child_process');

module.exports = {
  id: '13-renderer-persistence',
  name: 'settings singleton and migration failure recovery',
  needsElectron: true,
  timeoutMs: 30_000,

  async run(ctx) {
    const source = `
      import Dexie from 'dexie';
      import { db, migrateFromLocalStorage, loadMeta } from './src/renderer/services/db';
      window.runPersistenceProbe = async () => {
        const failures = [];
        const legacyDb = new Dexie('BaoFlashDB');
        legacyDb.version(2).stores({ favorites: 'url', history: 'id,lastVisit,url', downloads: 'id', settings: 'searchEngine', meta: 'key' });
        await legacyDb.table('settings').put({ searchEngine: 'bing', language: 'zh-CN' });
        await legacyDb.table('settings').put({ searchEngine: 'google', language: 'en' });
        legacyDb.close();
        const upgraded = await db.settingsSingleton.get('default');
        if (upgraded?.searchEngine !== 'bing' || upgraded?.language !== 'zh-CN') {
          failures.push({ check: 'v2 upgrade preserves previously displayed settings', upgraded });
        }
        const initial = { searchEngine: 'bing', homepage: 'about:newtab', language: 'zh-CN' };
        const latest = { ...initial, searchEngine: 'google', language: 'en' };
        await db.settingsSingleton.put(initial, 'default');
        await db.settingsSingleton.put(latest, 'default');
        const rows = await db.settingsSingleton.toArray();
        if (rows.length !== 1 || rows[0].searchEngine !== latest.searchEngine) {
          failures.push({ check: 'settings must restore latest singleton', rows });
        }

        const legacy = JSON.stringify([{ url: 'https://example.invalid/', title: 'probe' }]);
        localStorage.setItem('baoflash_favorites', legacy);
        const originalBulkPut = db.favorites.bulkPut;
        db.favorites.bulkPut = async () => { throw new Error('injected write failure'); };
        let migrationRejected = false;
        try { await migrateFromLocalStorage(); } catch { migrationRejected = true; }
        finally { db.favorites.bulkPut = originalBulkPut; }
        const sourcePreserved = localStorage.getItem('baoflash_favorites') === legacy;
        const markedComplete = Boolean(await loadMeta('migrated_v1'));
        if (!sourcePreserved || markedComplete) {
          failures.push({ check: 'failed migration must preserve source and remain retryable',
            sourcePreserved, markedComplete, migrationRejected });
        }
        if (sourcePreserved && !markedComplete) {
          await migrateFromLocalStorage();
          const restored = await db.favorites.get('https://example.invalid/');
          if (!restored || !(await loadMeta('migrated_v1')) || localStorage.getItem('baoflash_favorites') !== null) {
            failures.push({ check: 'migration retry must commit and clean source' });
          }
        }
        db.close();
        return { ok: failures.length === 0, failures };
      };
    `;
    // Run esbuild in the installed Node runtime, not Electron 11's older Node.
    const build = `const esbuild = require('esbuild'); process.stdout.write(esbuild.buildSync({
      stdin: { contents: ${JSON.stringify(source)}, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true, write: false, platform: 'browser', format: 'iife', target: 'chrome87'
    }).outputFiles[0].text);`;
    const bundle = execFileSync('node', ['-e', build], {
      cwd: ctx.root, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Isolated persistence probe</title>');
    });
    let host;
    let view;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const { BrowserWindow, BrowserView } = ctx.electron;
      host = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false } });
      view = new BrowserView({ webPreferences: {
        nodeIntegration: false, contextIsolation: true, spellcheck: false,
        partition: `probe-persistence-${Date.now()}`,
      } });
      host.addBrowserView(view);
      await view.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
      await view.webContents.executeJavaScript(bundle);
      const result = await view.webContents.executeJavaScript('window.runPersistenceProbe()');
      return { ok: result.ok, summary: result.ok ? 'persistence healthy' : `${result.failures.length} checks failed`, detail: result };
    } finally {
      if (view && !view.webContents.isDestroyed()) view.webContents.destroy();
      if (host && !host.isDestroyed()) host.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
