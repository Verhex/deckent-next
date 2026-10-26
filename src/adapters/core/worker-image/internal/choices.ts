import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ErrorRegistry } from '#platform/index.js';
import { layeredWorkerRecipeSchema } from '#engine/index.js';
import { runNodeProcess } from '#adapters/core/process-runner/index.js';
import type { WorkerImageBuildRunner } from './build.js';
import { readWorkerImageSources, privateDirectory } from './build.js';
import limits from './limits.json' with { type: 'json' };
export type WorkerImageChoice = Readonly<{ imageId: string; tag: string; ready: boolean }>;
const lineageSchema = z.object({ recipes: z.array(z.object({ sha256: z.string(), version: z.string(), providers: z.array(z.string()) })) });
const imageSchema = z.object({ Id: z.string().regex(/^sha256:[a-f0-9]{64}$/u), Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }) });
/** Daemon-pinned, bounded choice discovery. A ready label requires shipped lineage and a fresh no-network flags probe. */
export async function inspectWorkerImageChoices(input: { packageRoot: string; home: string; executable: string | null; provider: string;
  env: Readonly<Record<string, string | undefined>> }, runner: WorkerImageBuildRunner = runNodeProcess): Promise<readonly WorkerImageChoice[]> {
  if (!input.executable) return [];
  const sources = await readWorkerImageSources(input.packageRoot), recipe = layeredWorkerRecipeSchema.parse(sources.recipe);
  if (!recipe.providers.some(row => row.id === input.provider)) throw ErrorRegistry.createError('WORKER_PLAN_INVALID');
  const directory = sources.directory, bytes = await readFile(join(directory, 'lineage.json'));
  const lock = JSON.parse(await readFile(join(directory, 'lineage.lock.json'), 'utf8')) as { sha256: string };
  if (createHash('sha256').update(bytes).digest('hex') !== lock.sha256) throw ErrorRegistry.createError('WORKER_LINEAGE_INVALID');
  const lineage = lineageSchema.parse(JSON.parse(bytes.toString('utf8')));
  const env = Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'
    && ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(entry[0])));
  const command = async (args: string[]) => {
    const result = await runner({ schemaVersion: 1, requestId: randomUUID(), executable: input.executable!, args, cwd: directory, env,
      timeoutMs: limits.probeTimeoutMs, outputBytes: limits.probeOutputBytes });
    if (result.reason !== 'exit' || result.exitCode !== 0 || result.stdoutTruncated) throw ErrorRegistry.createError('WORKER_IMAGE_DOCKER_WAITING');
    return Buffer.from(result.stdoutBase64, 'base64').toString('utf8').trim();
  };
  const endpoint = z.string().min(1).parse(JSON.parse(await command(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])));
  if (!endpoint.startsWith('unix:///') || endpoint.includes('\0')) throw ErrorRegistry.createError('WORKER_IMAGE_DOCKER_WAITING');
  // Explicit endpoint and no conflicting inherited context/TLS selectors, as in the builder.
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
  const docker = (args: string[]) => command(['--host', endpoint, ...args]);
  const daemon = await docker(['info', '--format', '{{.ID}}']);
  const tags = (await docker(['image', 'ls', recipe.repository, '--no-trunc', '--format', '{{json .}}'])).split('\n').filter(Boolean).slice(0, limits.candidateImages);
  const cleanup = async (owner: string, context: string) => {
    // The unique owner label also reconciles a timeout before Docker wrote its cidfile.
    const held = (await docker(['ps', '-aq', '--no-trunc', '--filter', `label=dev.deckent.worker.probe=${owner}`])).split('\n').filter(Boolean);
    for (const id of held) {
      if (!/^[a-f0-9]{64}$/u.test(id)) throw ErrorRegistry.createError('WORKER_IMAGE_CONTEXT_UNSAFE');
      await docker(['rm', '--force', id]);
    }
    await rm(context, { recursive: true, force: true });
  };
  const choices: WorkerImageChoice[] = [];
  for (const raw of tags) {
    const row = z.object({ ID: z.string().regex(/^sha256:[a-f0-9]{64}$/u), Repository: z.literal(recipe.repository), Tag: z.string().max(128) }).parse(JSON.parse(raw));
    if (choices.some(choice => choice.imageId === row.ID)) continue;
    const image = imageSchema.parse(JSON.parse(await docker(['image', 'inspect', row.ID]))[0]);
    if (image.Id !== row.ID) throw ErrorRegistry.createError('WORKER_IMAGE_ID_MISMATCH');
    const labels = image.Config.Labels ?? {}, named = (labels['dev.deckent.worker.provider'] ?? '').split(',').filter(Boolean);
    if (named.length && !named.includes(input.provider)) continue;
    const matched = named.includes(input.provider) && new Set(named).size === named.length && lineage.recipes.some(entry => entry.sha256 === labels['dev.deckent.worker.recipe.sha256']
      && entry.version === labels['org.opencontainers.image.version'] && named.every(id => entry.providers.includes(id)));
    let ready = false;
    if (matched) {
      const parent = join(input.home, 'previews'); await mkdir(parent, { recursive: true, mode: 0o700 }); await privateDirectory(parent);
      const context = await mkdtemp(join(parent, 'probe-')), cidfile = join(context, 'probe.cid'), owner = randomUUID(); await privateDirectory(context);
      try {
        const manifest = JSON.parse(await docker(['run', '--rm', '--label', `dev.deckent.worker.probe=${owner}`, '--cidfile', cidfile,
          '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
          '--memory=1g', '--memory-swap=1g', '--cpus=2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456',
          '--mount', `type=bind,src=${join(directory, 'inspect.mjs')},dst=/run/deckent-inspect.mjs,readonly`,
          '--mount', `type=bind,src=${join(directory, 'recipe.json')},dst=/run/deckent-recipe.json,readonly`,
          '--entrypoint', 'node', row.ID, '/run/deckent-inspect.mjs', '/run/deckent-recipe.json', input.provider])) as { providers?: { id: string; requiredFlagsPresent: boolean }[] };
        ready = manifest.providers?.some(entry => entry.id === input.provider && entry.requiredFlagsPresent === true) === true;
      } catch { /* No ready claim without fresh flags evidence. */ }
      finally {
        await cleanup(owner, context);
      }
    }
    choices.push({ imageId: row.ID, tag: `${row.Repository}:${row.Tag}`, ready });
  }
  if (!daemon || await docker(['info', '--format', '{{.ID}}']) !== daemon) throw ErrorRegistry.createError('WORKER_DAEMON_CHANGED');
  return choices.sort((a, b) => Number(b.ready) - Number(a.ready));
}
