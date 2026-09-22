#!/usr/bin/env node
/** Host smoke: pull image (optional), start vLLM, hit /v1/models, run deckent inference plan + terminal status. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const cli = resolve(root, 'dist/composition/core/cli/internal/entry.js');
const smokeEnv = {
  ...process.env,
  DECKENT_GLOBAL_HOME: resolve(root, '.deckent/host/global'),
  HOME: process.env.DECKENT_SMOKE_HOME ?? resolve(root, '.agents/inference/.smoke-home'),
  XDG_CONFIG_HOME: resolve(process.env.DECKENT_SMOKE_HOME ?? resolve(root, '.agents/inference/.smoke-home'), '.config'),
};
const yaml = readFileSync(resolve(here, 'profiles/smoke-vllm.yaml'), 'utf8');
const modelId = yaml.match(/modelId:\s*(\S+)/)?.[1] ?? 'Qwen/Qwen2.5-0.5B-Instruct';
const image = yaml.match(/imageRef:\s*(\S+)/)?.[1] ?? 'vllm/vllm-openai:v0.10.2';
const pull = process.argv.includes('--pull');
const keep = process.argv.includes('--keep');
const dryOnly = process.argv.includes('--dry-run');

async function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

async function waitHealthy(timeoutMs = 600_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:8000/v1/models');
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('vLLM health timeout');
}

let containerId = null;
async function startVllm() {
  const args = ['run', '--rm', '-d', '--gpus', 'all', '-p', '8000:8000', image, '--model', modelId,
    '--host', '0.0.0.0', '--port', '8000', '--max-model-len', '8192', '--max-num-seqs', '4', '--gpu-memory-utilization', '0.85'];
  const out = await new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', c => { buf += c; });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolvePromise(buf.trim()) : reject(new Error(`docker run ${code}`))));
  });
  containerId = out;
  process.stdout.write(`container=${containerId}\n`);
  await waitHealthy();
}

async function stopVllm() {
  if (containerId && !keep) await run('docker', ['rm', '-f', containerId]).catch(() => {});
}

process.on('SIGINT', () => { stopVllm().finally(() => process.exit(130)); });

try {
  if (pull) await run('docker', ['pull', image]);
  if (dryOnly) {
    process.stdout.write(`dry-run: docker ${['run', '--rm', '--gpus', 'all', '-p', '8000:8000', image, 'serve', modelId].join(' ')}\n`);
    process.exit(0);
  }
  await startVllm();
  const project = process.env.DECKENT_SMOKE_PROJECT ?? root;
  await run(process.execPath, [cli, 'inference', 'plan'], { cwd: project, env: smokeEnv });
  await run(process.execPath, [cli, 'terminal', 'status'], { cwd: project, env: smokeEnv });
  const chat = await fetch('http://127.0.0.1:8000/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply with exactly: smoke-ok' }], max_tokens: 16 }),
  });
  if (!chat.ok) throw new Error(`chat ${chat.status}`);
  const body = await chat.json();
  process.stdout.write(`chat: ${JSON.stringify(body.choices?.[0]?.message?.content ?? body)}\n`);
} finally {
  await stopVllm();
}
