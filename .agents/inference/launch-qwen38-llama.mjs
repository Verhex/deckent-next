#!/usr/bin/env node
/** Host llama-server for Qwen3.8 GGUF (OpenAI /v1 on 18080 — avoids Apache :8080). */
import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const model = process.env.DECKENT_QWEN38_MODEL ?? resolve(homedir(), '.local/share/local-llm/models/Qwen3.8-27B-Q4_K_M.gguf');
const alias = process.env.DECKENT_QWEN38_ALIAS ?? 'Qwen3.8-27B-Q4_K_M';
const port = process.env.DECKENT_QWEN38_PORT ?? '18080';
const parallel = process.env.DECKENT_QWEN38_PARALLEL ?? '6';
const ctx = process.env.DECKENT_QWEN38_CTX ?? '131072';
const server = process.env.DECKENT_LLAMA_SERVER ?? '/usr/local/lib/ollama/llama-server';
const dryRun = process.argv.includes('--dry-run');
const forceRestart = process.argv.includes('--force-restart');

const args = [
  '--model', model,
  '--host', '127.0.0.1',
  '--port', port,
  '--ctx-size', ctx,
  '--parallel', parallel,
  '--alias', alias,
  '--jinja',
  '--gpu-layers', process.env.DECKENT_QWEN38_GPU_LAYERS ?? '999',
];

async function endpointReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

function stopListenerOnPort() {
  try {
    execFileSync('fuser', [`${port}/tcp`], { stdio: 'pipe' });
    execFileSync('fuser', ['-k', `${port}/tcp`], { stdio: 'inherit' });
  } catch {
    process.stderr.write(`port ${port} busy but fuser could not free it — stop the old llama-server manually\n`);
    process.exit(1);
  }
}

process.stdout.write(`${server} ${args.join(' ')}\n`);
if (dryRun) process.exit(0);

if (await endpointReady() && !forceRestart) {
  process.stdout.write(`llama-server already serving http://127.0.0.1:${port}/v1 — nothing to do (use --force-restart to replace)\n`);
  process.exit(0);
}

if (forceRestart) stopListenerOnPort();

const lib = resolve(server, '..');
const child = spawn(server, args, {
  stdio: 'inherit',
  env: { ...process.env, LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
});
child.on('exit', code => {
  if (code !== 0) {
    process.stderr.write(`hint: port ${port} may still be held — run: fuser -k ${port}/tcp\n`);
  }
  process.exit(code ?? 1);
});
