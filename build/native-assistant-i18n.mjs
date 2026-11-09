import ts from 'typescript';
import fs from 'fs';

const english = JSON.parse(fs.readFileSync(new URL('../src/shared/automation/assistant-ui-en.json', import.meta.url), 'utf8'));
export function englishAssistantSource(source) {
  const tree = ts.createSourceFile('assistant.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const translate = (value) => value.replace(/[\p{Script=Han}]+/gu, (text) => {
    if (!(text in english)) throw new Error(`Missing English assistant text: ${text}`);
    return english[text];
  }).replace(/：/gu, ': ').replace(/，/gu, ', ').replace(/；/gu, '; ').replace(/（/gu, ' (').replace(/）/gu, ')').replace(/[「“]/gu, '"').replace(/[」”]/gu, '"');
  const result = ts.transform(tree, [(context) => {
    const visit = (node) => {
      if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(node.text === 'zh-CN' ? 'en-US' : translate(node.text));
      if (ts.isNoSubstitutionTemplateLiteral(node)) return ts.factory.createNoSubstitutionTemplateLiteral(translate(node.text));
      if (ts.isTemplateHead(node)) return ts.factory.createTemplateHead(translate(node.text));
      if (ts.isTemplateMiddle(node)) return ts.factory.createTemplateMiddle(translate(node.text));
      if (ts.isTemplateTail(node)) return ts.factory.createTemplateTail(translate(node.text));
      return ts.visitEachChild(node, visit, context);
    };
    return (node) => ts.visitNode(node, visit);
  }]);
  try { return ts.createPrinter().printFile(result.transformed[0]); }
  finally { result.dispose(); }
}

export function nativeAssistantModule(source) {
  const owned = (text) => text.replace(/\b(window|document)\.addEventListener\(/gu, 'listen($1,')
    .replace(/window\.setInterval\(/gu, 'setInterval(').replace(/window\.setTimeout\(/gu, 'setTimeout(');
  return `export default function install(GM, locale) {
    let disposed = false;
    const timers = [], intervals = [], listeners = [];
    const setTimeout = (...args) => disposed ? 0 : (timers.push(window.setTimeout(...args)), timers[timers.length-1]);
    const setInterval = (...args) => disposed ? 0 : (intervals.push(window.setInterval(...args)), intervals[intervals.length-1]);
    const listen = (target, ...args) => { if (!disposed) { target.addEventListener(...args); listeners.push([target, args]); } };
    if (locale === 'en') { ${owned(englishAssistantSource(source))} } else { ${owned(source)} }
    return () => {
      disposed = true;
      timers.forEach(id => window.clearTimeout(id)); intervals.forEach(id => window.clearInterval(id));
      listeners.forEach(([target, args]) => target.removeEventListener(...args));
      ['bao-automation-frame-assistant','bao-automation-assistant-style','bao-automation-assistant-toasts','bao-automation-capture-layer','bao-automation-coordinate-layer','bao-automation-game-layer','bao-automation-history-layer'].forEach(id => document.getElementById(id)?.remove());
    };
  }`;
}
