import { describe, expect, it } from 'vitest';
import { selectFillEntry } from '../src/main/utils/password-fill-policy';

const entries = [
  { id: 'old', host: 'example.com', origin: 'https://example.com/login', username: 'old', updatedAt: 1 },
  { id: 'new', host: 'www.example.com', origin: 'https://www.example.com/auth', username: 'new', updatedAt: 2 },
  { id: 'child', host: 'account.example.com', origin: 'https://account.example.com', username: 'child', updatedAt: 3 },
];

describe('password fill credential policy', () => {
  it('selects the most recently preferred exact-host credential', () => {
    expect(selectFillEntry(entries, 'https://example.com/login')?.id).toBe('new');
    expect(selectFillEntry(entries, 'https://www.example.com/login')?.id).toBe('new');
  });

  it('does not leak credentials between parent and child domains', () => {
    expect(selectFillEntry(entries, 'https://account.example.com')?.id).toBe('child');
    expect(selectFillEntry(entries, 'https://other.example.com')).toBeNull();
  });

  it('never downgrades an HTTPS credential into HTTP', () => {
    expect(selectFillEntry(entries, 'http://example.com/login')).toBeNull();
  });

  it('honors a manually requested entry without weakening host checks', () => {
    expect(selectFillEntry(entries, 'https://example.com', 'old')?.id).toBe('old');
    expect(selectFillEntry(entries, 'https://account.example.com', 'old')).toBeNull();
  });

  it('rejects non-web and malformed URLs', () => {
    expect(selectFillEntry(entries, 'file:///login.html')).toBeNull();
    expect(selectFillEntry(entries, 'not a url')).toBeNull();
  });
});
