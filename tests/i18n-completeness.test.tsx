import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import en from '../src/renderer/i18n/en';
import zh from '../src/renderer/i18n/zh-CN';
import { docSections } from '../src/renderer/components/automation/automation-docs-data';
import { englishDocSections } from '../src/renderer/components/automation/automation-docs-en';
import { englishAssistantSource } from '../build/native-assistant-i18n.mjs';
import { localizeAutomationMessage } from '../src/shared/automation/localized-message';

function entries(value: unknown, prefix = ''): Array<[string, string]> {
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => typeof item === 'string' ? [[`${prefix}${key}`, item] as [string, string]] : entries(item, `${prefix}${key}.`));
}

describe('release i18n coverage', () => {
  it('keeps both dictionaries complete with identical interpolation arguments', () => {
    const english = Object.fromEntries(entries(en));
    const chinese = Object.fromEntries(entries(zh));
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort());
    for (const [key, text] of Object.entries(english)) {
      expect(text.trim(), key).not.toBe('');
      expect(text, key).not.toMatch(/[\p{Script=Han}]/u);
      const args = (value: string) => [...value.matchAll(/\{([A-Za-z]\w*)[}:]/gu)].map((match) => match[1]).sort();
      expect(args(text), key).toEqual(args(chinese[key]));
    }
  });

  it('provides English content for every built-in automation documentation section', () => {
    expect(englishDocSections).toHaveLength(docSections.length);
    for (const section of englishDocSections) {
      expect(section.title + renderToStaticMarkup(section.content), section.id).not.toMatch(/[\p{Script=Han}]/u);
    }
  });

  it('translates every native assistant literal and rejects new untranslated labels', () => {
    const source = fs.readFileSync(path.resolve('src/main/modules/userscripts/bundled-scripts/automation-frame-assistant.user.js'), 'utf8');
    const tree = ts.createSourceFile('english.js', englishAssistantSource(source), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) expect(node.text).not.toMatch(/[\p{Script=Han}]/u);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(() => englishAssistantSource("const label = '未翻译的新标签';")).toThrow('Missing English assistant text');
  });

  it('localizes platform errors while preserving quoted user-authored names', () => {
    expect(localizeAutomationMessage('测试画面已过期，请重新导入', 'en')).toBe('The test scene expired; import it again');
    expect(localizeAutomationMessage('开始运行「我的游戏脚本」', 'en')).toBe('Start「我的游戏脚本」');
    expect(localizeAutomationMessage('测试画面已过期，请重新导入', 'zh-CN')).toBe('测试画面已过期，请重新导入');
  });
});
