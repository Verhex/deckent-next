import { BeuserContractError, beuserSurfaceCommandSchema, assertBeuserAccess, type ModelPort, type SurfacePort, type BeuserScreen, type BeuserSurfaceCommand } from '#engine/core/beuser-contract/index.js';
import { beuserBindingSchema } from '#domain/index.js';
import { BeuserController, BeuserWalkStopped, beuserSettledScreen } from './controller.js';
import { correctBeuserModelOutput, type BeuserWalkerDecode } from './models.js';

/** Only native model output is decoded; a model-authored verdict is never a completion signal. */
export async function walkBeuser(controller: BeuserController, ports: {
  readonly surface: SurfacePort; readonly models: ModelPort; readonly decode: BeuserWalkerDecode;
  /** Trusted installed journey tuple; never decoded from walker output. */
  readonly initialCommand?: Parameters<SurfacePort['argv']>[1] | undefined;
  readonly finished: (screen: BeuserScreen) => Promise<boolean>;
  readonly record: (screen: BeuserScreen) => Promise<void>;
  readonly stopped?: (screen: BeuserScreen, action: BeuserSurfaceCommand['action'], reason: 'loop' | 'observing') => Promise<void>;
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
      try { controller.action(shown, action); }
      catch (error) {
        if (!(error instanceof BeuserWalkStopped && (error.reason === 'loop' || error.reason === 'observing'))) throw error;
        // Walk19R: a stop verdict reads the screen once more first; a product that redrew after the last read is answered, not stuck.
        const fresh = await controller.call('beuser-sandbox', 'create', ctx => ports.surface.look(ctx));
        if (beuserSettledScreen(fresh) !== beuserSettledScreen(shown)) return fresh;
        controller.screen(fresh);
        await controller.call('beuser-transcript', 'inspect', () => ports.record(fresh));
        if (ports.stopped) await controller.call('beuser-transcript', 'inspect', () => ports.stopped!(fresh, action, error.reason as 'loop' | 'observing'));
        throw error;
      }
      if (action.kind === 'wait') controller.wait(action.ms);
      try {
        const next = await controller.call('beuser-sandbox', 'create', ctx => action.kind === 'look' ? ports.surface.look(ctx)
          : action.kind === 'type' ? ports.surface.type(ctx, action.text) : action.kind === 'press' ? ports.surface.press(ctx, action.key) : ports.surface.wait(ctx, action.ms));
        controller.acted(shown, action); return next;
      } catch (error) {
        if (error instanceof BeuserContractError && error.code === 'BEUSER_ACTION_INVALID') controller.acted(shown, action, error.code);
        throw error;
      }
    });
  }
}
