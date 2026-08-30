import type { SurfaceSpec } from './surface';

export const GAME_SURFACE_FEATURE_PREFIX = 'BFG1:';

export type GameSurfaceFeature = {
  readonly version: 1;
  readonly kind: 'flash' | 'ruffle' | 'canvas' | 'frame';
  readonly label: string;
  readonly source: string;
  readonly frameUrl: string;
  readonly width: number;
  readonly height: number;
};

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Encode(value: string): Uint8Array {
  const encoded = unescape(encodeURIComponent(value));
  return Uint8Array.from(encoded, (character) => character.charCodeAt(0));
}

function utf8Decode(value: Uint8Array): string {
  let encoded = '';
  for (const byte of value) encoded += `%${byte.toString(16).padStart(2, '0')}`;
  return decodeURIComponent(encoded);
}

function toBase64Url(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += BASE64[(value >>> 18) & 63];
    output += BASE64[(value >>> 12) & 63];
    output += second === undefined ? '=' : BASE64[(value >>> 6) & 63];
    output += third === undefined ? '=' : BASE64[value & 63];
  }
  return output.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid base64url');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const bytes: number[] = [];
  for (let index = 0; index < padded.length; index += 4) {
    const a = BASE64.indexOf(padded[index]);
    const b = BASE64.indexOf(padded[index + 1]);
    const c = padded[index + 2] === '=' ? 0 : BASE64.indexOf(padded[index + 2]);
    const d = padded[index + 3] === '=' ? 0 : BASE64.indexOf(padded[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('invalid base64url');
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((combined >>> 16) & 255);
    if (padded[index + 2] !== '=') bytes.push((combined >>> 8) & 255);
    if (padded[index + 3] !== '=') bytes.push(combined & 255);
  }
  return Uint8Array.from(bytes);
}

export function encodeGameSurfaceFeature(feature: GameSurfaceFeature): string {
  return `${GAME_SURFACE_FEATURE_PREFIX}${toBase64Url(utf8Encode(JSON.stringify(feature)))}`;
}

export function decodeGameSurfaceFeature(value: string): GameSurfaceFeature {
  const text = value.trim();
  if (!text.startsWith(GAME_SURFACE_FEATURE_PREFIX)) throw new Error('剪贴板中没有游戏画面特征码');
  let parsed: unknown;
  try { parsed = JSON.parse(utf8Decode(fromBase64Url(text.slice(GAME_SURFACE_FEATURE_PREFIX.length)))); }
  catch { throw new Error('游戏画面特征码已损坏'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('游戏画面特征码无效');
  const item = parsed as Partial<GameSurfaceFeature>;
  if (item.version !== 1 || !['flash', 'ruffle', 'canvas', 'frame'].includes(String(item.kind))
    || typeof item.width !== 'number' || item.width < 1 || typeof item.height !== 'number' || item.height < 1) {
    throw new Error('游戏画面特征码版本或内容无效');
  }
  return {
    version: 1,
    kind: item.kind as GameSurfaceFeature['kind'],
    label: String(item.label || '').slice(0, 200),
    source: String(item.source || '').slice(0, 600),
    frameUrl: String(item.frameUrl || '').slice(0, 600),
    width: Math.round(item.width),
    height: Math.round(item.height),
  };
}

export function gameSurfaceFeatureLabel(feature: GameSurfaceFeature): string {
  const fallback = feature.kind === 'flash' ? 'Flash 游戏画面'
    : feature.kind === 'ruffle' ? 'Ruffle 游戏画面'
      : feature.kind === 'canvas' ? 'Canvas 游戏画面' : '游戏区域';
  return `${feature.label || fallback} ${feature.width}×${feature.height}`;
}

export function surfaceSpecFromGameSurfaceFeature(value: string): SurfaceSpec {
  const feature = decodeGameSurfaceFeature(value);
  return { kind: 'visual', visualHint: feature.kind === 'frame' ? 'iframe' : feature.kind, fingerprint: encodeGameSurfaceFeature(feature) };
}
