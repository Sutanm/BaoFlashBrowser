// Probe toolkit — output formatting. Text table for humans, JSON for AI.
// Partial failures do NOT abort the run; the exit code counts failures.
'use strict';

function renderText(results) {
  const rows = results.map((r) => ({
    id: r.id,
    status: r.ok ? 'OK ' : 'FAIL',
    name: r.name,
    summary: String(r.summary ?? ''),
  }));
  const width = (key) => Math.max(...rows.map((r) => String(r[key] || '').length), key.length);
  const wId = width('id');
  const wName = width('name');
  const wStatus = width('status');
  const line = (r) =>
    ` ${String(r.id).padEnd(wId)} ${String(r.status).padEnd(wStatus)} ${String(r.name).padEnd(wName)} ${r.summary}`;
  const header = ` ${'id'.padEnd(wId)} ${'status'.padEnd(wStatus)} ${'name'.padEnd(wName)} summary`;
  const sep = '-'.repeat(Math.max(header.length, ...rows.map((r) => line(r).length)));
  const out = [header, sep, ...rows.map(line)];
  const failed = results.filter((r) => !r.ok).length;
  out.push(sep, ` ${results.length} probes, ${failed} failed`);
  return out.join('\n');
}

function renderJson(results) {
  return JSON.stringify({ generatedAt: new Date().toISOString(), probes: results }, null, 2);
}

function failCount(results) {
  return results.filter((r) => !r.ok).length;
}

module.exports = { renderText, renderJson, failCount };
