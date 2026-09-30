/** Built-in protocol vocabulary, not grants or configurable business policy.
 * Extensions may use other identifiers in generic policy documents; this catalog advertises only implemented core operations.
 */
export const policyResources = Object.freeze({
  approval: Object.freeze({ kind: 'approval' as const, actions: Object.freeze(['inspect', 'decide', 'renew'] as const) }),
  task: Object.freeze({ kind: 'task' as const, actions: Object.freeze(['execute'] as const) }),
  attempt: Object.freeze({ kind: 'attempt' as const, actions: Object.freeze(['execute', 'release', 'reconcile', 'recover-output', 'cancel', 'evaluate', 'read-output', 'prepare-integration', 'deliver-integration', 'adopt-integration', 'rollback-integration'] as const) }),
  operation: Object.freeze({ kind: 'operation' as const, actions: Object.freeze(['execute', 'compensate', 'inspect'] as const) }),
  scope: Object.freeze({ kind: 'scope' as const, actions: Object.freeze(['inspect'] as const) }),
  pool: Object.freeze({ kind: 'pool' as const, actions: Object.freeze(['use'] as const) }),
  run: Object.freeze({ kind: 'run' as const, actions: Object.freeze(['create', 'inspect', 'cancel', 'reserve'] as const) }),
  service: Object.freeze({ kind: 'service' as const, actions: Object.freeze(['shutdown'] as const) }),
  modelActivation: Object.freeze({ kind: 'model-activation' as const, actions: Object.freeze(['activate', 'deactivate', 'inspect'] as const) }),
  modelInvocation: Object.freeze({ kind: 'model-invocation' as const, actions: Object.freeze(['invoke', 'inspect', 'inspect-content', 'purge-content', 'cancel-invocation'] as const) }),
  providerSpendAccount: Object.freeze({ kind: 'provider-spend-account' as const, actions: Object.freeze(['inspect', 'audit'] as const) }),
  // Terminal agent tools (T-L3): the resource id is the tool name; every call of the loop is authorized with action invoke.
  agentTool: Object.freeze({ kind: 'agent-tool' as const, actions: Object.freeze(['invoke'] as const) }),
  // A person setting their own terminal permission mode (T-L4 slice 4c): the resource id is the target mode; the rule never names
  // whose entry — only the caller's own entry is ever written. The mode itself creates no authority.
  permissionMode: Object.freeze({ kind: 'permission-mode' as const, actions: Object.freeze(['set'] as const) }),
  // A person's standing approval of one call pattern (PERSISTENT-APPROVALS G6): the resource id is the pattern key. It only lowers an approval.
  agentToolCall: Object.freeze({ kind: 'agent-tool-call' as const, actions: Object.freeze(['invoke'] as const) }),
  // A change of one stored secret of the installation's secret store (SECRET-WRITE, owner 2026-09-29 option A): the resource id is the secret's
  // name (the `$DECK:NAME` grammar). Reading a secret is not a policy action: references resolve for the configuration that names them.
  secret: Object.freeze({ kind: 'secret' as const, actions: Object.freeze(['set', 'delete'] as const) }),
  // A configured work target (WORK-TARGETS, owner 2026-09-30 K2 = A): the resource id is the target id of `execution.workTargets`.
  // `use` is checked at Run admission and reservation (like pool use), `adopt` when an adoption or rollback moves the target's branch.
  workTarget: Object.freeze({ kind: 'work-target' as const, actions: Object.freeze(['use', 'adopt'] as const) }),
});
export type CorePolicyResource = keyof typeof policyResources;
export type CorePolicyAction<R extends CorePolicyResource> = typeof policyResources[R]['actions'][number];
const vocabulary = Object.freeze({ schemaVersion: 1 as const, resources: Object.freeze(Object.values(policyResources)) });
/** Public metadata only. Catalog inclusion never grants an action or authenticates a principal. */
export function getPolicyVocabulary() { return vocabulary; }
