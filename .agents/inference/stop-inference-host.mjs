#!/usr/bin/env node
/** Stops host inference listeners (llama-server :18080, vLLM :8000). */
import { execFileSync } from 'node:child_process';

const ports = (process.env.DECKENT_INFERENCE_PORTS ?? '18080,8000').split(',').map(value => value.trim()).filter(Boolean);

function tryFuser(port) {
  try {
    execFileSync('fuser', ['-k', `${port}/tcp`], { stdio: 'inherit' });
    process.stdout.write(`freed port ${port}\n`);
  } catch {
    process.stdout.write(`port ${port} already free\n`);
  }
}

for (const port of ports) tryFuser(port);

try {
  execFileSync('pkill', ['-f', 'llama-server.*--port'], { stdio: 'ignore' });
} catch { /* none */ }

try {
  const ids = execFileSync('docker', ['ps', '-q', '--filter', 'ancestor=vllm/vllm-openai'], { encoding: 'utf8' }).trim();
  if (ids) execFileSync('docker', ['rm', '-f', ...ids.split('\n').filter(Boolean)], { stdio: 'inherit' });
} catch { /* docker optional */ }

process.stdout.write('inference host stopped\n');
