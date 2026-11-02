'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Module = require('module');
const assert = require('assert').strict;

module.exports = {
  id: '26-aria2-proxy', name: 'real aria2 browser proxy routing', needsElectron: true, timeoutMs: 30000,
  async run(ctx) {
    const binary = path.join(ctx.root, 'native/aria2', process.platform === 'win32' ? 'aria2c.exe' : 'aria2c');
    if (!fs.existsSync(binary)) return { ok: true, summary: 'bundled aria2 unavailable on this platform; skipped' };
    const bundle = require('esbuild').buildSync({
      entryPoints: [path.join(ctx.root, 'src/main/modules/download-proxy.ts')],
      bundle: true, platform: 'node', format: 'cjs', target: 'node12', write: false, external: ['electron'], alias: { '@shared': path.join(ctx.root, 'src/shared') },
    });
    const compiled = new Module(path.join(ctx.root, 'probe-download-proxy.cjs'), module);
    compiled.filename = path.join(ctx.root, 'probe-download-proxy.cjs');
    compiled._compile(bundle.outputFiles[0].text, compiled.filename);
    compiled.paths = Module._nodeModulePaths(ctx.root);
    const { resolveDownloadProxy } = compiled.exports;
    const { session } = require('electron');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-aria2-proxy-'));
    let hits = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/proxy.pac') {
        res.setHeader('Content-Type', 'application/x-ns-proxy-autoconfig');
        res.end('function FindProxyForURL(url, host) { return host === "download.invalid" ? "PROXY 127.0.0.1:' + server.address().port + '" : "DIRECT"; }');
      } else { hits++; res.end('bao-proxy-fixture'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const run = (url, options, name) => new Promise((resolve, reject) => {
      const child = spawn(binary, ['--no-conf=true', '--max-tries=1', '--timeout=5', '--connect-timeout=5',
        `--dir=${dir}`, `--out=${name}`, ...Object.entries(options).map(([key, value]) => `--${key}=${value}`), url],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, http_proxy: 'http://127.0.0.1:1', all_proxy: 'http://127.0.0.1:1', no_proxy: '*' } });
      const timer = setTimeout(() => { child.kill(); reject(new Error('aria2 timed out')); }, 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('aria2 exit ' + code)); });
    });
    try {
      const sess = session.fromPartition('probe-aria2-proxy');
      await sess.setProxy({ proxyRules: `http://127.0.0.1:${port}`, proxyBypassRules: '*.bypass.invalid' });
      const policy = { mode: 'manual', protocol: 'http', host: '127.0.0.1', port, bypass: '', pacUrl: '' };
      const url = 'http://download.invalid/fixture';
      const proxy = await resolveDownloadProxy(sess, url, policy);
      assert.equal(proxy['http-proxy'], `http://127.0.0.1:${port}`);
      await run(url, proxy, 'proxy.txt');
      assert.equal(fs.readFileSync(path.join(dir, 'proxy.txt'), 'utf8'), 'bao-proxy-fixture');
      assert.equal((await resolveDownloadProxy(sess, 'http://test.bypass.invalid/file', { ...policy, bypass: '*.bypass.invalid' }))['all-proxy'], '');
      // System policy is read from the session, not copied from saved settings.
      await run(url, await resolveDownloadProxy(sess, url, { ...policy, mode: 'system' }), 'system.txt');
      const pacSession = session.fromPartition('probe-aria2-pac');
      await pacSession.setProxy({ pacScript: 'http://127.0.0.1:' + port + '/proxy.pac' });
      await run(url, await resolveDownloadProxy(pacSession, url, { ...policy, mode: 'pac' }), 'pac.txt');
      assert.equal((await resolveDownloadProxy(pacSession, 'http://bypass.invalid/file', { ...policy, mode: 'pac' }))['all-proxy'], '');
      await run(`http://127.0.0.1:${port}/fixture`, await resolveDownloadProxy(sess, `http://127.0.0.1:${port}/fixture`, { ...policy, mode: 'direct' }), 'direct.txt');
      assert.equal(fs.readFileSync(path.join(dir, 'direct.txt'), 'utf8'), 'bao-proxy-fixture');
      await sess.setProxy({ proxyRules: 'socks5://127.0.0.1:1080' });
      assert.equal(await resolveDownloadProxy(sess, url), null);
      assert.equal(hits, 4);
      return { ok: true, summary: 'real aria2 HTTP, system-session and PAC routes downloaded; direct, bypass and SOCKS fallback verified' };
    } finally { server.close(); }
  },
};
