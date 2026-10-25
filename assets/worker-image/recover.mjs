import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
const [context, daemonId] = process.argv.slice(2);
const fail = () => { throw new Error('WORKER_IMAGE_BUILD_INTERRUPTED'); };
if (!isAbsolute(context) || !daemonId) fail();
const plan = JSON.parse(readFileSync(join(context, 'plan.json'), 'utf8'));
if (!/^[a-f0-9-]{36}$/.test(plan.probeOwner ?? '')) fail();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(key)));
const run = args => {
  const result = spawnSync('docker', args, { env, timeout: 5000, encoding: 'utf8', maxBuffer: 65536 });
  if (result.error || result.status !== 0) fail(); return result.stdout.trim();
};
const endpoint = JSON.parse(run(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']));
const docker = args => run(['--host', endpoint, ...args]);
if (docker(['info', '--format', '{{.ID}}']) !== daemonId) fail();
for (const name of readdirSync(context).filter(name => /^probe-\d+\.cid$/.test(name))) {
  const file = join(context, name), info = lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > 128) fail();
  const id = readFileSync(file, 'utf8').trim(); if (!/^[a-f0-9]{64}$/.test(id)) fail();
  // Listing exact ids distinguishes an already removed probe from an unavailable inspection.
  if (!docker(['ps', '-a', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}']).split('\n').includes(id)) continue;
  if (docker(['container', 'inspect', id, '--format', '{{index .Config.Labels "dev.deckent.worker.probe"}}']) !== plan.probeOwner) fail();
  docker(['rm', '--force', id]);
}
