import { planningSpendingLines } from '#surfaces/core/run-planning/index.js';
import { resolve } from 'node:path';
import { currencyAmountText, t, emit, loadConfig, ErrorRegistry, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { parseRunProposal, runProposalQuerySchema, type RunProposalQuery, type RunProposalResult } from '#engine/index.js';
import type { RunProposal } from '#domain/index.js';
import { cliUsage, commandLocale } from '#surfaces/core/cli-kit/index.js';
import { readGraphInput } from './graph-input.js';
import type { RunCommandContext } from './context.js';
export type RunProposalHandler = (root: string, command: RunProposal, options: ConfigLoadOptions) => Promise<RunProposalResult>;
export type RunProposalInspectHandler = (root: string, query: RunProposalQuery, options: ConfigLoadOptions) => Promise<RunProposalResult | null>;
export function renderRunProposal(data: RunProposalResult, locale: Locale): string {
  const r = data.proposal;
  const states = { recorded: t('proposal.status.recorded', {}, locale), pending: t('proposal.status.pending', {}, locale), accepted: t('proposal.status.accepted', {}, locale), rejected: t('proposal.status.rejected', {}, locale), parked: t('proposal.status.parked', {}, locale) } as const;
  const nextParams = { scope: r.proposal.scopeId, run: r.proposal.runId, command: r.proposal.commandId };
  const next = { recorded: t('proposal.next.recorded', nextParams, locale), pending: t('proposal.next.pending', nextParams, locale), accepted: t('proposal.next.accepted', nextParams, locale), rejected: t('proposal.next.rejected', nextParams, locale), parked: t('proposal.next.parked', nextParams, locale) } as const;
  return [t('proposal.summary', { proposal: r.proposal.proposalId, run: r.proposal.runId, status: states[r.status], revision: r.revision }, locale),
    t('proposal.attribution', { actor: r.proposal.proposer.id, scope: r.proposal.scopeId, source: r.proposal.source.kind }, locale),
    ...(r.reason ? [ErrorRegistry.createError(r.reason, { locale, ...(data.reasonParams ? { params: data.reasonParams } : {}) }).message] : []),
    ...(r.approval ? [t('proposal.approval', { id: r.approval.approvalId, expiry: r.approval.expiresAt }, locale)] : []),
    ...(data.budgetSemantics === 'not-metered' ? [t('proposal.budget.notMetered', {}, locale)] : [
      t('proposal.budget', { amount: currencyAmountText(r.proposal.budgetCeiling.limitMinorUnits, r.proposal.budgetCeiling.currency, locale),
        status: r.binding.admission ? t('proposal.budget.checked', {}, locale) : t('proposal.budget.unchecked', {}, locale) }, locale),
      t('proposal.budget.notice', {}, locale)]),
    ...planningSpendingLines(data, locale),
    next[r.status],
  ].join('\n');
}
export async function runProposalCommand(argv: readonly string[], context: RunCommandContext, initialLocale: Locale) {
  const action = argv[1], allowed = action === 'propose' ? ['--proposal', '--lang'] : ['--scope', '--id', '--command-id', '--lang'];
  const values = new Map<string, string>(); let json = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--no-color') continue;
    if (!allowed.includes(arg) || values.has(arg)) throw cliUsage('run', action, initialLocale);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw cliUsage('run', action, initialLocale, arg);
    values.set(arg, value);
  }
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const locale = commandLocale(context, values.get('--lang'));
  let data: RunProposalResult | null;
  if (action === 'propose') {
    const source = values.get('--proposal'); if (!source) throw cliUsage('run', action, locale, '--proposal');
    if (!context.proposeRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const config = await loadConfig(root, options);
    const proposal = parseRunProposal(await readGraphInput(source === '-' ? source : resolve(root, source), config.cli.graphInputMaxBytes, context.stdin));
    data = await context.proposeRun(root, proposal, options);
  } else {
    const scopeId = values.get('--scope'), runId = values.get('--id'), commandId = values.get('--command-id');
    if (!scopeId || !runId || !commandId) throw cliUsage('run', action, locale);
    if (!context.inspectRunProposal) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    data = await context.inspectRunProposal(root, runProposalQuerySchema.parse({ schemaVersion: 1, scopeId, runId, commandId }), options);
  }
  if (!data) throw ErrorRegistry.createError('RUN_PROPOSAL_NOT_FOUND');
  emit(data, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: value => renderRunProposal(value, locale) });
}
