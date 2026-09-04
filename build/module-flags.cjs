const OPTIONAL_MODULES = Object.freeze([
  'userscripts',
  'automation',
  'passwords',
  'screenshot',
  'download',
  'diagnostics',
  'memory-monitor',
  'js-patch',
]);

const ALL_MODULES = Object.freeze(['core', ...OPTIONAL_MODULES]);

function parseModules(raw = process.env.BAO_MODULES) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'default' || value === 'all') return new Set(ALL_MODULES);
  const requested = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  const unknown = [...new Set(requested.filter((entry) => !ALL_MODULES.includes(entry)))];
  if (unknown.length > 0) throw new Error(`Unknown BAO_MODULES value(s): ${unknown.join(', ')}`);
  return new Set(['core', ...requested]);
}

function moduleDefines(modules) {
  return Object.fromEntries(OPTIONAL_MODULES.map((name) => [
    `MODULE_${name.replace(/-/g, '_').toUpperCase()}`,
    JSON.stringify(modules.has(name)),
  ]));
}

function moduleSummary(modules) {
  return ALL_MODULES.filter((name) => modules.has(name)).join(',');
}

module.exports = { OPTIONAL_MODULES, ALL_MODULES, parseModules, moduleDefines, moduleSummary };
