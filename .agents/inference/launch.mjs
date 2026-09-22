#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const profilePath = process.argv[2] ?? resolve('.agents/inference/profiles/dev-5090-qwen3-next.yaml');
const dryRun = process.argv.includes('--dry-run');
const yaml = readFileSync(profilePath, 'utf8');
const modelId = yaml.match(/modelId:\s*(\S+)/)?.[1] ?? 'Qwen/Qwen3-Next-27B';
const image = yaml.match(/imageRef:\s*(\S+)/)?.[1] ?? 'vllm/vllm-openai:v0.10.2';
const maxCtx = yaml.match(/maxCtx:\s*(\d+)/)?.[1] ?? '163840';
const argv = ['run', '--rm', '-p', '8000:8000', '--gpus', 'all', image, '--model', modelId,
  '--host', '0.0.0.0', '--port', '8000', '--max-model-len', maxCtx, '--max-num-seqs', '8', '--gpu-memory-utilization', '0.92'];
process.stdout.write(`${argv.join(' ')}\n`);
if (dryRun) process.exit(0);
const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
