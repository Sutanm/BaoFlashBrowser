// electron-log v4 不支持 printf 占位符：`log.info('…%s', x)` 只会把 x 追加到消息末尾，
// 日志里留下字面量 `%s`（2026-11-10 真机日志：`resolve tab=%s url=%s → target=%s 1772-4 - null`）。
// 这类调用不会报错、也不会被类型检查抓到，只能靠扫源码兜住。
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const PRINTF_CALL = /\blog\.(?:info|warn|error|debug|verbose|silly)\(\s*(['"])[^'"]*%[sdifjoc]\b/;

/** 注释里会引用这条规则本身（`log.info('…%s', x)`），扫之前先去掉注释。 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // `(^|[^:])` 保住 `http://` 这类协议前缀，只掐真正的行注释。
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('logger format strings', () => {
  it('never uses printf placeholders with electron-log', () => {
    const offenders = walk(root)
      .filter((file) => PRINTF_CALL.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(root, file).replace(/\\/g, '/'));

    // 用模板字符串（或 `util.format`）代替：`log.info(`tab=${tabId} url=${url}`)`
    expect(offenders).toEqual([]);
  });
});
