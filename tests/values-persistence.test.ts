// GM 值持久化单测 (Task 1)
// TDD: 先写失败测试，再实现，再跑通

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { ValueStore } from '../src/main/modules/userscripts/userscript-store';
import { UserscriptManager } from '../src/main/modules/userscripts/userscript-manager';

let dir: string;
let file: string;
let manager: UserscriptManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usv-'));
  file = path.join(dir, 'values.json');
  manager = new UserscriptManager(new ValueStore(), {
    persistValues: { file, debounceMs: 200, urgentBytes: 1024 },
    sendToWc: () => {},
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('persistValues', () => {
  it('persists across manager instances', () => {
    manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't' });
    manager.setValue(1, 's', 'k', 'v1');
    manager.flushValues();
    const m2 = new UserscriptManager(new ValueStore(), { sendToWc: () => {} });
    m2.loadValues(file); // 公开方法 (values 是 private)
    m2.registerView(1, { mode: 'ppapi', generation: 1, token: 't' });
    expect(m2.getValuesFor(1, 's').k).toBe('v1');
  });

  it('large value flushes immediately without explicit flush', async () => {
    manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't' });
    manager.setValue(1, 's', 'big', 'x'.repeat(2000));
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(file)).toBe(true);
  });

  it('small value lands after debounce', async () => {
    manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't' });
    manager.setValue(1, 's', 'k', 'v1');
    await new Promise((r) => setTimeout(r, 350));
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.s.k).toBe('"v1"');
  });

  it('cumulative script bytes over 8KB flush immediately', async () => {
    // 单值 902B(≤ urgentBytes 1024,走累计路径)+ 10 个累计 9020B > 8KB → 第 10 次写入立即 flush
    manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't' });
    for (let i = 0; i < 10; i++) manager.setValue(1, 's', 'k' + i, 'y'.repeat(900));
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(file)).toBe(true);
  });
});
