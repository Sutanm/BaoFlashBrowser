// Main-process value namespace with atomic JSON persistence.
// Mirrors the planned src/main/modules/userscripts/userscript-store.ts.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import type { GMSerializable } from '../../../shared/userscript-types';
import { isSerializableValue, serializeValue, deserializeValue } from './userscript-values';

export interface ValueStoreOptions {
  maxValueBytes?: number;
}

export interface ValueSnapshot {
  values: Record<string, Record<string, GMSerializable>>;
  omitted: string[];
}

const DEFAULT_MAX_VALUE_BYTES = 16 * 1024;

export class ValueStore {
  private readonly data = new Map<string, Map<string, GMSerializable>>();
  private readonly maxValueBytes: number;

  constructor(options?: ValueStoreOptions) {
    this.maxValueBytes = options?.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
  }

  get(scriptId: string, key: string): GMSerializable | undefined {
    return this.data.get(scriptId)?.get(key);
  }

  set(scriptId: string, key: string, value: GMSerializable): void {
    if (!isSerializableValue(value)) throw new Error('userscript value is not JSON-serializable');
    const serialized = serializeValue(value);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxValueBytes) {
      throw new Error(`userscript value exceeds ${this.maxValueBytes} bytes`);
    }
    let bucket = this.data.get(scriptId);
    if (!bucket) {
      bucket = new Map();
      this.data.set(scriptId, bucket);
    }
    bucket.set(key, value);
  }

  delete(scriptId: string, key: string): void {
    this.data.get(scriptId)?.delete(key);
  }

  list(scriptId: string): string[] {
    return Array.from(this.data.get(scriptId)?.keys() ?? []);
  }

  snapshot(scriptIds: string[], options: { maxBytes: number }): ValueSnapshot {
    const values: Record<string, Record<string, GMSerializable>> = {};
    const omitted: string[] = [];
    let used = 0;
    for (const scriptId of scriptIds) {
      const bucket = this.data.get(scriptId);
      if (!bucket) continue;
      const scriptValues: Record<string, GMSerializable> = {};
      for (const [key, value] of bucket) {
        const serialized = serializeValue(value);
        const byteLength = Buffer.byteLength(serialized, 'utf8');
        if (used + byteLength > options.maxBytes) {
          omitted.push(`${scriptId}:${key}`);
          continue;
        }
        used += byteLength;
        scriptValues[key] = value;
      }
      if (Object.keys(scriptValues).length > 0) values[scriptId] = scriptValues;
    }
    return { values, omitted };
  }

  save(file: string): void {
    const payload: Record<string, Record<string, string>> = {};
    for (const [scriptId, bucket] of this.data) {
      const serializedBucket: Record<string, string> = {};
      for (const [key, value] of bucket) serializedBucket[key] = serializeValue(value);
      payload[scriptId] = serializedBucket;
    }
    const tmpFile = file + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(payload), { encoding: 'utf8' });
    renameSync(tmpFile, file);
  }

  load(file: string): this {
    if (!existsSync(file)) return this;
    try {
      const payload = JSON.parse(readFileSync(file, { encoding: 'utf8' })) as Record<string, Record<string, string>>;
      for (const [scriptId, bucket] of Object.entries(payload)) {
        for (const [key, serialized] of Object.entries(bucket)) {
          const value = deserializeValue(serialized);
          if (value !== undefined && isSerializableValue(value)) this.set(scriptId, key, value);
        }
      }
    } catch {
      // Corrupt or partial file: keep an empty store rather than crash.
    }
    return this;
  }
}
