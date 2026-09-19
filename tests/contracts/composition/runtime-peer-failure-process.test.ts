import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';

type Child = ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> };
function closed(child: Child): Promise<number | null> {
  return new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
}
async function bounded<T>(promise: Promise<T>, child: Child, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(label)); }, 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function run(program: string, args: string[], env: NodeJS.ProcessEnv): Child {
  return spawn(process.execPath, ['--input-type=module', '-e', program, ...args], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
  }) as Child;
}

it.skipIf(process.platform !== 'linux')('turns a native peer fatal into typed configured-service shutdown and permits a fresh-process restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-peer-failure-process-'));
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const env = { HOME: join(root, 'home') };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 4096, responseMaxBytes: 4096, maxConnections: 2, maxConcurrentRequests: 2,
      maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 },
  }));
  const opened = await openConfiguredAttemptStore(project, { env });
  const principal = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: principal, resource: { kind: 'scope', ids: ['s'] } },
  ] }), { mode: 0o600 });
  opened.store.close();
  const sdk = resolve('dist/index.js');
  const release = resolve('dist/adapters/core/local-runtime-socket/native/build/Release/peer_credentials.node');
  const test = resolve('src/adapters/core/local-runtime-socket/native/build/Test/peer_credentials.node');
  const cli = resolve('dist/composition/core/cli/internal/entry.js');
  const fatalProgram = String.raw`
    import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url'; import {createConnection} from 'node:net';
    const [sdk,project,releasePath,testPath]=process.argv.slice(1); const require=createRequire(import.meta.url);
    const injected=require(testPath); let listener;
    const replacement=Object.freeze({...injected,createListener(...args){listener=injected.createListener(...args);return listener;}});
    const key=require.resolve(releasePath); require.cache[key]={id:key,filename:key,loaded:true,exports:replacement,children:[],paths:[]};
    const {startConfiguredRuntimeService}=await import(pathToFileURL(sdk).href);
    const observer={async onPage(){},async onError(){}};
    const service=await startConfiguredRuntimeService(project,observer,{env:{HOME:process.env.HOME}});
    process.stdout.write(JSON.stringify({event:'ready',endpoint:service.endpoint})+'\n');
    listener.__testFailNextReadable(1);
    const trigger=createConnection(service.endpoint); trigger.on('error',()=>{});
    let failure; try{await service.done;failure={resolved:true};}catch(error){failure={resolved:false,code:error?.code,category:error?.category};}
    trigger.destroy();
    const admission=await new Promise(resolve=>{const socket=createConnection(service.endpoint);let settled=false;
      const finish=value=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
      socket.once('connect',()=>finish('connected'));socket.once('error',()=>finish('rejected'));setTimeout(()=>finish('timeout'),1000).unref();});
    process.stdout.write(JSON.stringify({event:'fatal',failure,admission})+'\n');`;
  const restartProgram = String.raw`
    import {pathToFileURL} from 'node:url'; const [sdk,project]=process.argv.slice(1);
    const {startConfiguredRuntimeService}=await import(pathToFileURL(sdk).href);
    const service=await startConfiguredRuntimeService(project,{async onPage(){},async onError(){}},{env:{HOME:process.env.HOME}});
    process.stdout.write(JSON.stringify({event:'restarted'})+'\n'); await service.stop(); await service.done;
    process.stdout.write(JSON.stringify({event:'stopped'})+'\n');`;
  const preload = join(root, 'inject-peer-fatal.mjs');
  await writeFile(preload, `import {createRequire} from 'node:module';import {createConnection} from 'node:net';
    const require=createRequire(import.meta.url),injected=require(${JSON.stringify(test)}),key=require.resolve(${JSON.stringify(release)});
    const replacement=Object.freeze({...injected,createListener(...args){const listener=injected.createListener(...args);
      setImmediate(()=>{listener.__testFailNextReadable(1);const socket=createConnection(args[0]);socket.on('error',()=>{});});return listener;}});
    require.cache[key]={id:key,filename:key,loaded:true,exports:replacement,children:[],paths:[]};`);
  let fatal: Child | undefined; let restart: Child | undefined; let cliFatal: Child | undefined; let cliGrace: Child | undefined;
  try {
    fatal = run(fatalProgram, [sdk, project, release, test], env);
    let fatalOut = '', fatalErr = ''; fatal.stdout.on('data', chunk => { fatalOut += String(chunk); }); fatal.stderr.on('data', chunk => { fatalErr += String(chunk); });
    expect({ code: await bounded(closed(fatal), fatal, 'FATAL_SERVICE_TIMEOUT'), stderr: fatalErr, stdout: fatalOut })
      .toEqual({ code: 0, stderr: '', stdout: fatalOut });
    const fatalEvents = fatalOut.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(fatalEvents).toMatchObject([
      { event: 'ready' },
      { event: 'fatal', failure: { resolved: false, code: 'LOCAL_RUNTIME_TRANSPORT', category: 'error' }, admission: 'rejected' },
    ]);

    restart = run(restartProgram, [sdk, project], env);
    let restartOut = '', restartErr = ''; restart.stdout.on('data', chunk => { restartOut += String(chunk); }); restart.stderr.on('data', chunk => { restartErr += String(chunk); });
    expect(await bounded(closed(restart), restart, 'RESTART_SERVICE_TIMEOUT')).toBe(0);
    expect(restartErr).toBe('');
    expect(restartOut.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ event: 'restarted' }, { event: 'stopped' }]);

    cliFatal = spawn(process.execPath, ['--import', preload, cli, 'runtime', 'serve', '--json'], {
      cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'],
    }) as Child;
    let cliOut = '', cliErr = ''; cliFatal.stdout.on('data', chunk => { cliOut += String(chunk); }); cliFatal.stderr.on('data', chunk => { cliErr += String(chunk); });
    expect(await bounded(closed(cliFatal), cliFatal, 'CLI_FATAL_TIMEOUT')).toBe(1);
    expect(cliOut).toContain('"event":"ready"');
    expect(cliErr).toContain('LOCAL_RUNTIME_TRANSPORT');

    const configPath = join(project, '.deckent/config.json');
    const graceConfig = JSON.parse(await readFile(configPath, 'utf8')) as { service: { headerTimeoutMs: number; shutdownGraceMs: number } };
    graceConfig.service.headerTimeoutMs = 10_000; graceConfig.service.shutdownGraceMs = 25;
    await writeFile(configPath, JSON.stringify(graceConfig));
    const gracePreload = join(root, 'inject-peer-fatal-with-half-open.mjs');
    await writeFile(gracePreload, `import {createRequire} from 'node:module';import {createConnection} from 'node:net';
      const require=createRequire(import.meta.url),injected=require(${JSON.stringify(test)}),key=require.resolve(${JSON.stringify(release)});
      const replacement=Object.freeze({...injected,createListener(...args){let listener,faulted=false;const accepted=args[2];
        args[2]=handoff=>{accepted(handoff);if(!faulted){faulted=true;setImmediate(()=>{listener.__testFailNextReadable(1);
          const trigger=createConnection(args[0]);trigger.on('error',()=>{});});}};
        listener=injected.createListener(...args);setImmediate(()=>{const held=createConnection(args[0],()=>held.write(Buffer.from([0,0])));held.on('error',()=>{});});return listener;}});
      require.cache[key]={id:key,filename:key,loaded:true,exports:replacement,children:[],paths:[]};`);
    cliGrace = spawn(process.execPath, ['--import', gracePreload, cli, 'runtime', 'serve', '--json'], {
      cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'],
    }) as Child;
    let graceOut = '', graceErr = ''; cliGrace.stdout.on('data', chunk => { graceOut += String(chunk); }); cliGrace.stderr.on('data', chunk => { graceErr += String(chunk); });
    expect(await bounded(closed(cliGrace), cliGrace, 'CLI_FATAL_GRACE_TIMEOUT')).not.toBe(0);
    expect(graceOut).toContain('"event":"ready"');
    expect(graceErr).toContain('RUNTIME_SERVICE_SHUTDOWN_INCOMPLETE');
  } finally {
    for (const child of [fatal, restart, cliFatal, cliGrace]) if (child && child.exitCode === null && child.signalCode === null) {
      const ending = closed(child); child.kill('SIGKILL'); await ending.catch(() => null);
    }
    clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
}, 25_000);
