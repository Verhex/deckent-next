/** Built-in protocol vocabulary, not grants or configurable business policy.
 * Extensions may use other identifiers in generic policy documents; this catalog advertises only implemented core operations.
 */
export const policyResources = Object.freeze({
  attempt: Object.freeze({ kind: 'attempt' as const, actions: Object.freeze(['execute', 'release', 'reconcile', 'recover-output', 'cancel', 'evaluate'] as const) }),
  scope: Object.freeze({ kind: 'scope' as const, actions: Object.freeze(['inspect'] as const) }),
  pool: Object.freeze({ kind: 'pool' as const, actions: Object.freeze(['use'] as const) }),
  run: Object.freeze({ kind: 'run' as const, actions: Object.freeze(['create', 'inspect', 'cancel', 'reserve'] as const) }),
  service: Object.freeze({ kind: 'service' as const, actions: Object.freeze(['shutdown'] as const) }),
  modelActivation: Object.freeze({ kind: 'model-activation' as const, actions: Object.freeze(['activate', 'deactivate'] as const) }),
});
export type CorePolicyResource = keyof typeof policyResources;
export type CorePolicyAction<R extends CorePolicyResource> = typeof policyResources[R]['actions'][number];
const vocabulary = Object.freeze({ schemaVersion: 1 as const, resources: Object.freeze(Object.values(policyResources)) });
/** Public metadata only. Catalog inclusion never grants an action or authenticates a principal. */
export function getPolicyVocabulary() { return vocabulary; }
