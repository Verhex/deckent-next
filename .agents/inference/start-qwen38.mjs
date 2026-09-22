#!/usr/bin/env node
/**
 * Qwen3.8 Q4_K_M — varsayılan: CUDA llama-server konteyner (:18080).
 * Native (CPU) yolu: DECKENT_QWEN38_LAUNCHER=native node start-qwen38.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const model = process.env.DECKENT_QWEN38_MODEL ?? resolve(homedir(), '.local/share/local-llm/models/Qwen3.8-27B-Q4_K_M.gguf');
const modelBase = model.split('/').pop() ?? 'model.gguf';
const alias = process.env.DECKENT_QWEN38_ALIAS ?? modelBase.replace(/\.gguf$/, '');
const hostPort = process.env.DECKENT_QWEN38_PORT ?? '18080';
const containerPort = '8080';
const parallel = process.env.DECKENT_QWEN38_PARALLEL ?? '6';
const ctx = process.env.DECKENT_QWEN38_CTX ?? '65536';
const containerName = process.env.DECKENT_QWEN38_CONTAINER ?? 'deckent-qwen38-llama';
const image = process.env.DECKENT_LLAMA_CUDA_IMAGE ?? 'ghcr.io/ggml-org/llama.cpp:server-cuda';
const launcher = process.env.DECKENT_QWEN38_LAUNCHER ?? 'docker';
const dryRun = process.argv.includes('--dry-run');

async function ready() {
  try {
    const response = await fetch(`http://127.0.0.1:${hostPort}/v1/models`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

function stopDocker() {
  try { execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' }); } catch { /* absent */ }
}

function stopNative() {
  try { execFileSync('fuser', ['-k', `${hostPort}/tcp`], { stdio: 'ignore' }); } catch { /* free */ }
}

async function waitReady(timeoutMs = 600_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ready()) return true;
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

async function startDocker() {
  stopDocker();
  const modelsDir = resolve(model, '..');
  const args = [
    'run', '-d', '--rm', '--name', containerName, '--gpus', 'all',
    '-p', `127.0.0.1:${hostPort}:${containerPort}`,
    '-v', `${modelsDir}:/models:ro`,
    image,
    '-m', `/models/${modelBase}`,
    '--host', '0.0.0.0',
    '--port', containerPort,
    '-ngl', process.env.DECKENT_QWEN38_NGL ?? '999',
    '--parallel', parallel,
    '--ctx-size', ctx,
    '--alias', alias,
  ];
  process.stdout.write(`docker ${args.join(' ')}\n`);
  if (dryRun) return;
  execFileSync('docker', args, { stdio: 'inherit' });
  if (!(await waitReady())) throw new Error('QWEN38_HEALTH_TIMEOUT');
  process.stdout.write(`ready http://127.0.0.1:${hostPort}/v1 (GPU docker)\n`);
  const probe = await fetch(`http://127.0.0.1:${hostPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: alias, messages: [{ role: 'user', content: 'Reply: ready-ok' }], max_tokens: 16 }),
  });
  if (!probe.ok) {
    process.stderr.write(`chat probe failed ${probe.status} — run: node .agents/inference/probe-chat.mjs\n`);
  } else {
    process.stdout.write(`chat probe ok (POST /v1/chat/completions)\n`);
  }
  process.stdout.write(`next: ./.agents/inference/run-workline.sh\n`);
}

function startNative() {
  stopNative();
  const script = resolve(here, 'launch-qwen38-llama.mjs');
  const child = spawn(process.execPath, [script, '--force-restart'], { stdio: 'inherit', env: process.env });
  return new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolvePromise() : reject(new Error(`native launch ${code}`))));
  });
}

if (process.argv.includes('--stop')) {
  stopDocker();
  stopNative();
  process.stdout.write('stopped\n');
  process.exit(0);
}

if (await ready() && !process.argv.includes('--force-restart')) {
  process.stdout.write(`already ready http://127.0.0.1:${hostPort}/v1\n`);
  process.exit(0);
}

try {
  if (launcher === 'native') await startNative();
  else await startDocker();
} catch (error) {
  process.stderr.write(`${error}\n`);
  process.exit(1);
}
