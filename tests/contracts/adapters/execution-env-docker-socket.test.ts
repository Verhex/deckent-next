import { execFile } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { agentShellHardFloor, agentWorkspaceDeny, createWorkspaceScope, isWriteApprovalFloored, landlockShellSandbox, resolveShellRealm, type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapShellSandbox } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

/**
 * I-D2 cond. 5 (INIT ANALYSIS §11(c)5): the install adds the person to the `docker` group, which is root-equivalent. After that, the agent shell
 * must still not reach the Docker socket. This host is exactly that state (Docker Engine installed, this user in `docker`): the positive control
 * connects to the real `/var/run/docker.sock` outside any sandbox; every agent-shell realm (bubblewrap closed and full access, Landlock) is refused.
 * Read-only: one `GET /_ping` attempt; no container, image or Docker state is touched.
 */
const execute = promisify(execFile);
const SOCKET = '/var/run/docker.sock';
const reachable = await access(SOCKET, constants.R_OK | constants.W_OK).then(() => true, () => false);
const measured = await measureTestShellHost();
const PING = `python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.connect("${SOCKET}"); s.sendall(b"GET /_ping HTTP/1.0\\r\\nHost: d\\r\\n\\r\\n"); print("REACHED", s.recv(64))'`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function shell(provider: 'bubblewrap' | 'landlock', open: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-i-d2-sock-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), scratch = join(root, 'scratch');
  for (const path of [join(project, '.deckent'), home, scratch]) await mkdir(path, { recursive: true });
  await writeFile(join(project, '.deckent', 'config.json'), '{}\n');
  // The person's real environment shape: the default system socket, no DOCKER_HOST override (the mask must not depend on one).
  const environment: Record<string, string> = { HOME: home, PATH: '/usr/bin:/bin' };
  const product = resolveProductLayout({ projectRoot: project });
  const layout: ShellSandboxLayout = { project: await createWorkspaceScope(project, agentWorkspaceDeny(project, product, open)), scratchDir: scratch,
    writeFloor: isWriteApprovalFloored, repositoryWritable: open, hardFloor: agentShellHardFloor(project, product, [environment]) };
  const resolved = resolveShellRealm('require-sandbox', measured, [provider === 'bubblewrap' ? bubblewrapShellSandbox(layout) : landlockShellSandbox(layout)]);
  if (!resolved.ok) throw new Error(`${provider}: ${resolved.code}`);
  return resolved.realm.run({ command: PING, cwd: project, environment, fixedEnv: { TMPDIR: scratch }, timeoutMs: 10_000, writeFloorReadOnly: false, ...(open ? { open: true } : {}) });
}

describe.skipIf(process.platform !== 'linux' || !reachable)('I-D2 cond. 5: a docker group member\'s agent shell cannot reach docker.sock', () => {
  it('positive control: this user reaches the real Docker socket outside the sandbox', async () => {
    const { stdout } = await execute('python3', ['-c', `import socket; s=socket.socket(socket.AF_UNIX); s.connect("${SOCKET}"); s.sendall(b"GET /_ping HTTP/1.0\\r\\nHost: d\\r\\n\\r\\n"); print("REACHED", s.recv(64))`]);
    expect(stdout).toContain('REACHED');
  });
  for (const [provider, open] of [['bubblewrap', false], ['bubblewrap', true], ['landlock', false]] as const) {
    const available = provider === 'bubblewrap' ? measured.bubblewrap.status === 'available' : measured.landlock.status === 'available';
    it.skipIf(!available)(`${provider}${open ? ' full access' : ''}: the agent shell's connect to ${SOCKET} fails`, async () => {
      const out = await shell(provider, open);
      expect(out.status, out.output).toBe('exited');
      expect(out.exitCode, out.output).not.toBe(0);
      expect(out.output).not.toContain('REACHED');
    }, 30_000);
  }
});
