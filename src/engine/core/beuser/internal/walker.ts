import { BeuserContractError, beuserSurfaceCommandSchema, assertBeuserAccess, type ModelPort, type SurfacePort, type BeuserScreen, type BeuserSurfaceCommand } from '#engine/core/beuser-contract/index.js';
import { beuserBindingSchema } from '#domain/index.js';
import { BeuserController, BeuserWalkStopped, beuserSettledScreen } from './controller.js';
import { correctBeuserModelOutput, type BeuserWalkerDecode } from './models.js';

/** The stops that are the persona's own (RED findings with the last screen): stuck in a loop, only observing, or out of wait patience. */
export type BeuserStopReason = 'loop' | 'observing' | 'patience';
const personaStop = (error: unknown): error is BeuserWalkStopped & { reason: BeuserStopReason } =>
  error instanceof BeuserWalkStopped && (error.reason === 'loop' || error.reason === 'observing' || error.reason === 'patience');

/** Only native model output is decoded; a model-authored verdict is never a completion signal. */
export async function walkBeuser(controller: BeuserController, ports: {
  readonly surface: SurfacePort; readonly models: ModelPort; readonly decode: BeuserWalkerDecode;
  /** Trusted installed journey tuple; never decoded from walker output. */
  readonly initialCommand?: Parameters<SurfacePort['argv']>[1] | undefined;
  readonly finished: (screen: BeuserScreen) => Promise<boolean>;
  readonly record: (screen: BeuserScreen) => Promise<void>;
  readonly stopped?: (screen: BeuserScreen, action: BeuserSurfaceCommand['action'], reason: BeuserStopReason) => Promise<void>;
}): Promise<void> {
  let screen = await controller.call('beuser-sandbox', 'create', context => ports.initialCommand
    ? ports.surface.argv(context, ports.initialCommand) : ports.surface.look(context));
  while (true) {
    controller.screen(screen);
    await controller.call('beuser-transcript', 'inspect', () => ports.record(screen));
    if (await controller.call('attempt', 'evaluate', () => ports.finished(screen))) return;
    const shown = screen;
    // One decision is one correction attempt: an unparseable answer or an action the surface refused before any input asks the walker again.
    screen = await correctBeuserModelOutput(controller.context, controller.summary.patience, async outputError => {
      const history = controller.history(shown);
      controller.step();
      controller.modelCall();
      const answer = await controller.call('attempt', 'evaluate', context => outputError
        ? ports.models.walker(context, controller.summary, shown, history, outputError) : ports.models.walker(context, controller.summary, shown, history), true);
      if (answer.state !== 'invoked' || answer.receipt.role !== 'beuser-walker'
        || answer.receipt.invocation.receipt.outcome?.state !== 'responded') throw new BeuserWalkStopped('unknown');
      const decoded = ports.decode(answer.receipt.invocation);
      const target = typeof decoded === 'object' && decoded !== null && 'binding' in decoded ? decoded.binding : null;
      if (!beuserBindingSchema.safeParse(target).success) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
      const parsed = beuserSurfaceCommandSchema.safeParse(decoded);
      if (!parsed.success) throw new BeuserWalkStopped('drift');
      const { context } = controller, action = parsed.data.action;
      assertBeuserAccess(context, parsed.data.binding, context.principal, { kind: 'beuser-sandbox', id: parsed.data.binding.realmId }, 'create');
      // Walk19R: a stop verdict, and (walk20) a key or text, first read the screen once more. A product that redrew after the screen the
      // persona decided on is decided again: no stop, and no input lands on a card the persona never saw. Unchanged, the read is retained.
      // A stop compares digit-masked screens (the loop equality); input compares the exact screen, since a digit can carry the choice
      // (`1: Deny; 2: Allow` swapped to `2: Deny; 1: Allow`).
      const retain = async (fresh: BeuserScreen) => { controller.screen(fresh); await controller.call('beuser-transcript', 'inspect', () => ports.record(fresh)); };
      const reread = async (same: (fresh: BeuserScreen) => boolean) => {
        const fresh = await controller.call('beuser-sandbox', 'create', ctx => ports.surface.look(ctx));
        const changed = !same(fresh);
        if (!changed) await retain(fresh);
        return { fresh, changed };
      };
      const stop = async (screen: BeuserScreen, error: BeuserWalkStopped & { reason: BeuserStopReason }): Promise<never> => {
        if (ports.stopped) await controller.call('beuser-transcript', 'inspect', () => ports.stopped!(screen, action, error.reason));
        throw error;
      };
      try { controller.action(shown, action); }
      catch (error) {
        if (error instanceof BeuserContractError && error.code === 'BEUSER_ACTION_INVALID') { controller.acted(shown, action, error.code); throw error; }
        if (!personaStop(error)) throw error;
        const { fresh, changed } = await reread(fresh => beuserSettledScreen(fresh) === beuserSettledScreen(shown));
        return changed ? fresh : stop(fresh, error);
      }
      if (action.kind === 'press' || action.kind === 'type') { const { fresh, changed } = await reread(fresh => fresh.digest === shown.digest); if (changed) return fresh; }
      try {
        const started = performance.now();
        const next = await controller.call('beuser-sandbox', 'create', ctx => action.kind === 'look' ? ports.surface.look(ctx)
          : action.kind === 'type' ? ports.surface.type(ctx, action.text) : action.kind === 'press' ? ports.surface.press(ctx, action.key) : ports.surface.wait(ctx, action.ms));
        // Walk20: a wait is charged its real time; one that ran past the wait patience left ends as persona-patience on the screen it returned.
        if (action.kind === 'wait') try { controller.wait(performance.now() - started); }
        catch (error) { if (personaStop(error)) { await retain(next); await stop(next, error); } throw error; }
        controller.acted(shown, action); return next;
      } catch (error) {
        if (error instanceof BeuserContractError && error.code === 'BEUSER_ACTION_INVALID') controller.acted(shown, action, error.code);
        throw error;
      }
    });
  }
}
