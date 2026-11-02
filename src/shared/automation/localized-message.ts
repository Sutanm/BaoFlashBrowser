import messages from './messages-en.json';
import assistant from './assistant-ui-en.json';

const english: Record<string, string> = { ...assistant, ...messages };
const phrases = Object.keys(english).sort((a, b) => b.length - a.length);
const pattern = new RegExp(phrases.map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu');

/** Platform messages only. Callers must preserve user-authored names and log text. */
export function localizeAutomationMessage(value: string, locale: string): string {
  if (locale !== 'en') return value;
  if (english[value]) return english[value];
  return value.split(/(「[^」]*」)/u).map((part) => part.startsWith('「') ? part : part.replace(pattern, (text) => english[text]))
    .join('').replace(/：/gu, ': ').replace(/（/gu, ' (').replace(/）/gu, ')');
}
