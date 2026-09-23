/** Built-in protocol vocabulary, not grants or configurable business policy.
 * Extensions may use other identifiers in generic policy documents; this catalog advertises only implemented core operations.
 */
export const policyResources = Object.freeze({
  approval: Object.freeze({ kind: 'approval' as const, actions: Object.freeze(['inspect', 'decide', 'renew'] as const) }),
  task: Object.freeze({ kind: 'task' as const, actions: Object.freeze(['execute'] as const) }),
  attempt: Object.freeze({ kind: 'attempt' as const, actions: Object.freeze(['execute', 'release', 'reconcile', 'recover-output', 'cancel', 'evaluate', 'read-output', 'prepare-integration', 'deliver-integration', 'adopt-integration', 'rollback-integration'] as const) }),
  scope: Object.freeze({ kind: 'scope' as const, actions: Object.freeze(['inspect'] as const) }),
  pool: Object.freeze({ kind: 'pool' as const, actions: Object.freeze(['use'] as const) }),
  run: Object.freeze({ kind: 'run' as const, actions: Object.freeze(['create', 'inspect', 'cancel', 'reserve'] as const) }),
  service: Object.freeze({ kind: 'service' as const, actions: Object.freeze(['shutdown'] as const) }),
  modelActivation: Object.freeze({ kind: 'model-activation' as const, actions: Object.freeze(['activate', 'deactivate', 'inspect'] as const) }),
  modelInvocation: Object.freeze({ kind: 'model-invocation' as const, actions: Object.freeze(['invoke', 'inspect', 'inspect-content', 'purge-content', 'cancel-invocation'] as const) }),
  providerSpendAccount: Object.freeze({ kind: 'provider-spend-account' as const, actions: Object.freeze(['inspect', 'audit'] as const) }),
});
export type CorePolicyResource = keyof typeof policyResources;
export type CorePolicyAction<R extends CorePolicyResource> = typeof policyResources[R]['actions'][number];
const vocabulary = Object.freeze({ schemaVersion: 1 as const, resources: Object.freeze(Object.values(policyResources)) });
/** Public metadata only. Catalog inclusion never grants an action or authenticates a principal. */
export function getPolicyVocabulary() { return vocabulary; }
