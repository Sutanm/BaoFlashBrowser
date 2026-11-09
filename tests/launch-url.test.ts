import { describe, expect, it } from 'vitest';
import { findLaunchUrl } from '../src/main/utils/launch-url';

describe('launch url parsing (P6)', () => {
  it('picks the first http(s)/file argument and skips switches', () => {
    expect(findLaunchUrl(['C:\\app.exe', '--flag', 'https://game.example/play'])).toBe('https://game.example/play');
    expect(findLaunchUrl(['app', 'file:///C:/game.swf'])).toBe('file:///C:/game.swf');
  });

  it('ignores non-url arguments and unknown protocols', () => {
    expect(findLaunchUrl(['C:\\app.exe', 'C:\\game.swf', '--x'])).toBeNull();
    expect(findLaunchUrl(['javascript:alert(1)'])).toBeNull();
    expect(findLaunchUrl([])).toBeNull();
  });
});
