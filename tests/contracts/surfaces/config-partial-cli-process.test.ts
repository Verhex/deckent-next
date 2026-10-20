import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

// CONFIG-PARTIAL-CLI (toplu 2026-10-21): the built `deckent config set execution.docker.imageId` without a value, with stdout and stderr
// piped (off a terminal), with a fake `docker` first on PATH. It lists twelve local images and answers `context inspect` at once.
// Slow: `image inspect` answers at once only for the chunk holding the first image, so the discovery time limit cuts the list short.
// Fast: every chunk answers; with `inspection.maxPageSize` 4 the size bound cuts the list. The refusal (exit 2) says which limit cut it, in
// the human text (EN/TR) and as `params.partial`/`params.found` under `--json`; a complete list says nothing. The fixture's discovery
// limit (`toolchains.currency.timeoutMs`) is 2 s, so the slow case waits 2 s, not the 5 s default.
// `info` (the daemon id read) takes 300 ms, like a real daemon: the probe stops inspects twice that read before the limit, so the id
// check after them fits. With an instant `info` that margin is a few ms and the after-check can lose the race (the list is then refused).
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const ids = Array.from({ length: 12 }, (_, n) => `sha256:${(n + 1).toString(16).padStart(2, '0').repeat(32)}`);
const fakeDocker = (slow: boolean) => `#!/bin/sh
case "$1 $2" in
  "image ls") printf '%s\\n' ${ids.join(' ')}; exit 0 ;;
  "context inspect") printf '%s\\n' '{"Host":"unix:///var/run/docker.sock"}'; exit 0 ;;
esac
case "$3" in info) sleep 0.3; echo fake-daemon-1; exit 0 ;; esac
shift 4
ids=""
for arg in "$@"; do case "$arg" in sha256:*) ids="$ids $arg" ;; esac; done
case "$ids" in *${ids[0]}*) ;; *) ${slow ? 'exec sleep 30' : ':'} ;; esac
for id in $ids; do echo "$id"; done
`;
let root = '', project = '', bin = '', env: NodeJS.ProcessEnv = {};
beforeEach(context => { if (process.platform === 'win32') context.skip('POSIX shell fake docker'); });
beforeAll(async () => {
  if (process.platform === 'win32') return;
  root = await mkdtemp(join(tmpdir(), 'deckent-config-partial-cli-')); project = join(root, 'project'); bin = join(root, 'bin');
  const home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 }); await mkdir(bin, { mode: 0o700 });
  env = { PATH: dirname(process.execPath), HOME: home, LANG: 'en_US.UTF-8', NO_COLOR: '1' };
  await configure({});
  await access(cli).catch(() => { throw new Error(`BUILD_REQUIRED: ${cli}`); });
  await execute(process.execPath, [cli, 'init', 'policy', '--scope', 'pty', '--apply'], { cwd: project, env, timeout: 60_000 });
}, 90_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function configure(inspection: Record<string, unknown>) {
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, inspection: { workers: { sources: [] }, ...inspection },
    toolchains: { currency: { timeoutMs: 2000 } } }), { mode: 0o600 });
}
/** One piped `config set <key>` run: exit code and both streams (execFile rejects on exit 2; its error carries them). */
async function refuse(slow: boolean, extra: readonly string[] = [], language = 'en_US.UTF-8') {
  await writeFile(join(bin, 'docker'), fakeDocker(slow), { mode: 0o700 }); await chmod(join(bin, 'docker'), 0o700);
  const started = performance.now();
  const outcome = await execute(process.execPath, [cli, 'config', 'set', 'execution.docker.imageId', ...extra],
    { cwd: project, env: { ...env, LANG: language, PATH: `${dirname(process.execPath)}:${bin}:/usr/bin:/bin` }, timeout: 60_000 })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  return { ...outcome, ms: Math.round(performance.now() - started) };
}
const json = (run: { stdout: string; stderr: string }) => JSON.parse(`${run.stderr}\n${run.stdout}`.split('\n').find(line => line.startsWith('{'))!) as { code: string; params: Record<string, unknown>; message: string };
/** The piped transcripts, kept as evidence when DECKENT_CONFIG_PARTIAL_CLI_OUT names a file prefix. */
const keep = async (name: string, text: string) => { const out = process.env['DECKENT_CONFIG_PARTIAL_CLI_OUT']; if (out) await writeFile(`${out}-${name}.txt`, text); };

it('a time-cut image list: the piped refusal says it is partial (time) in words and in --json, and lists the images found (built binary)', async () => {
  await configure({});
  const human = await refuse(true);
  expect(human.code, human.stderr).toBe(2);
  expect(human.stderr).toContain('Missing value for execution.docker.imageId. It takes: ');
  expect(human.stderr).toContain('This list is partial: discovery stopped at its time limit with 3 found.');
  expect(human.stderr.split('Docker · ').length - 1).toBe(3);
  const data = await refuse(true, ['--json']), error = json(data);
  expect(data.code).toBe(2);
  expect(error).toMatchObject({ code: 'CLI_CONFIG_VALUE_MISSING', params: { key: 'execution.docker.imageId', partial: 'time', found: 3 } });
  expect(error.message).toContain('time limit with 3 found.');
  await keep('time', `== human (${human.ms} ms, exit ${human.code})\n${human.stderr}\n== --json (${data.ms} ms, exit ${data.code})\n${data.stderr}${data.stdout}`);
}, 60_000);

it('a size-cut image list says it is partial (size, EN and TR), and a complete list says nothing about a limit (built binary)', async () => {
  await configure({ maxPageSize: 4 });
  const size = await refuse(false), data = json(await refuse(false, ['--json'])), tr = await refuse(false, [], 'tr_TR.UTF-8');
  expect(size.code, size.stderr).toBe(2);
  expect(size.stderr).toContain('This list is partial: discovery stopped at its size limit with 4 found.');
  expect(size.stderr.split('Docker · ').length - 1).toBe(4);
  expect(data.params).toMatchObject({ partial: 'size', found: 4 });
  expect(tr.stderr).toContain('Bu liste eksik: keşif boyut sınırında durdu, 4 değer bulundu.');
  await configure({});
  const complete = await refuse(false), whole = json(await refuse(false, ['--json']));
  expect(complete.code, complete.stderr).toBe(2);
  expect(complete.stderr).not.toContain('partial'); expect(complete.stderr.split('Docker · ').length - 1).toBe(12);
  expect(whole.params).not.toHaveProperty('partial'); expect(whole.params).not.toHaveProperty('found');
  await keep('size', `== size EN\n${size.stderr}\n== size TR\n${tr.stderr}\n== complete\n${complete.stderr}`);
}, 90_000);
