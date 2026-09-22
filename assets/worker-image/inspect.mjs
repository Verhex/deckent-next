import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
const root = '/opt/deckent-worker';
const recipe = JSON.parse(readFileSync(process.argv[2] ?? `${root}/recipe.json`, 'utf8'));
if (process.env.HOME) mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
const providers = [...recipe.npmProviders, recipe.cursor].map(provider => {
  const run = args => execFileSync(provider.command, args, {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DISABLE_AUTOUPDATER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const version = run(['--version']).trim();
  const help = run(provider.helpArgs);
  const missingFlags = provider.requiredFlags.filter(flag => !help.includes(flag));
  if (!version || missingFlags.length) throw new Error(`WORKER_CLI_INCOMPATIBLE:${provider.id}`);
  return { id: provider.id, version, requiredFlagsPresent: true };
});
console.log(JSON.stringify({ schemaVersion: 1, providers,
  installation: JSON.parse(readFileSync(`${root}/installed.json`, 'utf8')),
  evidence: 'version-and-help-only', authenticatedExecution: 'not-tested' }));
