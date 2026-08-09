// Userscript export helpers, pure logic (no Electron).

export function defaultExportFileName(name: string): string {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return (cleaned || 'userscript') + '.user.js';
}
