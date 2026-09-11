// Probe: electron-log location + tail + error/warn fingerprinting.
//
// Why fingerprint: a raw count ("692 errors") tells you nothing about whether
// they are one repeated line or 692 distinct failures. In practice the noise
// source and the real bug are both only visible once messages are grouped —
// a single Blockly re-registration bug produced 1,325 log lines, which buried a
// one-off genuine exception. This probe answers "what is actually repeating".
//
// LOG POLICY: read-only append. This probe never deletes, truncates or
// clears logs; the full file is left intact for further debugging.
'use strict';

const fs = require('fs');

/** How many distinct fingerprints to surface per level. */
const TOP_N = 8;

/**
 * Collapse the variable parts of a log message so the same event groups together.
 * Ids, counts, timings, urls, hashes and file paths all differ per occurrence.
 */
function fingerprint(message) {
  return message
    // renderer console prefix carries a file path + line/column
    .replace(/\(file:[^)]*\)/g, '(file:…)')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hash>')
    .replace(/\bhttps?:\/\/\S+/g, '<url>')
    .replace(/\b[A-Za-z]:[\\/][^\s"']*/g, '<path>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|KB|MB|bytes)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

module.exports = {
  id: '04-logs',
  name: 'electron log tail + fingerprints',
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

    // Shape: [timestamp] [level]  [Tag] message
    const LEVEL_LINE = /^\[[^\]]*\]\s*\[(\w+)\]\s*(.*)$/;
    const counts = { error: 0, warn: 0 };
    /** @type {Map<string, { level: string, count: number, sample: string }>} */
    const groups = new Map();

    for (const line of lines) {
      const match = LEVEL_LINE.exec(line);
      if (!match) continue;
      const level = match[1].toLowerCase();
      if (level !== 'error' && level !== 'warn') continue;
      counts[level] += 1;
      const body = match[2];
      const tag = /^\[([^\]]+)\]/.exec(body);
      const key = `${level}/${tag ? tag[1] : '(none)'} :: ${fingerprint(body)}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(key, { level, count: 1, sample: body.slice(0, 200) });
      }
    }

    const ranked = [...groups.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.count - a.count);

    const top = {};
    for (const level of ['error', 'warn']) {
      top[level] = ranked.filter((entry) => entry.level === level).slice(0, TOP_N);
    }

    // Name the single loudest offender in the summary so the shape of the noise
    // is visible without opening the detail payload.
    const loudest = ranked[0];
    const distinct = groups.size;
    const noiseHint = loudest && loudest.count > lines.length * 0.1
      ? ` · TOP: ${loudest.count}× ${loudest.key.split(' :: ')[0]}`
      : '';

    return {
      ok: true,
      summary: `${stat.size} bytes · last ${tail.length} lines · ${counts.error} errors / ${counts.warn} warns in ${distinct} distinct pattern(s)${noiseHint}`,
      detail: {
        file,
        bytes: stat.size,
        counts,
        distinctPatterns: distinct,
        top,
        tail,
      },
    };
  },
};
