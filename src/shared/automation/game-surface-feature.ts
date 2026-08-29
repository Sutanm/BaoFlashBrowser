import type { AutomationGameSurfaceLocator } from './types';

export const GAME_SURFACE_FEATURE_PREFIX = 'BFG1:';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeGameSurfaceFeature(locator: AutomationGameSurfaceLocator): string {
  return `${GAME_SURFACE_FEATURE_PREFIX}${toBase64Url(new TextEncoder().encode(JSON.stringify(locator)))}`;
}

export function decodeGameSurfaceFeature(value: string): AutomationGameSurfaceLocator {
  const text = value.trim();
  if (!text.startsWith(GAME_SURFACE_FEATURE_PREFIX)) throw new Error('剪贴板中没有游戏画面特征串');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(text.slice(GAME_SURFACE_FEATURE_PREFIX.length)))); }
  catch { throw new Error('游戏画面特征串已损坏'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('游戏画面特征串无效');
  const item = parsed as Partial<AutomationGameSurfaceLocator>;
  if (item.version !== 1 || !['flash', 'ruffle', 'canvas', 'frame'].includes(String(item.kind))
    || typeof item.width !== 'number' || item.width < 1 || typeof item.height !== 'number' || item.height < 1) {
    throw new Error('游戏画面特征串版本或内容无效');
  }
  return {
    version: 1,
    kind: item.kind as AutomationGameSurfaceLocator['kind'],
    label: String(item.label || '').slice(0, 200),
    source: String(item.source || '').slice(0, 600),
    frameUrl: String(item.frameUrl || '').slice(0, 600),
    width: Math.round(item.width),
    height: Math.round(item.height),
  };
}

export function gameSurfaceFeatureLabel(locator: AutomationGameSurfaceLocator): string {
  return `${locator.label || (locator.kind === 'flash' ? 'Flash 游戏画面' : locator.kind === 'ruffle' ? 'Ruffle 游戏画面' : locator.kind === 'canvas' ? 'Canvas 游戏画面' : '游戏画面')} ${locator.width}×${locator.height}`;
}
