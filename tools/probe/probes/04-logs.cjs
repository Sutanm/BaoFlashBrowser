// Probe: electron-log location + tail + error/warn counts.
// LOG POLICY: read-only append. This probe never deletes, truncates or
// clears logs; the full file is left intact for further debugging.
'use strict';

const fs = require('fs');

module.exports = {
  id: '04-logs',
  name: 'electron log tail',
  needsElectron: false,

  async run(ctx) {
    const file = ctx.logFile;
    let tailLines = 200;
    try {
      const parsed = Number(process.env.PROBE_LOG_TAIL);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 5000) tailLines = parsed;
    } catch { /* keep default */ }

    let stat = null;
    let content = '';
    try {
      stat = fs.statSync(file);
      const handle = fs.openSync(file, 'r');
      try {
        const start = Math.max(0, stat.size - 256 * 1024);
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(handle, buffer, 0, buffer.length, start);
        content = buffer.toString('utf8');
      } finally {
        fs.closeSync(handle);
      }
    } catch (error) {
      return { ok: false, summary: `no log at ${file}`, detail: { file, error: String(error) } };
    }

    const lines = content.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-tailLines);
    const counts = {
      error: lines.filter((l) => /\[error\]|error:/i.test(l)).length,
      warn: lines.filter((l) => /\[warn\]|warn:/i.test(l)).length,
    };
    return {
      ok: true,
      summary: `${stat.size} bytes · last ${tail.length} lines · ${counts.error} errors / ${counts.warn} warns`,
      detail: {
        file,
        bytes: stat.size,
        counts,
        tail,
      },
    };
  },
};
