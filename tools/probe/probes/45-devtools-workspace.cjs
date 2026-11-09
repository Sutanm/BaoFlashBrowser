// Probe: DevTools 工作区（真实本地文件夹）。
//
// 背景：内置 DevTools 前端跑在 hosted mode，原生宿主的 addFileSystem 只是个假实现
// （塞 `filesystem:devtools://…/overrides` 假条目，第二次点击撞 project 重名）。
// 真实现由主进程 modules/devtoolbox-workspace.ts + 构建期注入的 bfb-workspace.js 组成。
//
// 本探针用**真实的主进程实现**（esbuild 现场编译 TS）+ 真实前端产物 + 真实 preload，
// 端到端验证：目录登记、递归索引、读、写、新建、重命名、删除、搜索、路径逃逸拒绝。
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const { waitFor } = require('../lib/timeout.cjs');

module.exports = {
  id: '45-devtools-workspace',
  name: 'devtools workspace (real local folder)',
  needsElectron: true,
  timeoutMs: 120_000,

  async run(ctx) {
    // ctx.electron 只给了 app/BrowserWindow/BrowserView/ipcMain，这里还要 dialog
    const electron = require('electron');
    const { BrowserWindow, ipcMain, dialog } = electron;
    const esbuild = require(path.join(ctx.root, 'node_modules', 'esbuild'));
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

    // ---- 1. 现场编译真实主进程模块 ----
    // 产物必须落在项目内：只把 electron 留作 external，其余（electron-log）
    // 打进 bundle，否则临时目录里 require 解析不到 node_modules。
    const outDir = path.join(ctx.root, 'node_modules', '.cache');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `bfb-devtools-workspace-${process.pid}.cjs`);
    await esbuild.build({
      entryPoints: [path.join(ctx.root, 'src', 'main', 'modules', 'devtoolbox-workspace.ts')],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node12',
      external: ['electron'],
      logLevel: 'silent',
    });
    const workspace = require(outFile);

    // ---- 2. 准备真实的“工作区目录” ----
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfb-ws-probe-'));
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log("hello workspace");\n');
    fs.writeFileSync(path.join(root, 'readme.md'), 'needle-42 here\n');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'index.html'), '<!doctype html><title>x</title>');
    // 越界目标：与根目录同级的邻居文件，只有逃出根目录才读得到
    const outsider = path.join(path.dirname(root), `bfb-outsider-${process.pid}.txt`);
    fs.writeFileSync(outsider, 'SECRET');

    // dialog 换成直接返回准备好的目录（真实实现走的是 dialog.showOpenDialog）
    const originalOpenDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });

    ipcMain.handle('devtoolbox:workspace', async (_event, args) => {
      const a = args || {};
      switch (a.action) {
        case 'list': return { ok: true, roots: workspace.listWorkspaceRoots() };
        case 'pick': return workspace.pickWorkspaceRoot(a.type ?? '');
        case 'remove': return workspace.removeWorkspaceRoot(a.fileSystemPath);
        case 'readDir': return workspace.readWorkspaceDirectory(a.name, a.relative);
        case 'stat': return workspace.statWorkspacePath(a.name, a.relative);
        case 'readFile': return workspace.readWorkspaceFile(a.name, a.relative);
        case 'writeFile': return workspace.writeWorkspaceFile(a.name, a.relative, a.base64);
        case 'createFile': return workspace.createWorkspaceFile(a.name, a.relative, a.exclusive);
        case 'createDirectory': return workspace.createWorkspaceDirectory(a.name, a.relative);
        case 'deletePath': return workspace.deleteWorkspacePath(a.name, a.relative, a.recursive);
        case 'move': return workspace.moveWorkspacePath(a.name, a.relative, a.to);
        case 'search': return workspace.searchWorkspacePath(a.fileSystemPath, a.query ?? '');
        default: return { ok: false, error: { name: 'InvalidModificationError', message: 'unknown' } };
      }
    });

    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        partition: 'persist:probe-devtools-workspace',
        preload: path.join(ctx.root, 'dist', 'devtools-preload.js'),
      },
    });
    const consoleLogs = [];
    win.webContents.on('console-message', (_e, level, message) => {
      consoleLogs.push(`${level}: ${String(message).slice(0, 200)}`);
    });

    const evaluate = (expression) => win.webContents.executeJavaScript(expression);

    // 与生产同一形状：主进程 watcher → 前端容器（preload 转成 bfbBridge.workspace.onChanges）
    workspace.setWorkspaceChangeSink((fileSystemPath, change) => {
      if (!win.isDestroyed()) win.webContents.send('devtoolbox:workspace-changes', { fileSystemPath, change });
    });

    try {
      const entry = path.join(ctx.root, 'dist', 'devtools-frontend', 'devtools_app.html');
      await win.loadURL(pathToFileUrl(entry) + '?can_dock=true');
      await waitFor(async () => {
        const ready = await evaluate('Boolean(window.bfbBridge && window.bfbBridge.workspace)').catch(() => false);
        return ready === true;
      }, { timeoutMs: 30_000, label: 'frontend preload ready' });

      // ---- 3. 走真实「添加文件夹」路径（宿主方法已被 bfb-workspace.js 接管） ----
      const addResult = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const mgr = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance();
        await mgr.waitForFileSystems();
        const before = mgr.fileSystems().length;
        const added = await mgr.addFileSystem();
        return JSON.stringify({
          before,
          after: mgr.fileSystems().length,
          addedPath: added ? added.path() : null,
          addedEmbedder: added ? added.embedderPath() : null,
        });
      })()`);
      const add = JSON.parse(addResult);
      // snippet:// 项目是惰性注册的，before 可能是 0：只断言目标文件夹自己登记成功
      check(
        'add folder via host stub',
        Boolean(add.addedPath) && add.after > add.before,
        add,
      );
      check(
        'embedder path is the real folder',
        add.addedEmbedder === root,
        add.addedEmbedder,
      );

      // ---- 4. 递归索引（前端 initializeFilePaths 的实际调用链） ----
      const listed = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        const out = [];
        const readAll = (dir) => new Promise((resolve) => {
          const reader = dir.createReader();
          const acc = [];
          const step = () => reader.readEntries((list) => {
            if (!list.length) return resolve(acc);
            acc.push.apply(acc, list);
            step();
          });
          step();
        });
        const walk = async (dir) => {
          for (const entry of await readAll(dir)) {
            out.push((entry.isDirectory ? 'D ' : 'F ') + entry.fullPath);
            if (entry.isDirectory) await walk(entry);
          }
        };
        await walk(fsys.domFileSystem.root);
        return JSON.stringify({ entries: out.sort(), initial: fsys.initialFilePaths().length });
      })()`);
      const listing = JSON.parse(listed);
      check('recursive index lists every entry', listing.entries.length === 4, listing.entries);
      check('initial file paths populated', listing.initial === 3, listing.initial);

      // ---- 5. 读文件内容 ----
      const readResult = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        return JSON.stringify(await fsys.requestFileContent('/readme.md'));
      })()`);
      const read = JSON.parse(readResult);
      check('read file content', read.content === 'needle-42 here\n' && read.isEncoded === false, read);

      // ---- 6. 写文件（Sources 里保存走 setFileContent → createWriter） ----
      await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        await fsys.setFileContent('/app.js', 'console.log("SAVED BY DEVTOOLS");', false);
        return 'ok';
      })()`);
      // createWriter 的落盘是异步回调（write → onwriteend → truncate），等它稳定
      const written = await waitFor(
        async () => {
          if (!fs.existsSync(path.join(root, 'app.js'))) return false;
          return fs.readFileSync(path.join(root, 'app.js'), 'utf8') === 'console.log("SAVED BY DEVTOOLS");';
        },
        { timeoutMs: 5000, label: 'text write reaches disk' },
      ).catch(() => false);
      check('write file reaches disk', written === true, fs.existsSync(path.join(root, 'app.js')) ? fs.readFileSync(path.join(root, 'app.js'), 'utf8') : 'missing');

      // ---- 7. 二进制写（base64 透传） ----
      await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        await fsys.setFileContent('/bin.dat', 'AAECAwQ=', true);
        return 'ok';
      })()`);
      await waitFor(
        async () => fs.existsSync(path.join(root, 'bin.dat'))
          && fs.readFileSync(path.join(root, 'bin.dat')).length === 5,
        { timeoutMs: 5000, label: 'binary write reaches disk' },
      ).catch(() => {});
      const binary = fs.existsSync(path.join(root, 'bin.dat')) ? [...fs.readFileSync(path.join(root, 'bin.dat'))] : [];
      check('binary write decodes base64', JSON.stringify(binary) === '[0,1,2,3,4]', binary);

      // ---- 8. 元数据（Elements 自动映射依赖 size/modificationTime） ----
      const metaResult = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        const meta = await fsys.getMetadata('/app.js');
        return JSON.stringify({ size: meta && meta.size, hasTime: Boolean(meta && meta.modificationTime) });
      })()`);
      const meta = JSON.parse(metaResult);
      check('metadata size/time available', meta.size > 0 && meta.hasTime === true, meta);

      // ---- 9. 新建文件（createFile(dir, name)：前端传的是**目录** + 文件名） ----
      const createResult = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        return JSON.stringify({
          first: await fsys.createFile('/src', 'NewFile'),
          second: await fsys.createFile('/src', 'NewFile'),
        });
      })()`);
      const created = JSON.parse(createResult);
      check('create file increments name', created.first !== created.second, created);
      check(
        'created file exists on disk',
        Boolean(created.first) && fs.existsSync(path.join(root, created.first.replace(/^\//, ''))),
        created.first,
      );

      // ---- 10. 重命名（renameFile → moveTo） ----
      const createdRel = String(created.first || '');
      const renameResult = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        return JSON.stringify(await new Promise((resolve) => {
          fsys.renameFile('/' + ${JSON.stringify(createdRel)}, 'Renamed.js', (ok, name) => resolve({ ok, name }));
        }));
      })()`);
      const renamed = JSON.parse(renameResult);
      check('rename file', renamed.ok === true && fs.existsSync(path.join(root, 'src', 'Renamed.js')), renamed);

      // ---- 11. 删除 ----
      const deleteResult = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        return String(await fsys.deleteFile('/src/Renamed.js'));
      })()`);
      check('delete file', deleteResult === 'true' && !fs.existsSync(path.join(root, 'src', 'Renamed.js')), deleteResult);

      // ---- 12. 搜索（Sources 的「在文件中搜索」） ----
      const searchResult = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        const files = await fsys.searchInPath('needle-42', { incrementWorked() {} });
        return JSON.stringify(files);
      })()`);
      const searched = JSON.parse(searchResult);
      check('search finds matching file', searched.length === 1 && searched[0].endsWith('/readme.md'), searched);

      // ---- 12b. 外部编辑器改动：主进程 watcher → 前端 FileSystemFilesChangedAddedRemoved ----
      const subscribed = await evaluate(`(() => {
        window.__wsEvents = [];
        const host = globalThis.InspectorFrontendHost;
        if (!host || !host.events) return false;
        host.events.addEventListener('FileSystemFilesChangedAddedRemoved', (event) => {
          window.__wsEvents.push(event.data);
        });
        return true;
      })()`);
      check('workfrontend event channel available', subscribed === true, subscribed);

      const externalFile = path.join(root, 'src', 'external.txt');
      const readEvents = async () => JSON.parse(await evaluate('JSON.stringify(window.__wsEvents || [])'));
      const hasPath = (events, key, suffix) => events.some(
        (item) => Array.isArray(item && item[key]) && item[key].some((p) => String(p).endsWith(suffix)),
      );

      fs.writeFileSync(externalFile, 'external-marker-99\n');
      const addedEvent = await waitFor(
        async () => hasPath(await readEvents(), 'added', '/src/external.txt'),
        { timeoutMs: 8000, label: 'added change event' },
      ).catch(() => false);
      check('external add notifies frontend', addedEvent === true, await readEvents());

      // 索引同步后才能搜到：watcher 的 300ms 合并窗口正是本用例要覆盖的路径
      const indexedSearch = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        const files = await fsys.searchInPath('external-marker-99', { incrementWorked() {} });
        return JSON.stringify(files);
      })()`);
      const indexedHits = JSON.parse(indexedSearch);
      check(
        'index sees externally added file',
        indexedHits.length === 1 && indexedHits[0].endsWith('/src/external.txt'),
        indexedHits,
      );

      fs.writeFileSync(externalFile, 'external-marker-changed\n');
      const changedEvent = await waitFor(
        async () => hasPath(await readEvents(), 'changed', '/src/external.txt'),
        { timeoutMs: 8000, label: 'changed change event' },
      ).catch(() => false);
      check('external modify notifies frontend', changedEvent === true, await readEvents());

      fs.unlinkSync(externalFile);
      const removedEvent = await waitFor(
        async () => hasPath(await readEvents(), 'removed', '/src/external.txt'),
        { timeoutMs: 8000, label: 'removed change event' },
      ).catch(() => false);
      check('external delete notifies frontend', removedEvent === true, await readEvents());

      // ---- 13. 路径逃逸必须被拒绝 ----
      const escapeResult = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const fsys = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance()
          .fileSystems().find((f) => f.path().indexOf('file:') === 0);
        const relative = await fsys.requestFileContent('/../../' + ${JSON.stringify(path.basename(outsider))});
        const absolute = await fsys.requestFileContent('/' + ${JSON.stringify(outsider.replace(/\\/g, '/'))});
        return JSON.stringify({
          relativeContent: Boolean(relative && relative.content),
          absoluteContent: Boolean(absolute && absolute.content),
          relativeError: relative && relative.error,
          absoluteError: absolute && absolute.error,
        });
      })()`);
      const escape = JSON.parse(escapeResult);
      check('relative escape blocked', escape.relativeContent === false, escape.relativeError);
      check('absolute escape blocked', escape.absoluteContent === false, escape.absoluteError);

      // ---- 14. 移除工作区 ----
      const removeResult = await evaluate(`(async () => {
        const m = await import('./models/persistence/persistence.js');
        const mgr = m.IsolatedFileSystemManager.IsolatedFileSystemManager.instance();
        const fsys = mgr.fileSystems().find((f) => f.path().indexOf('file:') === 0);
        const before = mgr.fileSystems().length;
        mgr.removeFileSystem(fsys);
        await new Promise((r) => setTimeout(r, 300));
        return JSON.stringify({ before, after: mgr.fileSystems().length });
      })()`);
      const removed = JSON.parse(removeResult);
      check('remove workspace folder', removed.after === removed.before - 1, removed);
    } finally {
      dialog.showOpenDialog = originalOpenDialog;
      ipcMain.removeHandler('devtoolbox:workspace');
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(outsider, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
    }

    const failures = checks.filter((item) => !item.ok);
    return {
      ok: failures.length === 0,
      summary: failures.length === 0 ? `${checks.length} checks passed` : `${failures.length}/${checks.length} failed`,
      detail: { failures, checks, console: consoleLogs.slice(-6) },
    };
  },
};

function pathToFileUrl(target) {
  const normalized = target.replace(/\\/g, '/');
  return `file:///${normalized.replace(/^\//, '')}`;
}
