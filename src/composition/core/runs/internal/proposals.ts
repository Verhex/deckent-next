import { withPlanningSpending } from './planning-spending.js';
import { userInfo } from 'node:os';
import type { RunProposal } from '#domain/index.js';
import { SystemTrustedClock, getConfigKnownSecrets, type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteRunProposalStore, openSqliteRunProposalReader, openSqliteModelCatalogReader, extractOpenAiChatTextFromInvocation } from '#adapters/index.js';
import { agentSelectionSummary, assertRunProposalSource, configuredProposalRegistry, RunProposalApplication, RunProposalInspectionApplication, RunPolicyAuthorization, parseRunProposal,
  runProposalQuerySchema, type RunProposalQuery } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { readConfiguredRunBudget, classifyConfiguredRunSpending } from './budget.js';
import { inspectConfiguredModelInvocation } from '#composition/core/model-invocation/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { withConfiguredRunAdmission } from './create.js';
export async function proposeConfiguredRun(projectRoot: string, input: RunProposal, options: ConfigLoadOptions = {}) {
  try {
    const proposal = parseRunProposal(input), context = await loadConfiguredScopeContext(projectRoot, proposal.scopeId, options, 'write');
    const result = await withConfiguredRunAdmission(projectRoot, context, options, async (runs, authority, _warnings, agents) => {
      const store = await openSqliteRunProposalStore(await context.path(), context.config.storage.sqlite);
      try {
        return await new RunProposalApplication(store, { verify: async () => context.principal }, authority, runs, {
          registry: configuredProposalRegistry(context.config.admission), clock: new SystemTrustedClock(),
          loadBudget: scopeId => readConfiguredRunBudget(projectRoot, scopeId, options), selectAgents: async value => agentSelectionSummary(await agents(value.graph, context.config.admission?.registry, value.scopeId)),
          classifySpending: value => classifyConfiguredRunSpending(projectRoot, value, options,
            async () => openSqliteModelCatalogReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs })),
          async verifySource(value) {
            if (value.source.kind === 'human') return;
            const reference = value.source.receipt;
            const inspected = await inspectConfiguredModelInvocation(projectRoot,
              { schemaVersion: 2, scopeId: value.scopeId, invocationId: reference.invocationId, reference: reference.reference,
                ...(value.source.contribution ? { includeResponseContent: true } : {}) }, options);
            const content = inspected.responseContent;
            const text = content?.kind === 'native-response' && inspected.invocation ? extractOpenAiChatTextFromInvocation({ replayed: true,
              receipt: inspected.invocation, response: content.response, contentStatus: 'retained', purge: null }) : null;
            assertRunProposalSource(value, inspected.invocation, text, getConfigKnownSecrets(context.config));
          },
        }).propose(proposal);
      } finally { store.close(); }
    });
    return await withPlanningSpending(projectRoot, result, options);
  } catch (error) { throw queryFailure(error); }
}
export async function inspectConfiguredRunProposal(projectRoot: string, input: RunProposalQuery, options: ConfigLoadOptions = {}) {
  try {
    const query = runProposalQuerySchema.parse(input), context = await loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'read');
    // Lazy read-only connection: policy precedes even the ledger path/read; no keys, migrations or writer.
    const result = await new RunProposalInspectionApplication({ async loadProposal(scopeId, commandId) {
      const reader = await openSqliteRunProposalReader(await context.path(), context.config.storage.sqlite);
      try { return await reader.loadProposal(scopeId, commandId); } finally { reader.close(); }
    } }, { verify: async () => context.principal },
    new RunPolicyAuthorization(createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes)), configuredProposalRegistry(context.config.admission)).inspect(query);
    return result ? await withPlanningSpending(projectRoot, result, options) : null;
  } catch (error) { throw queryFailure(error); }
}
