import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeArchitecture } from './architecture-check.mjs';

const rootArg = process.argv.indexOf('--root');
const root = rootArg > -1 && process.argv[rootArg + 1] ? resolve(process.argv[rootArg + 1]) : dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv.includes('--hardcode-inventory') ? 'hardcode-inventory' : process.argv.includes('--hardcode-only') ? 'hardcode-only' : 'full';
const result = analyzeArchitecture(root, { mode, today: process.env.DECKENT_DEPS_TODAY });
// POSIX pipes are asynchronous: do not terminate before the complete report drains.
await new Promise((resolve, reject) => process.stdout.write(result.out, error => error ? reject(error) : resolve()));
process.exitCode = result.code;
