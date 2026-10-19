import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withMcpPrincipal, type DockerHostPorts, type ExecutionDetectPorts } from '#adapters/index.js';
import { installExecutionEnvironment, type ExecutionInstallDeps } from '#composition/core/setup/index.js';

// I-D2 cond. 1: the install is a person's foreground act on a real terminal. Every other caller is refused before anything is detected, staged,
// asked or run: a pipe, an AI agent, CI, a dumb terminal, a process without its own controlling terminal (agent shell, SDK) and the MCP actor.
const tty = { isTTY: true, setRawMode() { return this; }, on() { return this; }, off() { return this; } };
const person = { TERM: 'xterm-256color', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
function recording(cli: 'absent' | 'found' = 'absent') {
  const calls: string[] = [], sink: string[] = [];
  const detect: ExecutionDetectPorts = { find: async name => { calls.push(`find ${name}`); return cli === 'found' && name === 'docker' ? '/usr/bin/docker' : null; },
    run: async (file, args) => { calls.push(`run ${file} ${args.join(' ')}`); return { code: 0, stdout: '{"Client":{"Version":"29.0.0"}}', stderr: '' }; },
    realpath: async path => path, socket: async () => ({ state: 'missing', gid: null }), groups: () => [], user: () => 'alice' };
  const host: DockerHostPorts = { find: async name => `/usr/bin/${name}`, user: () => 'alice', platform: () => 'linux', exists: async () => false, reachable: async () => true,
    read: async path => { calls.push(`read ${path}`); return path === '/etc/os-release' ? 'ID=linuxmint\nID_LIKE=ubuntu\nUBUNTU_CODENAME=noble\n' : null; },
    run: async file => ({ code: 0, stdout: file.endsWith('dpkg') ? 'amd64\n' : '', stderr: '' }) };
  const deps: ExecutionInstallDeps = { witness: { attest: async () => { calls.push('witness'); return true; } }, detect, host,
    install: { sudo: '/nonexistent/fake-sudo', spawn: async (file, args) => { calls.push(`spawn ${file} ${args.join(' ')}`); return { code: 0, signal: null }; }, version: async () => null } };
  const stdout = { isTTY: true, write: (text: string) => { sink.push(text); return true; } };
  return { calls, sink, deps, io: (env: Record<string, string> = person, stdin: object = tty) => ({ locale: 'en' as const, env, stdin: stdin as never, stdout }) };
}

describe('execution-environment install: who may reach it', () => {
  it('a pipe, an AI agent, CI and a dumb terminal are refused first: nothing detected, staged, asked or run', async () => {
    for (const [env, stdin] of [[person, { isTTY: false }], [{ ...person, CLAUDECODE: '1' }, tty], [{ ...person, CODEX_SANDBOX: 'seatbelt' }, tty], [{ ...person, CI: 'true' }, tty],
      [{ ...person, TERM: 'dumb' }, tty]] as const) {
      const { calls, deps, io } = recording();
      await expect(installExecutionEnvironment('/nonexistent', 'installation', io(env, stdin), deps)).rejects.toMatchObject({ code: 'TERMINAL_TTY_REQUIRED' });
      expect(calls).toEqual([]);
    }
  });
  it('no controlling terminal of its own (agent shell, SDK, script) and the MCP actor are refused by the SEC-1 witness before detection', async () => {
    const denied = recording();
    await expect(installExecutionEnvironment('/nonexistent', 'installation', denied.io(), { ...denied.deps, witness: { attest: async () => false } }))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(denied.calls).toEqual([]);
    const mcp = recording();
    await expect(withMcpPrincipal(() => installExecutionEnvironment('/nonexistent', 'installation', mcp.io(), mcp.deps))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(mcp.calls).toEqual([]);
    // The Core witness without an override: a vitest worker has no controlling terminal of its own.
    const real = recording();
    await expect(installExecutionEnvironment('/nonexistent', 'installation', real.io(), { ...real.deps, witness: undefined } as ExecutionInstallDeps))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  });
  it('idempotent: Docker already found → nothing to do; an unsupported release only prints (nothing runs)', async () => {
    const found = recording('found');
    expect(await installExecutionEnvironment('/nonexistent', 'installation', found.io(), found.deps)).toBe('present');
    expect(found.calls.filter(call => call.startsWith('spawn') || call.startsWith('read'))).toEqual([]);
    const printed = recording();
    expect(await installExecutionEnvironment('/nonexistent', 'installation', printed.io(), printed.deps)).toBe('printed');
    expect(printed.calls.filter(call => call.startsWith('spawn'))).toEqual([]);
    expect(printed.sink.join('')).toContain('derivatives are not');
  });
  it('neither an MCP tool, an operation catalog, the SDK nor any other surface can call it (source scan)', async () => {
    const files: string[] = [];
    const walk = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path); else if (/\.(ts|tsx|json)$/.test(entry.name)) files.push(path);
    } };
    await walk('src');
    const users = async (pattern: RegExp) => (await Promise.all(files.map(async file => pattern.test(await readFile(file, 'utf8')) ? relative('src', file) : null))).filter(Boolean).sort();
    expect(await users(/installExecutionEnvironment/u)).toEqual(['composition/core/setup/index.ts', 'composition/core/setup/internal/install.ts']);
    expect(await users(/execution-environment\.install|EXECUTION_ENVIRONMENT_INSTALL\b/u)).toEqual(['adapters/core/execution-env-docker/index.ts', 'adapters/core/execution-env-docker/internal/card.ts']);
    expect(await users(/runDockerInstall/u)).toEqual(['adapters/core/execution-env-docker/index.ts', 'adapters/core/execution-env-docker/internal/install.ts', 'composition/core/setup/internal/install.ts']);
    expect(await readFile('src/index.ts', 'utf8')).not.toMatch(/composition\/core\/setup|installExecutionEnvironment|execution-env-docker/u);
  });
});
