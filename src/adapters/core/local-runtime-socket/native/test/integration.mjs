import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket, createConnection } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
const addon = createRequire(import.meta.url)('../build/Release/peer_credentials.node');
const testAddon = createRequire(import.meta.url)('../build/Test/peer_credentials.node');
const exec = promisify(execFile);
const createListener = (path, backlog, callback, lifecycle = () => {}) => addon.createListener(path, backlog, callback, lifecycle);
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-peer-')); const path = join(root, 'socket');
  try { await fn(path); } finally { await wait(10); await rm(root, { recursive: true, force: true }); }
}
function connect(path) {
  return new Promise((resolve, reject) => {
    const client = createConnection(path); client.on('error', reject); client.on('close', resolve);
  });
}
test('actual child PID/UID/GID and single-use ownership transfer through public Socket fd', () => fixture(async path => {
  let seen; let saved;
  const listener = createListener(path, 8, handoff => {
    seen = handoff.peer; saved = handoff.takeFd;
    const fd = handoff.takeFd();
    assert.throws(() => handoff.takeFd(), { code: 'LOCAL_PEER_TRANSFERRED' });
    const socket = new Socket({ fd, readable: true, writable: true, allowHalfOpen: true });
    socket.on('error', () => {}); socket.end('ok'); socket.resume();
  });
  try {
    const { stdout } = await exec(process.execPath, ['-e', `
      const c=require('node:net').createConnection(process.argv[1]);
      let text='';c.on('data',b=>text+=b);c.on('end',()=>c.end());
      c.on('close',()=>console.log(JSON.stringify({pid:process.pid,uid:process.getuid(),gid:process.getgid(),text})));
      c.on('error',()=>process.exit(1));`, path], { timeout: 3000 });
    const child = JSON.parse(stdout); assert.equal(child.text, 'ok');
    assert.deepEqual(seen, { pid: child.pid, uid: child.uid, gid: child.gid });
    assert.notEqual(seen.pid, process.pid);
    assert.throws(() => saved(), { code: 'LOCAL_PEER_TRANSFERRED' });
  } finally { listener.close(); listener.close(); }
  await wait(10); listener.close();
}));
test('untaken and throwing callbacks close native fd; retained takeFd expires', () => fixture(async path => {
  let saved;
  const listener = createListener(path, 8, handoff => { saved = handoff.takeFd; throw new Error('fixture'); });
  try { await connect(path); assert.throws(() => saved(), { code: 'LOCAL_PEER_TRANSFERRED' }); }
  finally { listener.close(); }
}));
test('throwing after transfer does not close the JavaScript-owned descriptor', () => fixture(async path => {
  let owned;
  const listener = createListener(path, 8, handoff => { owned = handoff.takeFd(); throw new Error('after transfer'); });
  const client = createConnection(path); client.on('error', () => {});
  try {
    for (let i = 0; i < 100 && owned === undefined; i++) await wait(5);
    assert.equal(typeof owned, 'number'); closeSync(owned); owned = undefined;
  } finally { if (owned !== undefined) closeSync(owned); client.destroy(); listener.close(); }
}));
test('never unlinks an existing path and rejects invalid options', () => fixture(async path => {
  await writeFile(path, 'keep');
  assert.throws(() => createListener(path, 8, () => {}), { code: 'LOCAL_PEER_LISTEN' });
  assert.equal(await readFile(path, 'utf8'), 'keep');
  assert.throws(() => createListener(path, 0, () => {}), { code: 'LOCAL_PEER_OPTIONS' });
  assert.throws(() => createListener(path + '\0extra', 1, () => {}), { code: 'LOCAL_PEER_OPTIONS' });
}));

test('worker environment teardown closes a live listener without accessing another event loop', () => fixture(async path => {
  const { Worker } = await import('node:worker_threads');
  const { once } = await import('node:events');
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const addon=require(workerData.addon);
    addon.createListener(workerData.path,8,()=>{},()=>{});
    parentPort.postMessage('ready');`, { eval: true, workerData: { path,
      addon: createRequire(import.meta.url).resolve('../build/Release/peer_credentials.node') } });
  assert.deepEqual(await once(worker, 'message'), ['ready']);
  await worker.terminate();
}));


test('explicit repeated close emits exactly one immutable lifecycle result', () => fixture(async path => {
  const events = []; let resolve;
  const settled = new Promise(done => { resolve = done; });
  const listener = createListener(path, 8, () => {}, event => {
    assert.equal(Object.isFrozen(event), true); events.push(event); resolve();
  });
  listener.close(); listener.close(); await settled; listener.close();
  assert.deepEqual(events, [{ state: 'closed', reason: 'requested' }]);
}));

test('owned endpoint removal waits for native close and preserves a replaced socket object', () => fixture(async path => {
  const { createServer } = await import('node:net');
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const listener = createListener(path, 8, () => {}, settle);
  assert.throws(() => listener.removeEndpoint(), { code: 'LOCAL_PEER_ACTIVE' });
  listener.close(); await settled;
  await rm(path);
  const replacement = createServer();
  await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(path, resolve); });
  try {
    assert.throws(() => listener.removeEndpoint(), { code: 'LOCAL_PEER_CUSTODY' });
    const client = createConnection(path); client.on('error', () => {});
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    client.destroy();
  } finally { await new Promise(resolve => replacement.close(resolve)); }
}));

test('owned endpoint removal is idempotent after settled close', () => fixture(async path => {
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const listener = createListener(path, 8, () => {}, settle);
  listener.close(); await settled; listener.removeEndpoint(); listener.removeEndpoint();
  await assert.rejects(readFile(path), { code: 'ENOENT' });
}));

for (const [mode, reason] of [[1, 'poll-failed'], [2, 'accept-failed']]) {
  test(`test-only ${reason} fault enters the real readiness callback and settles once without reopening`, () => fixture(async path => {
    const events = []; let settle;
    const settled = new Promise(resolve => { settle = resolve; });
    let accepted = 0;
    const listener = testAddon.createListener(path, 8, () => { accepted += 1; }, event => {
      events.push(event); settle();
    });
    listener.__testFailNextReadable(mode);
    const client = createConnection(path); client.on('error', () => {});
    try {
      await Promise.race([settled, wait(2_000).then(() => { throw new Error(`${reason} lifecycle timeout`); })]);
      assert.equal(accepted, 0);
      assert.deepEqual(events, [{ state: 'closed', reason }]);
      listener.close();
      await wait(10);
      assert.deepEqual(events, [{ state: 'closed', reason }]);
      assert.throws(() => testAddon.createListener(path, 8, () => {}, () => {}), { code: 'LOCAL_PEER_LISTEN' });
    } finally { client.destroy(); listener.close(); }
  }));
}

test('fatal listener settlement does not close a descriptor already transferred to JavaScript', () => fixture(async path => {
  let accepted; let acceptReady;
  const ready = new Promise(resolve => { acceptReady = resolve; });
  let lifecycleReady;
  const lifecycle = new Promise(resolve => { lifecycleReady = resolve; });
  const listener = testAddon.createListener(path, 8, handoff => {
    accepted = new Socket({ fd: handoff.takeFd(), readable: true, writable: true, allowHalfOpen: true });
    accepted.on('error', () => {}); acceptReady();
  }, event => lifecycleReady(event));
  const first = createConnection(path); first.on('error', () => {});
  let trigger;
  try {
    await Promise.race([ready, wait(2_000).then(() => { throw new Error('transfer timeout'); })]);
    listener.__testFailNextReadable(1);
    trigger = createConnection(path); trigger.on('error', () => {});
    assert.deepEqual(await Promise.race([lifecycle, wait(2_000).then(() => { throw new Error('fatal timeout'); })]),
      { state: 'closed', reason: 'poll-failed' });
    const received = once(first, 'data'); accepted.write('still-owned');
    assert.equal(String((await received)[0]), 'still-owned');
  } finally {
    trigger?.destroy(); first.destroy(); accepted?.destroy(); listener.close();
  }
}));

for (const mode of [1, 2]) {
  test(`test-only start fault ${mode} removes the socket created by that failed call`, () => fixture(async path => {
    testAddon.__testFailNextStart(mode);
    assert.throws(() => testAddon.createListener(path, 8, () => {}, () => {}), { code: 'LOCAL_PEER_POLL' });
    await assert.rejects(access(path), { code: 'ENOENT' });
  }));
}

test('failed-start cleanup preserves a replacement that does not match captured pathname identity', () => fixture(async path => {
  testAddon.__testFailNextStart(3);
  assert.throws(() => testAddon.createListener(path, 8, () => {}, () => {}), { code: 'LOCAL_PEER_POLL' });
  assert.equal(await readFile(path, 'utf8'), 'replacement');
}));

test('production addon exposes no fault hooks', () => fixture(async path => {
  assert.equal(addon.__testFailNextStart, undefined);
  let settle; const settled = new Promise(resolve => { settle = resolve; });
  const listener = createListener(path, 8, () => {}, settle);
  try { assert.equal(listener.__testFailNextReadable, undefined); }
  finally { listener.close(); await settled; }
}));

test('throwing lifecycle callback cannot escape or prevent native close settlement', () => fixture(async path => {
  let called = 0;
  const listener = createListener(path, 8, () => {}, () => { called += 1; throw new Error('private lifecycle failure'); });
  listener.close();
  for (let attempt = 0; attempt < 100 && called === 0; attempt++) await wait(5);
  assert.equal(called, 1);
  listener.close();
  assert.throws(() => createListener(path, 8, () => {}, () => {}), { code: 'LOCAL_PEER_LISTEN' });
}));
