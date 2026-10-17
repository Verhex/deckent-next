import { cpus, totalmem, freemem } from 'node:os';
import { readFileSync } from 'node:fs';
import { HOST_LIMITS_REGISTRY } from '#platform/core/common/index.js';
export interface SystemProfile { cpuCores: number; totalMemMB: number; freeMemMB: number; recommendedMaxWorkers: number }
export function suggestMaxWorkers(totalGB: number, workerMemGB = 2): number {
  if (!Number.isFinite(totalGB) || !Number.isFinite(workerMemGB) || totalGB <= 0 || workerMemGB <= 0) return 1;
  return Math.max(1, Math.min(16, Math.floor(totalGB / workerMemGB) - 1));
}
/** Both limits behind the recommended worker count: one core is left to the host, and each worker is estimated at the registry's memory. */
export interface WorkerRecommendation { readonly cpuBased: number; readonly memoryBased: number; readonly workerMemoryEstimateMB: number; readonly cap: number; readonly recommended: number }
export function describeWorkerRecommendation(freeMemMB: number, cpuCores: number, workerMemoryEstimateMB: number = HOST_LIMITS_REGISTRY.workerMemoryEstimateMB): WorkerRecommendation {
  const cap = HOST_LIMITS_REGISTRY.workerCountCap;
  if (!Number.isFinite(freeMemMB) || !Number.isFinite(cpuCores) || !Number.isFinite(workerMemoryEstimateMB) || workerMemoryEstimateMB <= 0) {
    return { cpuBased: 1, memoryBased: 1, workerMemoryEstimateMB, cap, recommended: 1 };
  }
  const cpuBased = Math.max(1, Math.floor(cpuCores) - 1), memoryBased = Math.max(1, Math.floor(freeMemMB / workerMemoryEstimateMB));
  return { cpuBased, memoryBased, workerMemoryEstimateMB, cap, recommended: Math.max(1, Math.min(memoryBased, cpuBased, cap)) };
}
export function calcRecommendedMaxWorkers(freeMemMB: number, cpuCores: number): number {
  return describeWorkerRecommendation(freeMemMB, cpuCores).recommended;
}
/** Init seed differs deliberately from the runtime free-memory recommendation. */
export function suggestMaxWorkersFromCapacity(capacity: { totalRamGB: number; cpuCores: number }): number {
  if (!Number.isFinite(capacity.totalRamGB) || !Number.isFinite(capacity.cpuCores)) return 1;
  if (capacity.totalRamGB < 4) return 1;
  if (capacity.totalRamGB < 8) return 2;
  if (capacity.totalRamGB < 16) return capacity.cpuCores >= 8 ? 4 : 3;
  return Math.min(Math.max(Math.floor(capacity.cpuCores) - 2, 2), 8);
}
export function detectHostMemory(options: { platform?: string; readMeminfo?: () => string; totalBytes?: () => number } = {}): { totalGB: number; source: 'meminfo' | 'os.totalmem' } {
  if ((options.platform ?? process.platform) === 'linux') {
    try {
      const text = (options.readMeminfo ?? (() => readFileSync('/proc/meminfo', 'utf8')))();
      const kb = Number(text.match(/^MemTotal:\s+(\d+)\s+kB/m)?.[1]);
      if (Number.isFinite(kb) && kb > 0) return { totalGB: Math.round(kb * 1024 / 1e8) / 10, source: 'meminfo' };
    } catch { /* The OS API is the documented fallback on non-proc hosts. */ }
  }
  return { totalGB: Math.round((options.totalBytes ?? totalmem)() / 1e8) / 10, source: 'os.totalmem' };
}
export function getSystemProfile(read: () => { cpuCores: number; totalBytes: number; freeBytes: number } = () => ({ cpuCores: cpus().length, totalBytes: totalmem(), freeBytes: freemem() })): SystemProfile {
  const { cpuCores, totalBytes, freeBytes } = read();
  const totalMemMB = Math.floor(totalBytes / 1024 ** 2), freeMemMB = Math.floor(freeBytes / 1024 ** 2);
  return { cpuCores, totalMemMB, freeMemMB, recommendedMaxWorkers: calcRecommendedMaxWorkers(freeMemMB, cpuCores) };
}
