// Probe: git state (branch, uncommitted files, recent commits). Read-only.
'use strict';

const { execFileSync } = require('child_process');

function git(args, root) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

module.exports = {
  id: '03-git',
  name: 'git state',
  needsElectron: false,

  async run(ctx) {
    const branch = git(['branch', '--show-current'], ctx.root);
    if (branch === null) {
      return { ok: false, summary: 'not a git repo', detail: { root: ctx.root } };
    }
    const dirty = git(['status', '--porcelain'], ctx.root);
    const dirtyFiles = dirty ? dirty.split('\n').filter(Boolean).length : 0;
    const log = git(['log', '--oneline', '-5'], ctx.root);
    const recent = log ? log.split('\n').filter(Boolean) : [];
    return {
      ok: true,
      summary: `${branch} · ${dirtyFiles} uncommitted`,
      detail: { root: ctx.root, branch, dirtyFiles, dirty: dirty ? dirty.split('\n').filter(Boolean) : [], recent },
    };
  },
};
