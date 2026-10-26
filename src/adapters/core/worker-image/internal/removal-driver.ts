import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DockerCommandFailure, runNodeDockerCommand, type DockerCommandRunner } from '#adapters/core/docker-supervisor/index.js';
import type { WorkerRemovalDriver, WorkerRemovalObservation, WorkerRemovalResource } from './removal.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const image = z.object({ Id: z.string(), RepoTags: z.array(z.string()).nullable(), RepoDigests: z.array(z.string()).nullable() }).passthrough();
export interface WorkerReferenceOwner {
  /** The authoritative installation registry, never a list of just the current project or monitor's selected folders. */
  inventory(): Promise<{ readonly daemonId: string; readonly installationIds: readonly string[]; readonly revision: string } | null>;
  /** Complete configuration, Run/rollback retention and protected-install observations. Null means any owner was not inspected. */
  inspect(installationId: string, imageId: string): Promise<{ readonly referenced: boolean; readonly protected: boolean; readonly retained: boolean } | null>;
}
/** Every registered installation must answer against the same registry revision. Failed/partial observation can never mean unused. */
export async function observeWorkerRemovalReferences(owner: WorkerReferenceOwner, daemonId: string, imageId: string): Promise<WorkerRemovalObservation['references']> {
  const registry = await owner.inventory();
  if (!registry || registry.daemonId !== daemonId || !registry.installationIds.length
    || new Set(registry.installationIds).size !== registry.installationIds.length) return null;
  const entries = [];
  for (const installationId of registry.installationIds) {
    const observed = await owner.inspect(installationId, imageId); if (!observed) return null;
    if (observed.referenced || observed.retained || observed.protected) entries.push({ installationId, protected: observed.protected, retained: observed.retained });
  }
  const after = await owner.inventory();
  return after && JSON.stringify(after) === JSON.stringify(registry) ? entries : null;
}
export interface NativeWorkerRemovalInput {
  readonly executable: string; readonly endpoint: string; readonly timeoutMs: number; readonly outputBytes: number;
  readonly receipt: unknown; readonly recipeDigest: string | null; readonly lineageDigest: string | null;
  readonly ownedTags: readonly string[]; readonly referenceOwner: WorkerReferenceOwner;
}
/** A pinned local daemon, exact immutable IDs, bounded native reads and --no-prune removal. No tag inference or force. */
export function nativeWorkerRemovalDriver(input: NativeWorkerRemovalInput, runner: DockerCommandRunner = runNodeDockerCommand): WorkerRemovalDriver {
  // The builder's endpoint is an observed, pinned local Unix socket, never inherited DOCKER_CONTEXT or a remote daemon.
  if (!input.endpoint.startsWith('unix:///') || input.endpoint.length <= 'unix:///'.length || Array.from(input.endpoint).some(char => char.charCodeAt(0) < 32)) throw new Error('WORKER_DAEMON_CHANGED');
  const command = (args: readonly string[]) => runner({ executable: input.executable, args: ['--host', input.endpoint, ...args], timeoutMs: input.timeoutMs, outputBytes: input.outputBytes });
  return {
    async inspect(resource: WorkerRemovalResource) {
      const daemonId = (await command(['info', '--format', '{{.ID}}'])).stdout.trim();
      const all = (await command(['image', 'ls', '--all', '--no-trunc', '--quiet'])).stdout.trim().split('\n').filter(Boolean);
      if (all.some(value => !/^sha256:[a-f0-9]{64}$/u.test(value))) throw new Error('WORKER_IMAGE_CONTEXT_UNSAFE');
      const present = all.includes(resource.imageId);
      // `image inspect` errors never mean absent; listing the responding pinned daemon establishes absence.
      const inspected = present ? z.array(image).length(1).parse(JSON.parse((await command(['image', 'inspect', '--', resource.imageId])).stdout))[0]! : null;
      if (inspected && inspected.Id !== resource.imageId) throw new Error('WORKER_DAEMON_CHANGED');
      const ids = (await command(['container', 'ls', '--all', '--quiet', '--no-trunc'])).stdout.trim().split('\n').filter(Boolean), containers = [];
      for (const id of ids) {
        if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('WORKER_IMAGE_CONTEXT_UNSAFE');
        const observed = z.array(z.object({ Id: z.string(), Image: z.string() }).passthrough()).length(1)
          .parse(JSON.parse((await command(['container', 'inspect', '--', id])).stdout))[0]!;
        if (observed.Id !== id) throw new Error('WORKER_IMAGE_CONTEXT_UNSAFE');
        if (observed.Image === resource.imageId) containers.push(id);
      }
      const references = await observeWorkerRemovalReferences(input.referenceOwner, daemonId, resource.imageId);
      const foreignTags = [...(inspected?.RepoTags ?? []).filter(tag => !input.ownedTags.includes(tag)), ...(inspected?.RepoDigests ?? [])];
      const after = (await command(['info', '--format', '{{.ID}}'])).stdout.trim();
      if (daemonId !== after) throw new Error('WORKER_DAEMON_CHANGED');
      const body = { daemonId, present, receipt: input.receipt, recipeDigest: input.recipeDigest, lineageDigest: input.lineageDigest, references, containers, foreignTags };
      return { ...body, revision: hash(body) };
    },
    async remove(imageId, options) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(imageId) || options.force !== false || options.noPrune !== true) throw new Error('WORKER_IMAGE_CONTEXT_UNSAFE');
      try { await command(['image', 'rm', '--no-prune', '--', imageId]); }
      catch (error) { if (error instanceof DockerCommandFailure) throw new Error('WORKER_IMAGE_REMOVAL_UNKNOWN', { cause: error }); throw error; }
    },
  };
}
