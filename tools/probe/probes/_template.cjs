// Probe toolkit — NEW PROBE TEMPLATE.
//
// To add a probe: copy this file, rename to <NN>-<name>.cjs, and fill in the
// four fields + run(). No host changes are needed: the host auto-discovers
// every probes/*.cjs that exports the standard shape and skips files named
// _template.cjs.
//
// Protocol (all probes MUST implement):
//   id           unique, sortable (prefix 00-09 = pure Node, 10-19 = Electron)
//   name         human-readable, used in the table
//   needsElectron true  => run inside host-electron.cjs (app ready, Electron APIs ok)
//                false => run inside host.cjs (plain Node, seconds)
//   timeoutMs    probe-level budget (optional; host watchdog always applies)
//   run(ctx)     async; ctx = { root, userData, logFile, readJsonSafe,
//                              latestMtime, exists, electron?: require('electron') }
//   result       { ok: boolean, summary: string, detail?: unknown }
//                - summary: one line for the table
//                - detail: arbitrary JSON, always emitted in --json mode
//                - NEVER write to userData/app state: probing is read-only.
//                - Logs: read-only append. Never delete/truncate/clear logs.

'use strict';

module.exports = {
  id: '99-template',
  name: 'template probe',
  needsElectron: false,
  timeoutMs: undefined, // optional: default to host watchdog

  async run(ctx) {
    // Implement here. Example:
    // const fs = require('fs');
    // const path = require('path');
    // const file = path.join(ctx.userData, 'something.json');
    // const data = ctx.readJsonSafe(file);
    // if (!data) return { ok: false, summary: 'missing ' + file };
    // return { ok: true, summary: `${data.length} entries`, detail: data };
    void ctx;
    return { ok: true, summary: 'not implemented' };
  },
};
