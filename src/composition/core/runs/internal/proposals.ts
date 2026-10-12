import { userInfo } from 'node:os';
import { executionRegistrySchema, type RunProposal } from '#domain/index.js';
import { SystemTrustedClock, getConfigKnownSecrets, type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteRunProposalStore, openSqliteRunProposalReader, extractOpenAiChatTextFromInvocation } from '#adapters/index.js';
import { assertRunProposalSource, RunProposalApplication, RunProposalInspectionApplication, RunPolicyAuthorization, parseRunProposal,
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
    return await withConfiguredRunAdmission(projectRoot, context, options, async (runs, authority) => {
      const store = await openSqliteRunProposalStore(await context.path(), context.config.storage.sqlite);
      try {
        return await new RunProposalApplication(store, { verify: async () => context.principal }, authority, runs, {
          registry: context.config.admission ? executionRegistrySchema.parse(context.config.admission.registry).workClasses : undefined, clock: new SystemTrustedClock(),
          loadBudget: scopeId => readConfiguredRunBudget(projectRoot, scopeId, options),
          classifySpending: value => classifyConfiguredRunSpending(projectRoot, value, options),
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
  } catch (error) { throw queryFailure(error); }
}
export async function inspectConfiguredRunProposal(projectRoot: string, input: RunProposalQuery, options: ConfigLoadOptions = {}) {
  try {
    const query = runProposalQuerySchema.parse(input), context = await loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'read');
    // Lazy read-only connection: policy precedes even the ledger path/read; no keys, migrations or writer.
    return await new RunProposalInspectionApplication({ async loadProposal(scopeId, commandId) {
      const reader = await openSqliteRunProposalReader(await context.path(), context.config.storage.sqlite);
      try { return await reader.loadProposal(scopeId, commandId); } finally { reader.close(); }
    } }, { verify: async () => context.principal },
    new RunPolicyAuthorization(createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes))).inspect(query);
  } catch (error) { throw queryFailure(error); }
}
