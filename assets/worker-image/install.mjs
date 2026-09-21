import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = '/opt/deckent-worker';
const recipe = JSON.parse(readFileSync(`${root}/recipe.json`, 'utf8'));
const run = (file, args, env = process.env) => execFileSync(file, args, {
  env, encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
});
const resolved = [];
for (const provider of recipe.npmProviders) {
  const version = JSON.parse(run('npm', ['view', `${provider.package}@${provider.channel}`, 'version', '--json']));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('WORKER_VERSION_INVALID');
  run('npm', ['install', '--global', '--no-audit', '--no-fund', `${provider.package}@${version}`]);
  resolved.push({ id: provider.id, package: provider.package, version });
}
const installer = `${root}/cursor-install.sh`;
run('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '60', recipe.cursor.installer, '--output', installer]);
const installerSha256 = createHash('sha256').update(readFileSync(installer)).digest('hex');
const cursorHome = '/opt/cursor-agent';
mkdirSync(cursorHome, { recursive: true });
run('bash', [installer], { ...process.env, HOME: cursorHome });
run('chmod', ['-R', 'a+rX', cursorHome]);
for (const name of ['cursor-agent', 'agent']) symlinkSync(`${cursorHome}/.local/bin/${name}`, `/usr/local/bin/${name}`);
rmSync(installer);
writeFileSync(`${root}/installed.json`, JSON.stringify({ schemaVersion: 1, builtAt: new Date().toISOString(),
  resolved, cursorInstallerSha256: installerSha256 }, null, 2) + '\n');
run('node', [`${root}/inspect.mjs`]);
