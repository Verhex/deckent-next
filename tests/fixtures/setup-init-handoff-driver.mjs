// I-S3 PTY driver: bare `deckent init`'s production window (dist surfaces/core/setup) and its production composition (observation, apply
// port, I-D2's install flow), on a real pseudo-terminal, with the real SEC-1 terminal witness and a real throwaway installation (fresh
// policy). Only I-D2's host probes and `sudo` are fakes (argv[3], a script that records; a supported Ubuntu without Docker): Docker is
// never installed and the real sudo never runs. Detection is real: the fake `sudo apt-get install` puts a fake `docker` on PATH, so the
// window reopens on a fresh observation that finds it.
import { applyPolicyTemplateInstallation, inspectPolicyTemplate } from '../../dist/composition/core/installation/index.js';
import { configuredSetup, installExecutionEnvironment } from '../../dist/composition/core/setup/index.js';
import { inspectConfiguredShellRealm } from '../../dist/composition/core/agent-turn/index.js';
import { listIdentityProfiles } from '../../dist/composition/core/identity-profile/index.js';
import { configuredProjectInstructions } from '../../dist/composition/core/project-instructions/index.js';
import { setupInitCommand } from '../../dist/surfaces/core/setup/index.js';

const [root, , sudo, locale = 'en'] = process.argv.slice(2);
await applyPolicyTemplateInstallation(root, 'installation');
const host = { root, env: process.env, locale, inspectPolicyTemplate, inspectShellRealm: inspectConfiguredShellRealm, listIdentityProfiles,
  openProjectInstructions: configuredProjectInstructions };
const ports = { find: async name => `/usr/bin/${name}`, user: () => 'fake', platform: () => 'linux', exists: async () => false, reachable: async () => true,
  read: async path => path === '/etc/os-release' ? 'ID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n' : null,
  run: async file => ({ code: 0, stderr: '', stdout: file.endsWith('dpkg') ? 'amd64\n' : '' }) };
const setup = configuredSetup(host);
try {
  await setupInitCommand(['init'], { ...host, ...setup, installExecutionEnvironment: (projectRoot, scopeId, io) => installExecutionEnvironment(projectRoot, scopeId, io,
    { host: ports, install: { sudo, verify: async () => true, version: async () => '5:29.0.0-1~ubuntu.24.04~noble' } }) });
  process.stdout.write('\nDRIVER-STATUS=closed\n');
} catch (error) {
  process.stdout.write(`\nDRIVER-ERROR=${error?.code ?? error?.message}\n`);
}
