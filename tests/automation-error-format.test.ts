import { describe, expect, it } from 'vitest';
import { automationError, automationErrorMessage } from '../src/shared/automation/error-format';

describe('automation error formatting', () => {
  it('preserves structured sandbox errors', () => {
    const value = Object.freeze({ name: 'BaoAutomationError', code: 'CALL_FAILED', message: 'capture region is outside the frame' });
    expect(automationErrorMessage(value)).toBe('CALL_FAILED: capture region is outside the frame');
    expect(automationError(value).message).toBe('CALL_FAILED: capture region is outside the frame');
  });

  it('keeps native Error messages unchanged', () => {
    expect(automationErrorMessage(new Error('boom'))).toBe('boom');
  });
});
