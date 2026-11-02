import { applyProviderSpendTemplate } from '#engine/index.js';
import { providerSpendingConfiguredBudget, providerSpendingTemplate } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { inspectConfiguredProviderSpendAccount } from './inspect.js';
import { manageConfiguredProviderSpend } from './manage.js';
export const applyConfiguredProviderSpendTemplate = (root: string, scopeId: string, source: { root: string; scopeId: string }, options: ConfigLoadOptions = {}) =>
  applyProviderSpendTemplate(scopeId, source, {
    template: async () => providerSpendingTemplate((await loadConfiguredScopeContext(source.root, source.scopeId, options, 'read')).config, source.scopeId),
    current: async () => (await inspectConfiguredProviderSpendAccount(root, { schemaVersion: 1, scopeId, current: true }, options)).checkpoint?.account.budget ?? null,
    configured: async () => !!providerSpendingConfiguredBudget((await loadConfiguredScopeContext(root, scopeId, options, 'read')).config, scopeId),
    create: (budget, evidenceDigest) => manageConfiguredProviderSpend(root, { schemaVersion: 1, kind: 'budget-create', scopeId, budgetId: budget.budgetId,
      budgetRevision: 1, budget, commandId: `project-budget-${evidenceDigest}`, evidenceDigest }, options),
  });
