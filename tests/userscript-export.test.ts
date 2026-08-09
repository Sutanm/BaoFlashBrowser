import { describe, it, expect } from 'vitest';
import { defaultExportFileName } from '../src/main/modules/userscripts/userscript-export';

describe('defaultExportFileName', () => {
  it('sanitizes file names', () => {
    expect(defaultExportFileName('Game Helper')).toBe('Game_Helper.user.js');
    expect(defaultExportFileName('a/b:c*?')).toBe('a_b_c_.user.js');
  });

  it('adds the .user.js suffix and trims long names', () => {
    expect(defaultExportFileName('X')).toBe('X.user.js');
    expect(defaultExportFileName('a'.repeat(200))).toHaveLength(80 + '.user.js'.length);
    expect(defaultExportFileName('')).toBe('userscript.user.js');
  });
});
