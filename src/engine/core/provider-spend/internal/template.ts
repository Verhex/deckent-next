import { providerSpendBudgetSchema, type ProviderSpendBudget } from '#domain/index.js';
import { providerSpendEvidenceDigest } from './account.js';
type Template = Omit<ProviderSpendBudget, 'scopeId' | 'revision' | 'schemaVersion'>;
interface ProviderSpendTemplatePorts {
  template(): Promise<Template | null>; current(): Promise<ProviderSpendBudget | null>; configured(): Promise<boolean>;
  create(budget: ProviderSpendBudget, evidenceDigest: string): Promise<unknown>;
}
/** An existing account always wins. No balance, spend, reservation or account revision crosses this boundary. */
export async function applyProviderSpendTemplate(scopeId: string, source: { root: string; scopeId: string }, ports: ProviderSpendTemplatePorts) {
  const template = await ports.template(); if (!template) return { status: 'not-configured' as const };
  const current = await ports.current(); if (current) return { status: 'preserved' as const, budget: current };
  if (await ports.configured()) return { status: 'configured' as const };
  const budget = providerSpendBudgetSchema.parse({ ...template, schemaVersion: template.period ? 2 : 1, scopeId, revision: 1 });
  const evidenceDigest = providerSpendEvidenceDigest({ operation: 'project-budget-template.v1', source, budget });
  return { status: 'created' as const, result: await ports.create(budget, evidenceDigest) };
}
