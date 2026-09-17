import { cpus, totalmem, freemem } from 'node:os';
import { readFileSync } from 'node:fs';
export interface SystemProfile { cpuCores: number; totalMemMB: number; freeMemMB: number; recommendedMaxWorkers: number }
export function suggestMaxWorkers(totalGB: number, workerMemGB = 2): number {
  if (!Number.isFinite(totalGB) || !Number.isFinite(workerMemGB) || totalGB <= 0 || workerMemGB <= 0) return 1;
  return Math.max(1, Math.min(16, Math.floor(totalGB / workerMemGB) - 1));
}
export function calcRecommendedMaxWorkers(freeMemMB: number, cpuCores: number): number {
  if (!Number.isFinite(freeMemMB) || !Number.isFinite(cpuCores)) return 1;
  return Math.max(1, Math.min(Math.floor(freeMemMB / 400), Math.floor(cpuCores) - 1, 30));
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
