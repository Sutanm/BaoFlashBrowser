// Probe: userscript capacity config (settings panel values, read-only).
// Read from the electron-store config file (userData/config.json).
'use strict';

const path = require('path');

module.exports = {
  id: '12-userscript-capacity',
  name: 'userscript capacity config',
  needsElectron: false,

  async run(ctx) {
    const file = path.join(ctx.userData, 'config.json');
    const store = ctx.readJsonSafe(file);
    const pick = (key, fallback) => {
      const value = store && store[key];
      return typeof value === 'number' ? value : fallback;
    };
    const cfg = {
      maxResponseMB: pick('userscriptMaxResponseMB', 2),
      timeoutSeconds: pick('userscriptTimeoutSeconds', 15),
      concurrentPerScript: pick('userscriptMaxConcurrentPerScript', 4),
      concurrentGlobal: pick('userscriptMaxConcurrentGlobal', 16),
      downloadMaxMB: pick('userscriptDownloadMaxMB', 8),
      downloadConcurrent: pick('userscriptDownloadConcurrent', 4),
      maxValueKB: pick('userscriptMaxValueKB', 16),
    };
    return {
      ok: true,
      summary: `xhr ${cfg.maxResponseMB}MB/${cfg.timeoutSeconds}s concurrency ${cfg.concurrentPerScript}x${cfg.concurrentGlobal}; download ${cfg.downloadMaxMB}MB x${cfg.downloadConcurrent}; value ${cfg.maxValueKB}KB`,
      detail: { file, config: cfg },
    };
  },
};
