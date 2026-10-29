import { BeuserContractError, beuserSurfaceCommandSchema, assertBeuserAccess, type ModelPort, type SurfacePort, type BeuserScreen, type BeuserSurfaceCommand } from '#engine/core/beuser-contract/index.js';
import { beuserBindingSchema } from '#domain/index.js';
import { BeuserController, BeuserWalkStopped } from './controller.js';
import { correctBeuserModelOutput, type BeuserWalkerDecode } from './models.js';

/** Only native model output is decoded; a model-authored verdict is never a completion signal. */
export async function walkBeuser(controller: BeuserController, ports: {
  readonly surface: SurfacePort; readonly models: ModelPort; readonly decode: BeuserWalkerDecode;
  /** Trusted installed journey tuple; never decoded from walker output. */
  readonly initialCommand?: Parameters<SurfacePort['argv']>[1] | undefined;
  readonly finished: (screen: BeuserScreen) => Promise<boolean>;
  readonly record: (screen: BeuserScreen) => Promise<void>;
  readonly stopped?: (screen: BeuserScreen, action: BeuserSurfaceCommand['action']) => Promise<void>;
}): Promise<void> {
  let screen = await controller.call('beuser-sandbox', 'create', context => ports.initialCommand
    ? ports.surface.argv(context, ports.initialCommand) : ports.surface.look(context));
  while (true) {
    controller.screen(screen);
    await controller.call('beuser-transcript', 'inspect', () => ports.record(screen));
    if (await controller.call('attempt', 'evaluate', () => ports.finished(screen))) return;
    const history = controller.history(screen);
    const decoded = await correctBeuserModelOutput(controller.context, controller.summary.patience, async outputError => {
      controller.step();
      controller.modelCall();
      const answer = await controller.call('attempt', 'evaluate', context => outputError
        ? ports.models.walker(context, controller.summary, screen, history, outputError) : ports.models.walker(context, controller.summary, screen, history), true);
      if (answer.state !== 'invoked' || answer.receipt.role !== 'beuser-walker'
        || answer.receipt.invocation.receipt.outcome?.state !== 'responded') throw new BeuserWalkStopped('unknown');
      return ports.decode(answer.receipt.invocation);
    });
    const target = typeof decoded === 'object' && decoded !== null && 'binding' in decoded ? decoded.binding : null;
    if (!beuserBindingSchema.safeParse(target).success) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    const parsed = beuserSurfaceCommandSchema.safeParse(decoded);
    if (!parsed.success) throw new BeuserWalkStopped('drift');
    const command = parsed.data;
    const { context } = controller;
    assertBeuserAccess(context, command.binding, context.principal, { kind: 'beuser-sandbox', id: command.binding.realmId }, 'create');
    try { controller.action(screen, command.action); }
    catch (error) {
      if (error instanceof BeuserWalkStopped && error.reason === 'loop' && ports.stopped)
        await controller.call('beuser-transcript', 'inspect', () => ports.stopped!(screen, command.action));
      throw error;
    }
    const action = command.action;
    if (action.kind === 'wait') controller.wait(action.ms);
    screen = await controller.call('beuser-sandbox', 'create', ctx => action.kind === 'look' ? ports.surface.look(ctx)
      : action.kind === 'type' ? ports.surface.type(ctx, action.text) : action.kind === 'press' ? ports.surface.press(ctx, action.key) : ports.surface.wait(ctx, action.ms));
  }
}
