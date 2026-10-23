import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { terminalProgram } from '../../contracts/support/approval-terminal.js';
import pkg from '../../../package.json' with { type: 'json' };
import config from './config.json' with { type: 'json' };
import { fixtureAvailability, type FixtureAvailability } from './availability.js';

const cli = resolve(pkg.bin.deckent);
export async function runtimeBinaryAvailability(): Promise<FixtureAvailability> {
  const platform = fixtureAvailability();
  if (platform.status !== 'available') return platform;
  try { await access(cli); return platform; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { status: 'verify-not-run', reason: 'binary-unavailable', platform: process.platform };
    }
    throw error;
  }
}
function jsonOutput(output: string): unknown {
  const lines = output.trim().split(/\r?\n/u).filter(line => line.startsWith('{'));
  if (lines.length !== 1) throw new Error(`fixture CLI expected one JSON result: ${output}`);
  return JSON.parse(lines[0]!);
}
function refused(output: string): never {
  const value = jsonOutput(output) as { code?: string; error?: { code?: string } };
  const code = value.code ?? value.error?.code;
  if (!code) throw new Error(`fixture CLI returned an untyped error: ${output}`);
  throw Object.assign(new Error(code), { code });
}
/** Executes the package's shipped entry: every operation and decision crosses the installed service socket. */
export async function startFixtureRuntime(project: string, root: string, fixtureEnv: NodeJS.ProcessEnv) {
  const env = { ...process.env, ...fixtureEnv };
  let child: ChildProcess | undefined, done: Promise<void> = Promise.resolve(), sequence = 0;
  const calls: { argv: string[]; status: number; result: unknown }[] = [];
  const command = async <T>(argv: string[], input?: unknown, interactive = false): Promise<T> => {
    const args = [...argv];
    if (input !== undefined) {
      const path = join(root, `cli-input-${++sequence}.json`);
      await writeFile(path, JSON.stringify(input), { mode: 0o600 }); args.push('--input', path);
    }
    args.push('--json');
    let status = 0, output: string;
    if (interactive) {
      const answer = await terminalProgram([process.execPath, cli, ...args], env, project);
      status = answer.status; output = answer.output;
    } else {
      try { output = (await promisify(execFile)(process.execPath, [cli, ...args], { cwd: project, env,
        timeout: config.runtime.commandTimeoutMs, maxBuffer: config.runtime.outputMaxBytes })).stdout; }
      catch (error) {
        // A killed/timed-out process is not a typed product refusal.
        if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'number' || !('stderr' in error)) throw error;
        status = error.code; output = String(error.stderr);
      }
    }
    const result = jsonOutput(output); calls.push({ argv, status, result });
    if (status !== 0) refused(output);
    return result as T;
  };
  /** The same installed entry without --json: what a person reads (BETA-RAKIP-3 next steps). A typed refusal is returned, not thrown. */
  const human = async (argv: string[], input?: unknown) => {
    const args = [...argv];
    if (input !== undefined) {
      const path = join(root, `cli-input-${++sequence}.json`);
      await writeFile(path, JSON.stringify(input), { mode: 0o600 }); args.push('--input', path);
    }
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, ...args], { cwd: project, env,
        timeout: config.runtime.commandTimeoutMs, maxBuffer: config.runtime.outputMaxBytes });
      return { status: 0, stdout, stderr };
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'number' || !('stderr' in error)) throw error;
      return { status: error.code, stdout: 'stdout' in error ? String(error.stdout) : '', stderr: String(error.stderr) };
    }
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) { await done; return; }
    child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), config.runtime.stopTimeoutMs);
    try { await done; } finally { clearTimeout(timer); }
  };
  const start = async () => {
    child = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const running = child;
    done = new Promise<void>(resolveDone => running.once('close', () => resolveDone()));
    let buffer = '', stderr = '';
    running.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-config.runtime.outputMaxBytes); });
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error(`fixture runtime readiness timeout: ${stderr}`)), config.runtime.commandTimeoutMs);
        const finish = (error?: Error) => { clearTimeout(timer); running.removeListener('error', failed); running.removeListener('close', closed);
          running.stdout!.removeListener('data', data); if (error) reject(error); else resolveReady(); };
        const failed = (error: Error) => finish(error);
        const closed = () => finish(new Error(`fixture runtime closed before ready: ${stderr}`));
        const data = (chunk: Buffer) => {
          buffer += String(chunk);
          if (buffer.length > config.runtime.outputMaxBytes) { finish(new Error('fixture runtime output limit')); return; }
          for (const line of buffer.split(/\r?\n/u)) {
            try { if ((JSON.parse(line) as { event?: string }).event === 'ready') { finish(); return; } }
            catch { /* partial JSON line */ }
          }
        };
        running.once('error', failed); running.once('close', closed); running.stdout!.on('data', data);
      });
      // Drain later observer events without retaining an unbounded stream.
      running.stdout!.resume();
    } catch (error) { await stop(); throw error; }
  };
  await start();
  try {
    const identity = { cli, entrySha256: createHash('sha256').update(await readFile(cli)).digest('hex'),
      descriptor: await command<unknown>(['runtime', 'describe']) };
    return { command, human, identity, calls, close: stop, restart: async () => { await stop(); await start(); } };
  } catch (error) { await stop(); throw error; }
}
