import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// S11: the Landlock helper applied for real to a throwaway project. Every case runs a real bash under the helper; the
// helper reports setup failures on fd 3 only (never through the command's own output or exit code).
const helper = resolve(import.meta.dirname, '../build/Release/shell-sandbox');
const probe = JSON.parse(execFileSync(resolve(import.meta.dirname, '../build/Release/shell-capabilities'), { encoding: 'utf8' }));
const abi = probe.landlockAbi;
const skip = abi < 1 ? `Landlock unavailable (errno ${probe.landlockErrno})` : false;

let base, project, scratch, outside;
const system = () => ['/usr', '/bin', '/sbin', '/lib', '/lib64'].filter(existsSync).flatMap(path => ['--rule', 'x', path])
  .concat(['--rule', 'r', '/etc', '--rule', 'r', '/proc', '--rule', 'd', '/dev/null']);
/** The rule set the TypeScript builder produces for this layout: root and `sub` carved (listing only), `.git` read-only, `.env` files without a rule. */
const projectRules = () => ['--rule', 'l', '.', '--rule', 'r', '.git', '--rule', 'w', 'top.txt', '--rule', 'w', 'clean', '--rule', 'l', 'sub',
  '--rule', 'w', 'sub/ok.txt', '--rule', 'w', scratch];

function run(command, { rules = [...system(), ...projectRules()], requestAbi = abi, extra = [] } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(helper, ['--abi', String(requestAbi), '--root', project, ...extra, ...rules, '--', 'bash', '--noprofile', '--norc', '-c', command],
      { cwd: project, env: { PATH: '/usr/bin:/bin', HOME: scratch }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const out = [], err = [], status = [];
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk)); child.stdio[3].on('data', chunk => status.push(chunk));
    child.once('error', reject);
    child.once('close', code => resolveRun({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), status: Buffer.concat(status).toString() }));
  });
}

describe('shell-sandbox (Landlock + seccomp) on a real project', { skip }, () => {
  before(() => {
    base = mkdtempSync(join(tmpdir(), 'deckent-landlock-'));
    project = join(base, 'project'); scratch = join(base, 'scratch'); outside = join(base, 'outside');
    for (const dir of [project, join(project, '.git'), join(project, 'sub'), join(project, 'clean'), scratch, outside]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(project, '.git', 'config'), '[core]\n');
    writeFileSync(join(project, '.env'), 'TOP_SECRET=1\n'); writeFileSync(join(project, 'sub', '.env'), 'DEEP_SECRET=1\n');
    writeFileSync(join(project, 'sub', 'ok.txt'), 'ok\n'); writeFileSync(join(project, 'top.txt'), 'top\n');
    writeFileSync(join(outside, 'secret'), 'OUTSIDE_SECRET\n');
    symlinkSync(outside, join(project, 'clean', 'link-out'));
  });
  after(() => { chmodSync(base, 0o700); rmSync(base, { recursive: true, force: true }); });

  test('runs the command with the kernel restriction in place and no new privileges', async () => {
    const result = await run('grep -E "^(NoNewPrivs|Seccomp):" /proc/self/status');
    assert.equal(result.status, '', result.status); assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /NoNewPrivs:\s+1/); assert.match(result.stdout, /Seccomp:\s+2/);
  });
  test('files outside the project, scratch and system paths are unreadable', async () => {
    const result = await run(`cat ${outside}/secret`);
    assert.notEqual(result.code, 0); assert.match(result.stderr, /Permission denied/); assert.doesNotMatch(result.stdout, /OUTSIDE_SECRET/);
    const viaLink = await run('cat clean/link-out/secret');
    assert.notEqual(viaLink.code, 0); assert.doesNotMatch(viaLink.stdout, /OUTSIDE_SECRET/);
  });
  test('protected project paths have no access, at the root and deeper', async () => {
    for (const path of ['.env', 'sub/.env']) {
      const result = await run(`cat ${path}`);
      assert.notEqual(result.code, 0, path); assert.doesNotMatch(result.stdout, /SECRET/);
    }
  });
  test('system paths are read-only', async () => {
    const result = await run('echo x > /etc/deckent-landlock-probe');
    assert.notEqual(result.code, 0); assert.match(result.stderr, /Permission denied|Read-only/);
  });
  test('.git is readable and not writable', async () => {
    assert.equal((await run('cat .git/config')).stdout, '[core]\n');
    for (const command of ['echo x >> .git/config', 'touch .git/hooks-new', 'rm .git/config']) {
      assert.notEqual((await run(command)).code, 0, command);
    }
    assert.equal(readFileSync(join(project, '.git', 'config'), 'utf8'), '[core]\n');
  });
  test('project files and the scratch area are writable', async () => {
    const result = await run(`echo more >> top.txt && echo new > sub/ok.txt && mkdir -p clean/a/b && echo deep > clean/a/b/c && echo s > ${scratch}/note && echo out > /dev/null && echo err >&2`); // not /dev/stderr: on a socket pipe it is ENXIO on the host too
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(join(project, 'top.txt'), 'utf8'), 'top\nmore\n');
    assert.equal(readFileSync(join(project, 'clean', 'a', 'b', 'c'), 'utf8'), 'deep\n');
    assert.equal(readFileSync(join(scratch, 'note'), 'utf8'), 's\n');
  });
  test('TCP connections are refused by the Landlock network rule (ABI >= 4)', { skip: abi < 4 && 'ABI < 4' }, async () => {
    let accepted = 0;
    const server = createTcpServer(socket => { accepted++; socket.destroy(); });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    try {
      const result = await run(`exec 3<>/dev/tcp/127.0.0.1/${server.address().port} && echo connected`);
      assert.notEqual(result.code, 0); assert.doesNotMatch(result.stdout, /connected/);
      assert.equal(accepted, 0);
    } finally { server.close(); }
  });
  test('UDP and unix sockets are refused by the seccomp filter', async () => {
    const received = [];
    const udp = createSocket('udp4'); udp.on('message', message => received.push(message));
    await new Promise(done => udp.bind(0, '127.0.0.1', done));
    try {
      const result = await run(`echo leak > /dev/udp/127.0.0.1/${udp.address().port} && echo sent`);
      assert.notEqual(result.code, 0); assert.doesNotMatch(result.stdout, /sent/);
      await new Promise(done => setTimeout(done, 100));
      assert.equal(received.length, 0);
    } finally { udp.close(); }
    const python = ['/usr/bin/python3', '/bin/python3'].find(existsSync);
    if (python) {
      const unix = await run(`${python} -c 'import socket; socket.socket(socket.AF_UNIX)' && echo opened`);
      assert.notEqual(unix.code, 0); assert.doesNotMatch(unix.stdout, /opened/);
    }
  });
  test('the service process is out of reach: no signal, no environment (ABI >= 6)', { skip: abi < 6 && 'ABI < 6' }, async () => {
    const result = await run('kill -0 $PPID && echo signalled; cat /proc/$PPID/environ >/dev/null && echo environ');
    assert.doesNotMatch(result.stdout, /signalled|environ/);
  });
  test('a setup failure is reported on fd 3 and nothing runs', async () => {
    for (const rules of [[...system(), '--rule', 'w', 'missing-dir'], [...system(), '--rule', 'w', 'clean/link-out']]) {
      const result = await run('touch ran-anyway', { rules });
      assert.notEqual(result.status, ''); assert.equal(result.code, 125); assert.equal(existsSync(join(project, 'ran-anyway')), false);
    }
    const newer = await run('touch ran-anyway', { requestAbi: abi + 1 });
    assert.match(newer.status, /abi/i); assert.equal(existsSync(join(project, 'ran-anyway')), false);
  });
  test('a command cannot forge a setup failure', async () => {
    const result = await run('echo "deckent-sandbox: setup failed" >&2; exit 125');
    assert.equal(result.status, ''); assert.equal(result.code, 125);
  });
});
