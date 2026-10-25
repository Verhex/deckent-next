import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
// The builder's no-network probe (bind-mounted, never part of an image): `inspect.mjs <recipe.json> <provider[,provider...]>` checks each named
// provider's `--version` and that its help still lists the recipe's required flags. Schema 3 images record each install under
// installed/<id>.json; a schema 2 image (adopted) has one installed.json for all providers.
const root = '/opt/deckent-worker';
const recipe = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const wanted = (process.argv[3] ?? '').split(',').filter(Boolean);
if (process.env.HOME) mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
const legacy = existsSync(`${root}/installed.json`) ? JSON.parse(readFileSync(`${root}/installed.json`, 'utf8')) : null;
const providers = wanted.map(id => {
  const provider = recipe.providers.find(entry => entry.id === id);
  if (!provider) throw new Error(`WORKER_CLI_INCOMPATIBLE:${id}`);
  const run = args => execFileSync(provider.command, args, {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DISABLE_AUTOUPDATER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const version = run(['--version']).trim();
  const help = run(provider.helpArgs);
  const missingFlags = provider.requiredFlags.filter(flag => !help.includes(flag));
  if (!version || missingFlags.length) throw new Error(`WORKER_CLI_INCOMPATIBLE:${provider.id}`);
  const installed = existsSync(`${root}/installed/${id}.json`) ? JSON.parse(readFileSync(`${root}/installed/${id}.json`, 'utf8')) : null;
  return { id: provider.id, version, requiredFlagsPresent: true, installation: installed };
});
console.log(JSON.stringify({ schemaVersion: 2, providers, ...(legacy ? { legacyInstallation: legacy } : {}),
  evidence: 'version-and-help-only', authenticatedExecution: 'not-tested' }));
