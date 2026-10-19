// I-D2 PTY driver: the production install flow (dist) on a real pseudo-terminal, with the real SEC-1 terminal witness, a real throwaway
// installation (fresh v13 policy) and the real foreground spawn, but a FAKE sudo (argv[3], a script that only records) and fake detection
// and host probes (a supported Ubuntu without Docker). Docker is never installed and the real sudo is never run.
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { applyPolicyTemplateInstallation } from '../../dist/composition/core/installation/index.js';
import { installExecutionEnvironment } from '../../dist/composition/core/setup/index.js';

const [root, work, sudo, locale = 'en'] = process.argv.slice(2);
const installed = () => access(join(work, 'INSTALLED')).then(() => true, () => false);
await applyPolicyTemplateInstallation(root, 'installation');
const detect = { find: async name => name === 'docker' && await installed() ? '/usr/bin/docker' : null, realpath: async path => path, groups: () => [], user: () => 'fake',
  socket: async () => ({ state: 'accessible', gid: 0 }),
  run: async (_file, args) => ({ code: 0, stderr: '', stdout: args[0] === 'version' ? '{"Client":{"Version":"29.0.0"},"Server":{"Version":"29.0.0"}}'
    : args[0] === 'context' ? '{"Host":"unix:///var/run/docker.sock"}' : '{"OperatingSystem":"Ubuntu 24.04"}' }) };
const host = { find: async name => `/usr/bin/${name}`, user: () => 'fake', platform: () => 'linux', exists: async () => false, reachable: async () => true,
  read: async path => path === '/etc/os-release' ? 'ID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n' : null,
  run: async file => ({ code: 0, stderr: '', stdout: file.endsWith('dpkg') ? 'amd64\n' : '' }) };
try {
  const status = await installExecutionEnvironment(root, 'installation', { locale, stdin: process.stdin, stdout: process.stdout, env: process.env },
    { detect, host, install: { sudo, version: async () => await installed() ? '5:29.0.0-1~ubuntu.24.04~noble' : null } });
  process.stdout.write(`\nDRIVER-STATUS=${status}\n`);
} catch (error) {
  process.stdout.write(`\nDRIVER-ERROR=${error?.code ?? error?.message}\n`);
}
