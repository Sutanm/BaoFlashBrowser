import { describe, expect, it } from 'vitest';
import { encodeAutomationImageGroup, expandAutomationImageSelection } from '../src/shared/automation/image-groups';

describe('automation image groups', () => {
  it('expands an encoded group for JavaScript locators and preserves explicit fallbacks', () => {
    const group = encodeAutomationImageGroup(['assets/鱼组/左.png', 'assets/鱼组/右.png']);
    expect(expandAutomationImageSelection(group, ['assets/鱼组/右.png', 'assets/鱼组/正.png'])).toEqual([
      'assets/鱼组/左.png', 'assets/鱼组/右.png', 'assets/鱼组/正.png',
    ]);
  });
});
