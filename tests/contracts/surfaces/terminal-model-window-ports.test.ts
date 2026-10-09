import { afterEach, describe, expect, it } from 'vitest';
import type { BudgetPanelPort, ConfigPanelOutcome, ModelPanelChoice, ModelPanelSource, ModelPanelView } from '#surfaces/core/terminal-panels/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

// FOLLOWUPS 2026-10-09 item 1: the real workline (in-memory TTY) rebuilt the host's `/model` source and dropped its optional `budget` and
// `resolveShadow` ports, so `/model` never showed "Create budget" nor the shadow remove/align choice. Panel-only tests passed the ports
// straight to the window and could not see it; this one goes through `useWorklineSettings`.
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
const DOWN = '\u001B[B', ENTER = '\r';
const ref = (modelId: string) => ({ providerId: 'local-openai', providerVersion: 1, modelId, modelVersion: 1 });
const MODELS: ModelPanelView = { title: 'Models · scope', notes: [], defaultBlocked: null, choices: [
  { reference: ref('chat'), label: 'chat', detail: 'ready', group: 'local-openai', blocked: null, configured: true, exact: 'EXACT-chat', command: null },
  { reference: ref('fast'), label: 'fast', detail: 'ready', group: 'local-openai', blocked: null, configured: false, exact: 'EXACT-fast', command: null }] };
const streamTurn = async function* () { yield { kind: 'text' as const, text: 'ok' }; yield { kind: 'done' as const, finish: 'stop' as const }; };

function source() {
  const asked: string[] = [], budgetRequests: unknown[] = [];
  const budget: BudgetPanelPort = { inspect: async () => ({ action: 'create', current: null, note: null, frozen: false, presets: [5, 10, 25, 50, 100], min: 1, max: 1000, step: 1, start: 5 }),
    apply: async request => { budgetRequests.push(request); return { ok: true, line: `Budget set: ${request.usd} USD` }; } };
  const model: ModelPanelSource = { inspect: async () => MODELS, budget,
    makeDefault: async (): Promise<ConfigPanelOutcome> => ({ status: 'applied', lines: ['Default saved'], approvalId: null, shadow: { projectModel: 'team-model' } }),
    resolveShadow: async (_choice: ModelPanelChoice, action: 'remove' | 'align') => { asked.push(action); return { status: 'applied', lines: ['PROJECT-MODEL-REMOVED'], approvalId: null }; } };
  return { model, asked, budgetRequests };
}
function open(model: ModelPanelSource) {
  const view = mountWorkline({ labels: WORKLINE_TEST_LABELS, streamTurn, panels: { ports: { model }, labels: terminalPanelLabels('en') } }, 120);
  mounted.push(view.instance);
  return view;
}

describe('/model in the workline carries the host budget and shadow ports', () => {
  it('shows "Create budget" first and its presets; the budget goes through the host port', async () => {
    const { model, budgetRequests } = source(), view = open(model);
    await settle(40);
    view.stdin.write(`/model${ENTER}`);
    await until(() => view.stdout.frame.includes('Models · scope'), 'model window');
    await until(() => view.stdout.frame.includes('Create budget'), 'budget row');
    await settle(60);
    view.stdin.write(ENTER);
    await until(() => view.stdout.frame.includes('25 USD'), 'budget presets');
    for (const key of [DOWN, DOWN, ENTER]) { view.stdin.write(key); await settle(30); }
    await until(() => view.stdout.frame.includes("Set this scope's shared budget to 25 USD?"), 'budget confirm');
    expect(budgetRequests).toEqual([]);
    view.stdin.write(ENTER);
    await until(() => budgetRequests.length === 1, 'budget applied');
    expect(budgetRequests).toEqual([{ action: 'create', usd: 25, unfreeze: false }]);
  });

  it('a shadowing project model offers remove / align in the same window and the answer reaches the host port', async () => {
    const { model, asked } = source(), view = open(model);
    await settle(40);
    view.stdin.write(`/model${ENTER}`);
    await until(() => view.stdout.frame.includes('Create budget'), 'model window with budget row');
    await settle(60);
    // Rows: Create budget, chat, fast. Pick fast, then "this session and the user default".
    for (const key of [DOWN, DOWN, ENTER]) { view.stdin.write(key); await settle(30); }
    for (const key of [DOWN, ENTER]) { view.stdin.write(key); await settle(30); }
    await until(() => view.stdout.frame.includes("Remove the project's model (your default applies)"), 'shadow choice');
    expect(view.stdout.frame).toContain("Make the project's model this one too");
    view.stdin.write(ENTER);
    await until(() => asked.length === 1, 'shadow answered');
    expect(asked).toEqual(['remove']);
  });

  it('a host without the optional ports shows neither row', async () => {
    const view = open({ inspect: async () => MODELS });
    await settle(40);
    view.stdin.write(`/model${ENTER}`);
    await until(() => view.stdout.frame.includes('Models · scope'), 'model window');
    await settle(60);
    expect(view.stdout.frame).not.toContain('Create budget');
  });
});
