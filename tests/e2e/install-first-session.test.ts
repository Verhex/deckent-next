import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, lstat, chmod, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { personEnv } from '../contracts/support/person-env.js';
import { CURRENT_LEDGER_VERSION } from '#adapters/index.js';
import { configuredProjectInstructions } from '#composition/core/project-instructions/index.js';
import { lastJson, runInTerminal, type TerminalAnswer } from '../contracts/support/terminal-cli.js';

const binary = fileURLToPath(new URL('../../dist/composition/core/cli/internal/entry.js', import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform !== 'linux')('ATTACH review F1 (verify-not-run outside Linux): bare init hands over the terminal for one permission answer; yes continues, no writes nothing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dk-guided-permission-')); roots.push(base);
  const question = 'Others can write to this folder; narrow the permission?';
  for (const answer of ['yes', 'no'] as const) {
    const project = join(base, answer), home = join(base, `${answer}-home`), global = join(base, `${answer}-global`);
    for (const path of [project, home, global]) await mkdir(path, { mode: 0o700 });
    await chmod(project, 0o775);
    const env = personEnv({ PATH: process.env['PATH'], HOME: home, DECKENT_GLOBAL_HOME: global, NO_COLOR: '1', TERM: 'xterm', DECKENT_LANGUAGE: 'en', DOCKER_HOST: 'unix:///nonexistent/docker.sock' });
    // Setup's instruction reader seals its legacy trust snapshot before asking anything (observe.ts). Keep that security behaviour,
    // then prove a declined permission answer changes none of the existing store, rather than claiming setup never opened the reader.
    if (answer === 'no') await configuredProjectInstructions(project, { env });
    const globalSnapshot = async () => {
      const files: Record<string, string | number> = {};
      for (const path of ['', ...await readdir(global, { recursive: true })]) {
        const info = await lstat(join(global, path)); files[`${path}:mode`] = info.mode;
        if (info.isFile()) files[path] = (await readFile(join(global, path))).toString('base64');
      }
      return files;
    };
    const before = await globalSnapshot();
    const result = await runInTerminal([process.execPath, binary, 'init'], project, env, [
      { when: '> 1. Language', ready: 'Enter confirm', send: '\r' }, { when: '> 3. Folder', ready: 'Enter confirm', send: '\r' }, { when: '> 5. Who uses', ready: 'Enter confirm', send: '\r' },
      { when: 'No (n)', ready: 'Enter confirm', send: 'y' }, { when: 'Apply now (y)', ready: 'Enter confirm', send: 'y' },
      { when: question, ready: 'Esc', send: answer === 'yes' ? 'y' : 'n' },
      { when: 'deckent setup', ready: 'Enter confirm', send: '\u001b' },
    ]);
    if (process.env['DECKENT_ATTACH_TRANSCRIPTS']) {
      await writeFile(join(process.env['DECKENT_ATTACH_TRANSCRIPTS'], `guided-${answer}.txt`), result.output);
      await writeFile(join(process.env['DECKENT_ATTACH_TRANSCRIPTS'], `guided-${answer}.json`), JSON.stringify({ code: result.code, answered: result.answered, filesystem: { project: await readdir(project, { recursive: true }), global: await readdir(global, { recursive: true }), home: await readdir(home, { recursive: true }) } }));
    }
    expect(result.answered.slice(0, 5)).toEqual(['> 1. Language', '> 3. Folder', '> 5. Who uses', 'No (n)', 'Apply now (y)']);
    expect(result.output, result.output).toContain(question);
    expect(result.answered.filter(prompt => prompt === question)).toHaveLength(1);
    expect(result.code, result.output).toBe(0);
    expect((await lstat(project)).mode & 0o777).toBe(answer === 'yes' ? 0o755 : 0o775);
    if (answer === 'yes') {
      expect(result.output).toContain('Permissions: applied');
      expect(JSON.parse(await readFile(join(global, 'installation/registration.json'), 'utf8')).source.projectRoot).toBe(project);
      expect(await lstat(join(project, '.deckent/config.json'))).toBeDefined();
    } else {
      expect(result.output).toContain('PROJECT_ATTACHMENT_DENIED');
      expect(result.output).not.toContain('Permissions: applied');
      expect(await readdir(project)).toEqual([]); expect(await globalSnapshot()).toEqual(before); expect(await readdir(home)).toEqual([]);
    }
  }
}, 100_000);

it.skipIf(process.platform !== 'linux')('ATTACH review F2 (verify-not-run outside Linux): a folder starts 0775; preview asks before its read-only plan, apply uses that digest; no/JSON/pipe/AI refuse unchanged', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dk-preview-permission-')); roots.push(base);
  const source = join(base, 'source'), home = join(base, 'home'), global = join(base, 'global');
  for (const path of [source, home, global]) await mkdir(path, { mode: 0o700 });
  const env = personEnv({ PATH: process.env['PATH'], HOME: home, DECKENT_GLOBAL_HOME: global, NO_COLOR: '1', TERM: 'xterm', DECKENT_LANGUAGE: 'en' });
  const terminal = (cwd: string, args: string[], answers: TerminalAnswer[] = [], extra = {}) => runInTerminal([process.execPath, binary, ...args], cwd, { ...env, ...extra }, answers);
  const installed = await terminal(source, ['init', 'policy', '--scope', 'source', '--apply']); expect(installed.code, installed.output).toBe(0);
  const question = 'Others can write to this folder; narrow the permission?';
  for (const answer of ['yes', 'no', 'json', 'pipe', 'ai'] as const) {
    const project = join(base, answer); await mkdir(project); await chmod(project, 0o775);
    const before = await readFile(join(global, 'installation/registration.json'));
    const sourceBefore = await readFile(join(source, '.deckent/config.json'));
    const args = ['terminal', 'attach', '--scope', 'target', '--preview', ...(answer === 'json' ? ['--json'] : [])];
    let result: { code: number | null; output: string };
    if (answer === 'pipe') {
      const child = spawn(process.execPath, [binary, ...args], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
      const exited = new Promise<number | null>(resolve => child.once('exit', resolve)); child.stdin.end('yes\n'); result = { code: await exited, output };
    } else result = await terminal(project, args, answer === 'yes' || answer === 'no' ? [{ when: question, ready: 'Esc', send: answer === 'yes' ? 'y' : 'n' }] : [], answer === 'ai' ? { AI_AGENT: 'test-agent' } : {});
    if (process.env['DECKENT_ATTACH_TRANSCRIPTS']) await writeFile(join(process.env['DECKENT_ATTACH_TRANSCRIPTS'], `preview-${answer}.txt`), result.output);
    expect(await readFile(join(global, 'installation/registration.json'))).toEqual(before);
    expect(await readFile(join(source, '.deckent/config.json'))).toEqual(sourceBefore);
    expect(await readdir(project)).toEqual([]);
    if (answer === 'yes') {
      expect(result.code, result.output).toBe(0); expect(result.output).toContain(question);
      expect((await lstat(project)).mode & 0o777).toBe(0o755);
      const digest = /"planDigest": "([a-f0-9]{64})"/u.exec(result.output)?.[1]; expect(digest, result.output).toBeDefined();
      const applied = await terminal(project, ['terminal', 'attach', '--scope', 'target', '--apply', '--expect', digest!, '--command-id', '00000000-0000-4000-8000-000000000002'],
        [{ when: 'Connect this folder to the selected installation?', ready: 'Esc', send: 'y' }]);
      expect(applied.code, applied.output).toBe(0); expect(applied.output).not.toContain(question);
      expect(await lstat(join(project, '.deckent/project-attachment.json'))).toBeDefined();
      expect(JSON.parse(await readFile(join(global, 'installation/registration.json'), 'utf8')).entries.some((row: { attachment: { location: { canonicalRoot: string } } }) => row.attachment.location.canonicalRoot === project)).toBe(true);
    } else {
      expect(result.code, result.output).not.toBe(0); expect(result.output).toContain('PROJECT_ATTACHMENT_DENIED');
      expect((await lstat(project)).mode & 0o777).toBe(0o775);
      if (answer === 'no') { expect(result.output).toContain(question); expect(result.output).toContain('chmod go-w .'); }
      else expect(result.output).not.toContain(question);
      expect(lastJson(result.output) ?? {}).not.toHaveProperty('planDigest');
    }
  }
  // The terminal's first-open offer and explicit source registration use the same first-location boundary.
  const offered = join(base, 'offered'); await mkdir(offered); await chmod(offered, 0o775);
  const registry = await readFile(join(global, 'installation/registration.json'));
  const offer = await terminal(offered, [], [{ when: question, ready: 'Esc', send: 'n' }]);
  expect(offer.output).toContain(question); expect(offer.output).toContain('PROJECT_ATTACHMENT_DENIED'); expect(offer.code).not.toBe(0);
  expect((await lstat(offered)).mode & 0o777).toBe(0o775); expect(await readdir(offered)).toEqual([]);
  expect(await readFile(join(global, 'installation/registration.json'))).toEqual(registry);
  await chmod(source, 0o775);
  const registered = await terminal(source, ['terminal', 'attach', '--register', '--scope', 'source', '--preview'], [{ when: question, ready: 'Esc', send: 'y' }]);
  expect(registered.code, registered.output).toBe(0); expect(registered.output).toContain(question); expect(registered.output).toContain('"planDigest"');
  expect((await lstat(source)).mode & 0o777).toBe(0o755);
  expect(await readFile(join(global, 'installation/registration.json'))).toEqual(registry);
}, 100_000);

it.skipIf(process.platform !== 'linux')('ATTACH 0775 real-host first attach (verify-not-run outside Linux): TTY yes/no, JSON, non-TTY and AI; init and terminal attach', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dk-permission-')); roots.push(root);
  const question = 'Others can write to this folder; narrow the permission?';
  const trQuestion = 'Başkaları bu klasöre yazabiliyor; izni daraltalım mı?';
  for (const flow of ['init', 'attach'] as const) {
    for (const answer of ['yes', 'no', 'json', 'pipe', 'ai'] as const) {
      const base = join(root, `${flow}-${answer}`); await mkdir(base);
      const home = join(base, 'home'), global = join(base, 'global'), project = join(base, 'project');
      await mkdir(home, { mode: 0o700 }); await mkdir(global, { mode: 0o700 }); await mkdir(project, { mode: 0o775 }); await chmod(project, 0o775);
      const env = personEnv({ PATH: process.env['PATH'], HOME: home, DECKENT_GLOBAL_HOME: global, NO_COLOR: '1', TERM: 'xterm', DECKENT_LANGUAGE: 'en' });
      const terminal = (cwd: string, args: string[], answers: TerminalAnswer[] = [], extra = {}) =>
        runInTerminal([process.execPath, binary, ...args], cwd, { ...env, ...extra }, answers);
      let args = ['init', 'policy', '--scope', 'target', '--apply'];
      if (flow === 'attach') {
        const source = join(base, 'source'); await mkdir(source, { mode: 0o755 });
        const installed = await terminal(source, ['init', 'policy', '--scope', 'source', '--apply']);
        expect(installed.code, installed.output).toBe(0);
        const preview = await terminal(project, ['terminal', 'attach', '--scope', 'target', '--preview'], [{ when: question, ready: 'Esc', send: 'y' }]);
        expect(preview.code, preview.output).toBe(0);
        const digest = /"planDigest": "([a-f0-9]{64})"/u.exec(preview.output)?.[1]; expect(digest, preview.output).toBeDefined();
        args = ['terminal', 'attach', '--scope', 'target', '--apply', '--expect', digest!, '--command-id', '00000000-0000-4000-8000-000000000001'];
      }
      if (answer === 'json') args.push('--json');
      // Reopening group write after a valid preview must be checked again at apply, without bypassing its witness.
      const child = join(project, 'keep-mode'); await mkdir(child); await chmod(child, 0o777); await chmod(project, 0o775);
      const snapshot = async () => {
        const files: Record<string, string> = {};
        for (const path of await readdir(base, { recursive: true })) if ((await lstat(join(base, path))).isFile()) files[path] = (await readFile(join(base, path))).toString('base64');
        return files;
      };
      const before = await snapshot(), language = answer === 'no' ? 'tr' : 'en', prompt = language === 'tr' ? trQuestion : question;
      let result: { code: number | null; output: string };
      if (answer === 'pipe') {
        const childProcess = spawn(process.execPath, [binary, ...args], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = ''; childProcess.stdout.on('data', chunk => { output += String(chunk); }); childProcess.stderr.on('data', chunk => { output += String(chunk); });
        const exited = new Promise<number | null>(resolve => childProcess.once('exit', resolve)); childProcess.stdin.end('yes\n');
        result = { code: await exited, output };
      } else {
        const person = answer === 'yes' || answer === 'no';
        const answers = [ ...(flow === 'attach' && person ? [{ when: language === 'tr' ? 'Bu klasör seçilen kuruluma bağlansın mı?' : 'Connect this folder to the selected installation?', ready: 'Esc', send: 'y' }] : []),
          ...(person ? [{ when: prompt, ready: 'Esc', send: answer === 'yes' ? 'y' : 'n' }] : []) ];
        result = await terminal(project, args, answers, { DECKENT_LANGUAGE: language, ...(answer === 'ai' ? { AI_AGENT: 'test-agent' } : {}) });
      }
      if (answer === 'yes') {
        expect(result.code, `${flow}-${answer}: ${result.output}`).toBe(0); expect(result.output).toContain(prompt);
        expect((await lstat(project)).mode & 0o777).toBe(0o755);
        expect(await lstat(join(project, '.deckent/config.json'))).toBeDefined();
        expect(await lstat(join(global, 'installation/registration.json'))).toBeDefined();
        const ledger = flow === 'init' ? project : join(base, 'source');
        const db = new DatabaseSync(join(ledger, '.deckent/state/ledger.db'), { readOnly: true });
        try { expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION); } finally { db.close(); }
        if (flow === 'init') expect(JSON.parse(await readFile(join(global, 'installation/registration.json'), 'utf8')).source).toMatchObject({ projectRoot: project, scopeId: 'target' });
        else expect(await lstat(join(project, '.deckent/project-attachment.json'))).toBeDefined();
      } else {
        expect(result.code, result.output).not.toBe(0); expect(result.output).toContain(flow === 'init' || answer === 'no' ? 'PROJECT_ATTACHMENT_DENIED' : 'AUTHORITY_WITNESS_REQUIRED');
        expect((await lstat(project)).mode & 0o777).toBe(0o775);
        expect(await readdir(project)).toEqual(['keep-mode']); expect(await snapshot()).toEqual(before);
        if (flow === 'init') expect(await readdir(global)).toEqual([]);
        if (answer === 'no') { expect(result.output).toContain(prompt); expect(result.output).toContain('chmod go-w .'); }
        else { expect(result.output).not.toContain(question); expect(result.output).not.toContain('Connect this folder'); }
      }
      expect((await lstat(child)).mode & 0o777).toBe(0o777);
    }
  }
}, 120_000);

// A terminal witness is Linux-only today. Other POSIX hosts still verify the refusal, without pretending to register.
it.skipIf(process.platform === 'win32' || process.platform === 'linux')('ATTACH verify-not-run: 0775 positive needs a Linux witness; other POSIX refuses without a question or writes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dk-no-witness-')); roots.push(base);
  const project = join(base, 'project'), home = join(base, 'home'), global = join(base, 'global');
  for (const path of [project, home, global]) await mkdir(path, { mode: 0o700 });
  await chmod(project, 0o775);
  const env = personEnv({ PATH: process.env['PATH'], HOME: home, DECKENT_GLOBAL_HOME: global, NO_COLOR: '1', TERM: 'xterm', DECKENT_LANGUAGE: 'en' });
  for (const args of [['init', 'policy', '--scope', 'target', '--apply'], ['terminal', 'attach', '--scope', 'target', '--preview']]) {
    const result = await runInTerminal([process.execPath, binary, ...args], project, env);
    expect(result.code, result.output).not.toBe(0); expect(result.output).toContain('PROJECT_ATTACHMENT_DENIED');
    expect(result.output).not.toContain('Others can write to this folder');
    expect(result.answered).toEqual([]); expect(result.output).not.toContain('"planDigest"');
    expect((await lstat(project)).mode & 0o777).toBe(0o775);
    for (const path of [project, home, global]) expect(await readdir(path)).toEqual([]);
  }
}, 60_000);

describe.skipIf(process.platform === 'win32')('README first session, actual binary, no Docker or provider call', () => {
  it.each(['short', 'long'] as const)('initializes and serves a fresh %s path; a terminal-prompt secret names the selected scope, a piped one is refused before it is read (C-ADMIN)', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'dk-first-')); roots.push(root);
    const project = join(root, kind === 'long' ? 'a project with spaces '.repeat(9) : 'project');
    const home = join(root, 'home'), global = join(root, 'global');
    await mkdir(project, { mode: 0o755 }); await chmod(project, 0o755); await mkdir(home, { mode: 0o700 }); await mkdir(global, { mode: 0o700 });
    const env = { PATH: process.env['PATH'], HOME: home, DECKENT_HOME: join(project, '.deckent'), DECKENT_GLOBAL_HOME: global, NO_COLOR: '1', DECKENT_LANGUAGE: 'en', DOCKER_HOST: 'unix:///nonexistent/docker.sock' };
    const run = async (args: string[]) => ({ stdout: execFileSync(process.execPath, [binary, ...args],
      { cwd: project, env, timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8' }), stderr: '' });
    const version = await run(['--version']); expect(version.stdout + version.stderr, JSON.stringify({ binary, node: process.execPath, version })).toContain('deckent v');
    await run(['init', 'policy', '--scope', 'my-project', '--preview']);
    await expect(lstat(join(project, '.deckent'))).rejects.toMatchObject({ code: 'ENOENT' });
    const installed = await runInTerminal([process.execPath, binary, 'init', 'policy', '--scope', 'my-project', '--apply'], project, personEnv(env));
    expect(installed.code, installed.output).toBe(0);
    expect(installed.output).not.toContain('Others can write to this folder; narrow the permission?');
    expect((await lstat(project)).mode & 0o777).toBe(0o755);
    if (process.platform !== 'linux') {
      // 0755 short/long paths remain exercised everywhere POSIX. The policy install stands, but registration needs a witness.
      const snapshot = async () => {
        const files: Record<string, string | number> = {};
        for (const path of ['', ...await readdir(root, { recursive: true })]) {
          const info = await lstat(join(root, path)); files[`${path}:mode`] = info.mode;
          if (info.isFile()) files[path] = (await readFile(join(root, path))).toString('base64');
        }
        return files;
      };
      const before = await snapshot();
      const refused = await runInTerminal([process.execPath, binary, 'terminal', 'attach', '--register', '--scope', 'my-project', '--apply', '--expect', '0'.repeat(64)], project, personEnv(env),
        [{ when: 'Register this source installation', ready: 'Esc', send: 'y' }]);
      expect(refused.code, refused.output).not.toBe(0); expect(refused.output).toContain('AUTHORITY_WITNESS_REQUIRED');
      expect(refused.answered).toEqual(['Register this source installation']);
      expect(await snapshot()).toEqual(before);
      await expect(lstat(join(global, 'installation/registration.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(project)).mode & 0o777).toBe(0o755);
      return; // verify-not-run: registered runtime/secret journey requires the Linux witness.
    }
    expect(JSON.parse(await readFile(join(global, 'installation/registration.json'), 'utf8')).source).toMatchObject({ projectRoot: project, scopeId: 'my-project' });
    const config = JSON.parse(await readFile(join(project, '.deckent/config.json'), 'utf8'));
    expect(config).toMatchObject({ schema_version: 4, terminal: { scopeId: 'my-project', chat: { schemaVersion: 1 } }, cancellationRuntime: { scopeIds: ['my-project'] } });
    expect(config.cancellation.maxConcurrentDeliveries).toBeGreaterThan(0);
    const db = new DatabaseSync(join(project, '.deckent/state/ledger.db'), { readOnly: true });
    try { expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION); expect(db.prepare('SELECT count(*) AS n FROM runs').get()?.n).toBe(0); } finally { db.close(); }
    const applied = await readFile(join(project, '.deckent/config.json'), 'utf8');
    await run(['init', 'policy', '--scope', 'my-project', '--apply']);
    expect(await readFile(join(project, '.deckent/config.json'), 'utf8')).toBe(applied);
    let log = '';
    const service = spawn(process.execPath, [binary, 'runtime', 'serve'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    service.stdout.on('data', chunk => { log += String(chunk); }); service.stderr.on('data', chunk => { log += String(chunk); });
    const exited = new Promise<void>((resolve, reject) => { service.once('exit', () => resolve()); service.once('error', reject); });
    try {
      let health: { status: string; auditIntegrity: { status: string }; startability: { status: string; endpoint: string; checks: unknown[] }; serviceConfig: string } | undefined;
      for (let retry = 0; retry < 100; retry++) {
        if (service.exitCode !== null) throw new Error(`runtime exited ${service.exitCode}: ${log}`);
        health = JSON.parse((await run(['doctor', '--json'])).stdout);
        if (health?.serviceConfig === 'current' && health.auditIntegrity.status === 'match') break;
        await wait(50);
      }
      // B1 records system-row publication at install; service startup seals its checkpoint and verifies the matching chain.
      expect(health, log).toMatchObject({ status: 'ready', auditIntegrity: { status: 'match', reason: 'verified' }, startability: { status: 'ready', checks: [] }, serviceConfig: 'current' });
      const endpoint = health!.startability.endpoint; roots.push(dirname(endpoint));
      expect(Buffer.byteLength(endpoint)).toBeLessThan(108); expect(endpoint).not.toContain(project);
      expect((await lstat(dirname(endpoint))).mode & 0o777).toBe(0o700);
      expect((await lstat(endpoint)).mode & 0o777).toBe(0o600);
      // SEC-1 × C-ADMIN: a piped key is refused by the CLI before it is read (the service witness stays the backstop); the README's hidden prompt
      // on a real PTY stores it.
      const piped = spawn(process.execPath, [binary, 'secret', 'set', 'INSTALL_FLOW_PIPED', '--scope', 'my-project'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let pipedLog = ''; piped.stdout.on('data', chunk => { pipedLog += String(chunk); }); piped.stderr.on('data', chunk => { pipedLog += String(chunk); });
      const refused = new Promise<number | null>(resolve => piped.once('exit', resolve)); piped.stdin.end('offline-fixture-key\n');
      expect(await refused, pipedLog).not.toBe(0); expect(pipedLog).toContain('SECRET_SET_TERMINAL_REQUIRED'); expect(pipedLog).not.toContain('offline-fixture-key');
      const set = await runInTerminal([process.execPath, binary, 'secret', 'set', 'INSTALL_FLOW_TEST', '--main', '--scope', 'my-project'], project, personEnv(env), [{ when: 'INSTALL_FLOW_TEST: ', send: 'offline-fixture-key\r' }]);
      expect(set.code, set.output).toBe(0); expect(set.output).not.toContain('offline-fixture-key');
      const listed = await run(['secret', 'list']); expect(listed.stdout + listed.stderr).toContain('INSTALL_FLOW_TEST');
      const doctor = await run(['doctor', '--verbose']); expect(doctor.stdout + doctor.stderr).toContain('Runtime startability: ready'); // C-DOCTOR: details behind --verbose
    } finally {
      service.kill('SIGTERM');
      const timer = setTimeout(() => service.kill('SIGKILL'), 10_000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }, 60_000);
});
