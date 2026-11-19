import { vi, onTestFinished } from 'vitest';
import { toolErrorClass, type ToolErrorClass } from '#capabilities/index.js';
import * as engine from '#engine/index.js';
import { DatabaseSync } from 'node:sqlite';
import { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { runtime } from './chat-turn-harness.js';

export async function toolProducer(extraGrants: Record<string, unknown>[] = []) {
  const { project, data, env, rows, ledger } = await runtime({ noServer: true, extraGrants });
  const signal = new AbortController().signal;
  const peer = { pid: process.pid, uid: process.getuid!(), gid: process.getgid!(), assurance: 'linux-so-peercred' as const,
    connection: signal, isConnectionActive: () => !signal.aborted };
  const scopeId = 'scope', options = { env };
  const context = await loadPeerInvocationContext(project, scopeId, options, peer, 'write');
  return { project, data, env, rows, ledger, peer, context, options, scopeId, signal, turnId: 'producer' };
}

/** Fail only the post-target update. The initial claim and every other journal remain writable. */
export function failEffectRecordWrite(ledger: string) {
  const db = new DatabaseSync(ledger);
  try { db.exec("CREATE TRIGGER fail_effect_update BEFORE UPDATE ON effect_intents BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END"); }
  finally { db.close(); }
}

/** Observe the production executor's private result at the turn port, before the wire projection drops the class. */
export function observeToolOutcomes() {
  const observed: ('ok' | ToolErrorClass)[] = [], run = engine.runDurableAgentTurn;
  const spy = vi.spyOn(engine, 'runDurableAgentTurn').mockImplementation((input, store, ports) =>
    run(input, store, { ...ports, async execute(...args) {
      const result = await ports.execute(...args);
      observed.push(result.status === 'ok' ? 'ok' : toolErrorClass(result));
      return result;
    } }));
  onTestFinished(() => { spy.mockRestore(); });
  return observed;
}
