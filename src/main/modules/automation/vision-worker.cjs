'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, Buffer, setInterval, process */

const { parentPort, workerData } = require('worker_threads');
const cvModule = require('@techstark/opencv-js');

const maxCacheEntries = Number(workerData && workerData.maxCacheEntries) || 64;
const maxCacheBytes = Number(workerData && workerData.maxCacheBytes) || 128 * 1024 * 1024;
const control = new Int32Array(workerData.controlBuffer);
const sharedData = new Uint8Array(workerData.dataBuffer);
const cache = new Map();
let cacheBytes = 0;

function destroy(entry) {
  entry.gray.delete();
  entry.alpha.delete();
  cacheBytes -= entry.bytes;
}

function touch(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
}

function trimCache() {
  while (cache.size > maxCacheEntries || cacheBytes > maxCacheBytes) {
    const oldest = cache.entries().next().value;
    if (!oldest) break;
    cache.delete(oldest[0]);
    destroy(oldest[1]);
  }
}

function loadTemplate(cv, request) {
  const descriptor = request.template;
  const existing = cache.get(descriptor.cacheKey);
  if (existing) {
    touch(descriptor.cacheKey, existing);
    return existing;
  }
  if (!descriptor.bgra) throw new Error(`template cache miss: ${descriptor.cacheKey}`);
  const bgra = cv.matFromArray(descriptor.height, descriptor.width, cv.CV_8UC4, descriptor.bgra);
  const gray = new cv.Mat();
  const alphaBytes = new Uint8Array(descriptor.width * descriptor.height);
  for (let pixel = 0, source = 3; pixel < alphaBytes.length; pixel += 1, source += 4) alphaBytes[pixel] = descriptor.bgra[source];
  const alpha = cv.matFromArray(descriptor.height, descriptor.width, cv.CV_8UC1, alphaBytes);
  try {
    cv.cvtColor(bgra, gray, cv.COLOR_BGRA2GRAY);
  } finally {
    bgra.delete();
  }
  let sum = 0; let sumSquares = 0;
  for (const value of gray.data) { sum += value; sumSquares += value * value; }
  const mean = sum / Math.max(1, gray.data.length);
  const stdDev = Math.sqrt(Math.max(0, sumSquares / Math.max(1, gray.data.length) - mean * mean));
  const entry = { gray, alpha, width: descriptor.width, height: descriptor.height, stdDev, bytes: gray.data.length + alpha.data.length };
  if (entry.bytes > maxCacheBytes) {
    gray.delete();
    alpha.delete();
    throw new Error(`template exceeds worker cache budget: ${descriptor.cacheKey}`);
  }
  cache.set(descriptor.cacheKey, entry);
  cacheBytes += entry.bytes;
  trimCache();
  return entry;
}

function match(cv, request) {
  const startedAt = Date.now();
  const sceneBgra = cv.matFromArray(request.scene.height, request.scene.width, cv.CV_8UC4, request.scene.bgra);
  const sceneGray = new cv.Mat();
  let roi = null;
  try {
    cv.cvtColor(sceneBgra, sceneGray, cv.COLOR_BGRA2GRAY);
    const region = request.options.region || { x: 0, y: 0, width: request.scene.width, height: request.scene.height };
    roi = sceneGray.roi(new cv.Rect(region.x, region.y, region.width, region.height));
    const template = loadTemplate(cv, request);
    let best = null;
    for (const scale of request.options.scales) {
      const width = Math.max(1, Math.round(template.width * scale));
      const height = Math.max(1, Math.round(template.height * scale));
      if (width > region.width || height > region.height) continue;
      const scaledGray = new cv.Mat();
      const scaledMask = new cv.Mat();
      const result = new cv.Mat();
      try {
        cv.resize(template.gray, scaledGray, new cv.Size(width, height), 0, 0, scale < 1 ? cv.INTER_AREA : cv.INTER_LINEAR);
        const masked = request.options.mask === 'alpha';
        const lowVariance = template.stdDev < 4;
        const method = masked ? cv.TM_CCORR_NORMED : lowVariance ? cv.TM_SQDIFF_NORMED : cv.TM_CCOEFF_NORMED;
        if (masked) {
          cv.resize(template.alpha, scaledMask, new cv.Size(width, height), 0, 0, cv.INTER_NEAREST);
          cv.matchTemplate(roi, scaledGray, result, method, scaledMask);
        } else {
          cv.matchTemplate(roi, scaledGray, result, method);
        }
        const located = cv.minMaxLoc(result);
        const score = method === cv.TM_SQDIFF_NORMED ? 1 - located.minVal : located.maxVal;
        const location = method === cv.TM_SQDIFF_NORMED ? located.minLoc : located.maxLoc;
        if (Number.isFinite(score) && (!best || score > best.score)) {
          best = {
            x: location.x + region.x,
            y: location.y + region.y,
            width,
            height,
            score,
            scale,
            masked,
            lowVariance,
            templateStdDev: template.stdDev,
          };
        }
      } finally {
        scaledGray.delete();
        scaledMask.delete();
        result.delete();
      }
    }
    if (!best || best.score < request.options.threshold) return null;
    best.matchMs = Date.now() - startedAt;
    return best;
  } finally {
    if (roi) roi.delete();
    sceneGray.delete();
    sceneBgra.delete();
  }
}

function poll(cv) {
  if (Atomics.compareExchange(control, 0, 1, 4) !== 1) return;
  const id = Atomics.load(control, 1);
  try {
    const metadataLength = Atomics.load(control, 2);
    const sceneLength = Atomics.load(control, 3);
    const templateLength = Atomics.load(control, 4);
    const metadata = JSON.parse(Buffer.from(sharedData.subarray(0, metadataLength)).toString('utf8'));
    const sceneStart = metadataLength;
    const templateStart = sceneStart + sceneLength;
    const request = {
      ...metadata,
      scene: { ...metadata.scene, bgra: sharedData.subarray(sceneStart, templateStart) },
      template: {
        ...metadata.template,
        bgra: templateLength > 0 ? sharedData.subarray(templateStart, templateStart + templateLength) : undefined,
      },
    };
    const result = match(cv, request);
    Atomics.store(control, 0, 0);
    parentPort.postMessage({ type: 'result', id, match: result });
  } catch (error) {
    Atomics.store(control, 0, 0);
    parentPort.postMessage({ type: 'error', id, error: error && error.stack ? error.stack : String(error) });
  }
}

function start(cv) {
  parentPort.postMessage({ type: 'ready' });
  setInterval(() => poll(cv), 2);
}

try {
  if (typeof cvModule.then === 'function') cvModule.then(() => start(cvModule));
  else start(cvModule);
} catch (error) {
  parentPort.postMessage({ type: 'startup-error', error: error && error.stack ? error.stack : String(error) });
}

process.on('exit', () => {
  for (const entry of cache.values()) destroy(entry);
  cache.clear();
});
