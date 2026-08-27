'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, Buffer, process */

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

function standardDeviation(values, mask) {
  let count = 0; let sum = 0; let sumSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (mask && mask[index] === 0) continue;
    const value = values[index];
    count += 1; sum += value; sumSquares += value * value;
  }
  const mean = sum / Math.max(1, count);
  return Math.sqrt(Math.max(0, sumSquares / Math.max(1, count) - mean * mean));
}

function loadTemplate(cv, descriptor) {
  const existing = cache.get(descriptor.cacheKey);
  if (existing) {
    touch(descriptor.cacheKey, existing);
    return existing;
  }
  if (!descriptor.bgra) throw new Error(`template cache miss: ${descriptor.cacheKey}`);
  const bgra = cv.matFromArray(descriptor.height, descriptor.width, cv.CV_8UC4, descriptor.bgra);
  const gray = new cv.Mat();
  const pixelCount = descriptor.width * descriptor.height;
  const sourceAlpha = new Uint8Array(pixelCount);
  const alphaBytes = new Uint8Array(pixelCount);
  let transparentPixels = 0; let alphaPixels = 0;
  for (let pixel = 0, source = 3; pixel < pixelCount; pixel += 1, source += 4) {
    const value = descriptor.bgra[source];
    sourceAlpha[pixel] = value;
    if (value < 250) transparentPixels += 1;
    if (value >= 224) { alphaBytes[pixel] = 255; alphaPixels += 1; }
  }
  // Very soft or thin sprites may not contain enough nearly-opaque pixels.
  // Keep their visible core while still discarding transparent edge halos.
  if (alphaPixels < Math.max(4, Math.floor(pixelCount * 0.005))) {
    alphaPixels = 0;
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      if (sourceAlpha[pixel] >= 32) { alphaBytes[pixel] = 255; alphaPixels += 1; }
      else alphaBytes[pixel] = 0;
    }
  }
  const alpha = cv.matFromArray(descriptor.height, descriptor.width, cv.CV_8UC1, alphaBytes);
  try {
    cv.cvtColor(bgra, gray, cv.COLOR_BGRA2GRAY);
  } finally {
    bgra.delete();
  }
  const stdDev = standardDeviation(gray.data);
  const maskedStdDev = standardDeviation(gray.data, alphaBytes);
  const minimumTransparentPixels = Math.max(1, Math.floor(pixelCount * 0.005));
  const hasUsefulAlpha = transparentPixels >= minimumTransparentPixels && alphaPixels > 0 && alphaPixels < pixelCount;
  const entry = {
    gray, alpha, width: descriptor.width, height: descriptor.height, stdDev, maskedStdDev,
    alphaPixels, hasUsefulAlpha, bytes: gray.data.length + alpha.data.length,
  };
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
    let best = null;
    const requestedScales = request.options.scales;
    const oneIndex = requestedScales.indexOf(1);
    const scalePasses = oneIndex >= 0 && requestedScales.length > 1
      ? [[1], requestedScales.filter((scale) => scale !== 1)]
      : [requestedScales];
    const testedScales = [];
    for (let passIndex = 0; passIndex < scalePasses.length; passIndex += 1) {
      const pass = scalePasses[passIndex];
      testedScales.push(...pass);
      for (const descriptor of request.templates) {
        const template = loadTemplate(cv, descriptor);
        for (const scale of pass) {
          const width = Math.max(1, Math.round(template.width * scale));
          const height = Math.max(1, Math.round(template.height * scale));
          if (width > region.width || height > region.height) continue;
          const scaledGray = new cv.Mat();
          const scaledMask = new cv.Mat();
          const result = new cv.Mat();
          try {
            cv.resize(template.gray, scaledGray, new cv.Size(width, height), 0, 0, scale < 1 ? cv.INTER_AREA : cv.INTER_LINEAR);
            const maskMode = request.options.mask || 'auto';
            const masked = maskMode === 'alpha' || (maskMode === 'auto' && template.hasUsefulAlpha);
            if (masked && template.alphaPixels === 0) throw new Error(`template alpha mask is empty: ${descriptor.cacheKey}`);
            const templateStdDev = masked ? template.maskedStdDev : template.stdDev;
            const lowVariance = templateStdDev < 4;
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
                asset: descriptor.asset,
                x: location.x + region.x + (request.scene.originX || 0),
                y: location.y + region.y + (request.scene.originY || 0),
                width,
                height,
                score,
                scale,
                masked,
                lowVariance,
                templateStdDev,
              };
            }
          } finally {
            scaledGray.delete();
            scaledMask.delete();
            result.delete();
          }
        }
      }
      // Exact-scale, very-high-confidence hits are safe to accept without
      // evaluating fallback scales. Borderline hits still run every scale so
      // matching behavior remains conservative.
      if (passIndex === 0 && best && best.score >= Math.max(0.98, request.options.threshold)) break;
    }
    if (!best || best.score < request.options.threshold) return null;
    best.matchMs = Date.now() - startedAt;
    best.testedScales = testedScales;
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
    const metadata = JSON.parse(Buffer.from(sharedData.subarray(0, metadataLength)).toString('utf8'));
    const sceneStart = metadataLength;
    const templateStart = sceneStart + sceneLength;
    const request = {
      ...metadata,
      scene: { ...metadata.scene, bgra: sharedData.subarray(sceneStart, templateStart) },
      templates: metadata.templates.map((template) => ({
        ...template,
        bgra: template.byteLength > 0
          ? sharedData.subarray(templateStart + template.byteOffset, templateStart + template.byteOffset + template.byteLength)
          : undefined,
      })),
    };
    const matchStartedAt = Date.now();
    const result = match(cv, request);
    Atomics.store(control, 0, 0);
    parentPort.postMessage({
      type: 'result', id, match: result,
      stats: {
        matchMs: Date.now() - matchStartedAt,
        wasmHeapBytes: cv.HEAP8 && cv.HEAP8.buffer ? cv.HEAP8.buffer.byteLength : 0,
        templateCacheBytes: cacheBytes,
        templateCacheEntries: cache.size,
      },
    });
  } catch (error) {
    Atomics.store(control, 0, 0);
    parentPort.postMessage({ type: 'error', id, error: error && error.stack ? error.stack : String(error) });
  }
}

function start(cv) {
  parentPort.postMessage({ type: 'ready' });
  // Sleep until the main thread publishes a request. The previous 2 ms timer
  // woke this worker roughly 500 times per second even while automation was
  // idle, which wasted CPU without improving request latency.
  while (true) {
    Atomics.wait(control, 0, 0);
    poll(cv);
  }
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
