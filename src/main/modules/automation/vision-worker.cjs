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
let retainedScene = null;

function destroy(entry) {
  for (const scaled of entry.scaled.values()) {
    scaled.gray.delete();
    scaled.alpha.delete();
  }
  entry.scaled.clear();
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

function hasCacheRoom(additionalBytes) {
  return additionalBytes <= maxCacheBytes && cacheBytes + additionalBytes <= maxCacheBytes;
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
    alphaPixels, hasUsefulAlpha, scaled: new Map(), bytes: gray.data.length + alpha.data.length,
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

function scaledTemplate(cv, template, scale, timings) {
  if (scale === 1) return { gray: template.gray, alpha: template.alpha, ephemeral: false };
  const scaleKey = String(scale);
  const existing = template.scaled.get(scaleKey);
  if (existing) {
    timings.scaledTemplateCacheHits += 1;
    return { ...existing, ephemeral: false };
  }
  timings.scaledTemplateCacheMisses += 1;
  const width = Math.max(1, Math.round(template.width * scale));
  const height = Math.max(1, Math.round(template.height * scale));
  const gray = new cv.Mat();
  const alpha = new cv.Mat();
  const resizeStartedAt = Date.now();
  cv.resize(template.gray, gray, new cv.Size(width, height), 0, 0, scale < 1 ? cv.INTER_AREA : cv.INTER_LINEAR);
  cv.resize(template.alpha, alpha, new cv.Size(width, height), 0, 0, cv.INTER_NEAREST);
  timings.resizeMs += Date.now() - resizeStartedAt;
  const bytes = gray.data.length + alpha.data.length;
  if (!hasCacheRoom(bytes)) return { gray, alpha, ephemeral: true };
  const scaled = { gray, alpha, bytes };
  template.scaled.set(scaleKey, scaled);
  template.bytes += bytes;
  cacheBytes += bytes;
  return { ...scaled, ephemeral: false };
}

function match(cv, request) {
  const startedAt = Date.now();
  const timings = {
    sceneMatMs: 0, grayMs: 0, resizeMs: 0, matchTemplateMs: 0,
    scaledTemplateCacheHits: 0, scaledTemplateCacheMisses: 0,
  };
  let sceneGray;
  if (request.scene.reuse) {
    if (!retainedScene || retainedScene.frameId !== request.scene.frameId
      || retainedScene.width !== request.scene.width || retainedScene.height !== request.scene.height) {
      throw new Error(`captured frame cache miss: ${request.scene.frameId}`);
    }
    sceneGray = retainedScene.gray;
  } else {
    const sceneMatStartedAt = Date.now();
    const sceneBgra = cv.matFromArray(request.scene.height, request.scene.width, cv.CV_8UC4, request.scene.bgra);
    timings.sceneMatMs += Date.now() - sceneMatStartedAt;
    const nextGray = new cv.Mat();
    try {
      const grayStartedAt = Date.now();
      cv.cvtColor(sceneBgra, nextGray, cv.COLOR_BGRA2GRAY);
      timings.grayMs += Date.now() - grayStartedAt;
    } catch (error) {
      nextGray.delete();
      throw error;
    } finally {
      sceneBgra.delete();
    }
    if (retainedScene) retainedScene.gray.delete();
    retainedScene = {
      frameId: request.scene.frameId,
      width: request.scene.width,
      height: request.scene.height,
      gray: nextGray,
    };
    sceneGray = nextGray;
  }
  let roi = null;
  try {
    const region = request.options.region || { x: 0, y: 0, width: request.scene.width, height: request.scene.height };
    roi = sceneGray.roi(new cv.Rect(region.x, region.y, region.width, region.height));
    let best = null;
    const requestedScales = request.options.scales;
    const oneIndex = requestedScales.indexOf(1);
    const scalePasses = oneIndex >= 0 && requestedScales.length > 1
      ? [[1], requestedScales.filter((scale) => scale !== 1)]
      : [requestedScales];
    const testedScales = [];
    let usableCandidateCount = 0;
    for (let passIndex = 0; passIndex < scalePasses.length; passIndex += 1) {
      const pass = scalePasses[passIndex];
      testedScales.push(...pass);
      for (const descriptor of request.templates) {
        const template = loadTemplate(cv, descriptor);
        for (const scale of pass) {
          const width = Math.max(1, Math.round(template.width * scale));
          const height = Math.max(1, Math.round(template.height * scale));
          if (width > region.width || height > region.height) continue;
          usableCandidateCount += 1;
          const scaled = scaledTemplate(cv, template, scale, timings);
          const result = new cv.Mat();
          try {
            const maskMode = request.options.mask || 'auto';
            const masked = maskMode === 'alpha' || (maskMode === 'auto' && template.hasUsefulAlpha);
            if (masked && template.alphaPixels === 0) throw new Error(`template alpha mask is empty: ${descriptor.cacheKey}`);
            const templateStdDev = masked ? template.maskedStdDev : template.stdDev;
            const lowVariance = templateStdDev < 4;
            const method = masked ? cv.TM_CCORR_NORMED : lowVariance ? cv.TM_SQDIFF_NORMED : cv.TM_CCOEFF_NORMED;
            const matchTemplateStartedAt = Date.now();
            if (masked) {
              cv.matchTemplate(roi, scaled.gray, result, method, scaled.alpha);
            } else {
              cv.matchTemplate(roi, scaled.gray, result, method);
            }
            timings.matchTemplateMs += Date.now() - matchTemplateStartedAt;
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
            if (scaled.ephemeral) {
              scaled.gray.delete();
              scaled.alpha.delete();
            }
            result.delete();
          }
        }
      }
      // Exact-scale, very-high-confidence hits are safe to accept without
      // evaluating fallback scales. Borderline hits still run every scale so
      // matching behavior remains conservative.
      if (passIndex === 0 && best && best.score >= Math.max(0.98, request.options.threshold)) break;
    }
    if (usableCandidateCount === 0) {
      // A narrow ROI is a normal no-match condition. It can happen when the
      // user reuses a large material in a smaller fast-search area; do not
      // abort the entire workflow or its wait loop for that case.
      return { match: null, stats: { ...timings, matchMs: Date.now() - startedAt } };
    }
    if (!best || best.score < request.options.threshold) return { match: null, stats: { ...timings, matchMs: Date.now() - startedAt } };
    best.matchMs = Date.now() - startedAt;
    best.testedScales = testedScales;
    return { match: best, stats: { ...timings, matchMs: best.matchMs } };
  } finally {
    if (roi) roi.delete();
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
      type: 'result', id, match: result.match,
      stats: {
        ...result.stats,
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
  // Electron 11's old Node runtime can occasionally miss a notify after this
  // worker has slept for a while. A short timeout bounds that cold-idle delay
  // while still reducing idle wakeups from roughly 500/s to at most 20/s.
  while (true) {
    Atomics.wait(control, 0, 0, 50);
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
  if (retainedScene) retainedScene.gray.delete();
  retainedScene = null;
  for (const entry of cache.values()) destroy(entry);
  cache.clear();
});
