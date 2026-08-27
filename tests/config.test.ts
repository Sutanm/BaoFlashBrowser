import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, CONFIG_SCHEMA, DEFAULT_CONFIG } from '../src/main/modules/config';

describe('main config field registry', () => {
  it('keeps defaults, schema and generated read/write keys aligned', () => {
    const defaults = Object.keys(DEFAULT_CONFIG).sort();
    expect([...CONFIG_KEYS].sort()).toEqual(defaults);
    expect(Object.keys(CONFIG_SCHEMA).sort()).toEqual(defaults);
  });
});
