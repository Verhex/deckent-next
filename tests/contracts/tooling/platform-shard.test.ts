import { describe, expect, it } from 'vitest';
// @ts-expect-error Executable JS tooling has no declaration file.
import { runShard, shardPlan } from '../../../scripts/platform-shard.mjs';

type Step = { name: string; command: string; args: string[]; stopOnFailure?: boolean };
describe('platform verification shard (PLATFORM-TEMIZLIK)', () => {
  it('keeps every check of npm run verify: each shard builds and runs its Vitest quarter, shard 1 alone runs the non-Vitest checks', () => {
    const verify = ['verify-context', 'build', 'native test variants'];
    expect((shardPlan(1, 4, 'darwin') as Step[]).map(step => step.name)).toEqual([...verify, 'vitest shard 1/4', 'lint:checks', 'test:native', 'test:host', 'smoke']);
    // The host tooling (.agents/refactor) is Linux/WSL-only; Windows reports it as not run rather than failing on POSIX paths.
    expect((shardPlan(1, 4, 'win32') as Step[]).map(step => step.name)).toEqual([...verify, 'vitest shard 1/4', 'lint:checks', 'test:native', 'smoke']);
    for (const index of [2, 3, 4]) expect((shardPlan(index, 4) as Step[]).map(step => step.name)).toEqual([...verify, `vitest shard ${index}/4`]);
    expect((shardPlan(3, 4) as Step[]).find(step => step.name.startsWith('vitest'))!.args).toEqual(['node_modules/vitest/vitest.mjs', 'run', '--shard', '3/4']);
    for (const bad of [[0, 4], [5, 4], [1, 0], [Number.NaN, 4]]) expect(() => shardPlan(bad[0], bad[1])).toThrow('invalid shard');
  });
  it('stops after a failed build but keeps running independent checks after a failed test step; the first failure is the exit code', () => {
    const run = (failing: Record<string, number>) => {
      const seen: string[] = [];
      const result = runShard(shardPlan(1, 4, 'linux'), (step: Step) => { seen.push(step.name); return failing[step.name] ?? 0; });
      return { seen, ...result };
    };
    expect(run({}).exitCode).toBe(0);
    const buildFailed = run({ build: 2 });
    expect(buildFailed.seen).toEqual(['verify-context', 'build']); expect(buildFailed.exitCode).toBe(2);
    const testsFailed = run({ 'vitest shard 1/4': 1, 'test:host': 7 });
    expect(testsFailed.seen).toHaveLength(8); expect(testsFailed.exitCode).toBe(1);
    expect(testsFailed.outcomes.filter((item: { status: number }) => item.status !== 0).map((item: { name: string }) => item.name)).toEqual(['vitest shard 1/4', 'test:host']);
  });
});
