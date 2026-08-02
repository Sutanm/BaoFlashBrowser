import { describe, expect, it } from 'vitest';
import { redactDiagnosticText } from '../src/main/utils/diagnostic-redaction';

describe('diagnostic redaction', () => {
  it('removes private paths, URL credentials, queries and secrets', () => {
    const result = redactDiagnosticText(
      'C:\\Users\\alice\\data https://bob:pw@example.com/game?token=abc#part password=hello authorization:Bearer123',
      ['C:\\Users\\alice'],
    );
    expect(result).not.toContain('alice');
    expect(result).not.toContain('bob');
    expect(result).not.toContain('pw');
    expect(result).not.toContain('token=abc');
    expect(result).not.toContain('hello');
    expect(result).not.toContain('Bearer123');
    expect(result).toContain('<PRIVATE_PATH>');
    expect(result).toContain('<REDACTED>');
  });
});
