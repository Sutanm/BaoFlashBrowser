import { app } from 'electron';
import os from 'os';
import { tabManager } from './tabs';

const SAMPLE_INTERVAL_MS = 2000;
const MAX_SAMPLES = 300;

interface MemoryAmounts {
  workingSetMiB: number;
  peakWorkingSetMiB: number;
  privateMiB: number | null;
}

export interface ProcessMemoryDiagnostic extends MemoryAmounts {
  pid: number;
  type: string;
  name: string | null;
  cpuPercent: number;
  creationTime: number;
  sandboxed: boolean;
}

export interface MemoryTrendSample {
  sampledAt: string;
  systemAvailableMiB: number;
  totalsByType: Record<string, { count: number; workingSetMiB: number; privateMiB: number; cpuPercent: number }>;
}

const samples: MemoryTrendSample[] = [];
const peaksByType = new Map<string, { workingSetMiB: number; privateMiB: number }>();
let current: ProcessMemoryDiagnostic[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

function kibToMiB(value: number | undefined): number {
  return Math.round(((value || 0) / 1024) * 100) / 100;
}

function readMetrics(): ProcessMemoryDiagnostic[] {
  return app.getAppMetrics().map((metric) => {
    const memory = metric.memory as Electron.MemoryInfo & { privateBytes?: number };
    return {
      pid: metric.pid,
      type: String(metric.type),
      name: metric.name || null,
      cpuPercent: Math.round((metric.cpu?.percentCPUUsage || 0) * 100) / 100,
      creationTime: metric.creationTime,
      sandboxed: Boolean(metric.sandboxed),
      workingSetMiB: kibToMiB(memory.workingSetSize),
      peakWorkingSetMiB: kibToMiB(memory.peakWorkingSetSize),
      privateMiB: typeof memory.privateBytes === 'number' ? kibToMiB(memory.privateBytes) : null,
    };
  });
}

function takeSample(): void {
  current = readMetrics();
  const totalsByType: MemoryTrendSample['totalsByType'] = {};
  for (const metric of current) {
    const total = totalsByType[metric.type] || { count: 0, workingSetMiB: 0, privateMiB: 0, cpuPercent: 0 };
    total.count += 1;
    total.workingSetMiB += metric.workingSetMiB;
    total.privateMiB += metric.privateMiB || 0;
    total.cpuPercent += metric.cpuPercent;
    totalsByType[metric.type] = total;
  }
  for (const [type, total] of Object.entries(totalsByType)) {
    total.workingSetMiB = Math.round(total.workingSetMiB * 100) / 100;
    total.privateMiB = Math.round(total.privateMiB * 100) / 100;
    total.cpuPercent = Math.round(total.cpuPercent * 100) / 100;
    const peak = peaksByType.get(type) || { workingSetMiB: 0, privateMiB: 0 };
    peak.workingSetMiB = Math.max(peak.workingSetMiB, total.workingSetMiB);
    peak.privateMiB = Math.max(peak.privateMiB, total.privateMiB);
    peaksByType.set(type, peak);
  }
  samples.push({
    sampledAt: new Date().toISOString(),
    systemAvailableMiB: Math.round(os.freemem() / 1024 / 1024),
    totalsByType,
  });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export function startMemoryMonitor(): void {
  if (timer) return;
  takeSample();
  timer = setInterval(takeSample, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

export function stopMemoryMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function getMemoryDiagnostics(): Record<string, unknown> {
  takeSample();
  const processByPid = new Map(current.map((metric) => [metric.pid, metric]));
  return {
    current,
    peaksByType: Object.fromEntries(peaksByType),
    samples: [...samples],
    tabs: tabManager.getMemoryDiagnostics().map((tab) => ({
      ...tab,
      process: processByPid.get(tab.pid) || null,
    })),
    systemAvailableMiB: Math.round(os.freemem() / 1024 / 1024),
  };
}
