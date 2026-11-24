import { DeckentError, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { localPrincipalChannel } from '#adapters/index.js';
import { authenticate, verifiedPrincipal, RunApplication, runCommandSchema, projectRunView, PolicyAuthorizationError, RunPolicyAuthorization, type RunCommand } from '#engine/index.js';
import { openConfiguredLedger } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { runControlContext, runControlFailure, withRunControlBindingLocks } from './authority.js';

type CancellationContext = Awaited<ReturnType<ReturnType<typeof runControlContext>>>;
type CancellationStore = Awaited<ReturnType<typeof openConfiguredLedger>>;
type RecordedCancellation = Readonly<{ receipt: Awaited<ReturnType<RunApplication['execute']>>; context: CancellationContext; runs: RunApplication; store: CancellationStore }>;

/** Record the intent under the binding locks. Delivery, if requested, resumes from that durable receipt. */
export async function withRecordedRunCancellation<T>(projectRoot: string, input: RunCommand, options: ConfigLoadOptions,
  use: (result: RecordedCancellation) => T | Promise<T>, validate?: (context: CancellationContext) => void): Promise<T> {
  let store: CancellationStore | undefined;
  try {
    const command = runCommandSchema.parse(input), loadContext = runControlContext(projectRoot, command.scopeId, options);
    const initial = await loadContext(), expected = initial.runControlBinding(), verifier = verifiedPrincipal(initial.principal);
    const actor = await authenticate(verifier, undefined, command.scopeId);
    const policy = new RunPolicyAuthorization({ async load() { return (await loadContext(expected)).document; } });
    const committed = await withRunControlBindingLocks(initial, options, async admitWrite => {
      const context = await loadContext(expected);
      const authorization = new RunPolicyAuthorization({ async load() { return context.document; } });
      // Declared scope membership is admitted before the action decision, on the verified binding.
      await admitWrite(context);
      await authorization.authorize('cancel', command, actor);
      validate?.(context);
      store = await openConfiguredLedger(context, { migration: 'forbid' });
      const runs = new RunApplication(store, verifier, authorization);
      return { receipt: await runs.execute(command), context, runs, store };
    }).catch(async (error: unknown) => {
      if (localPrincipalChannel() && error instanceof DeckentError && ['CONFIG_WRITE_LOCKED', 'CONFIG_READ_IO_HOLD', 'CONFIG_CONCURRENT_REVISION_HOLD'].includes(error.code)) {
        try { await policy.authorize('inspect', command, actor); }
        catch (refusal) { throw refusal instanceof PolicyAuthorizationError && refusal.code === 'POLICY_APPROVAL_UNSUPPORTED' ? ErrorRegistry.createError('POLICY_DENIED') : refusal; }
      }
      throw error;
    });
    return await use(committed);
  } catch (error) { throw queryFailure(runControlFailure(error)); }
  finally { store?.close(); }
}

/** Durable cancellation intent only. Delivery to supervisors and proof of termination are separate;
 * a successful response must never be presented as stopped workers or reversed external effects.
 */
export function requestConfiguredRunCancellation(projectRoot: string, input: RunCommand, options: ConfigLoadOptions = {}) {
  return withRecordedRunCancellation(projectRoot, input, options, ({ context: { layout }, receipt }) => Object.freeze({ schemaVersion: 1 as const, layout,
    cancellation: Object.freeze({ schemaVersion: 1 as const, commandId: receipt.commandId, run: projectRunView(receipt.snapshot) }) }));
}
