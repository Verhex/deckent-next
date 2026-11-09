// Frozen v16 delta from c1e5f8fab; fixture exclusion data, never a second production API.
export const FIRST_RUN_V16_RULE_IDS: readonly string[] = Object.freeze([
  "first-run-recovery-action-fence-attempt",
  "first-run-recovery-action-hold-run",
  "first-run-recovery-action-stop-orphan",
  "first-run-recovery-action-restart-component",
  "first-run-recovery-action-alert-brain",
  "first-run-recovery-action-hand-to-human",
  "first-run-recovery-action-continue-new-attempt",
  "first-run-recovery-promote-container-gone",
  "first-run-recovery-promote-launcher-dead-orphan",
  "first-run-recovery-promote-launcher-dead-gone"
]);
// Frozen v18 delta from 4466a4e33 (the rollback delta until v19 moved it on).
export const FIRST_RUN_V18_RULE_IDS: readonly string[] = Object.freeze(["first-run-uninstall", "first-run-uninstall-operations"]);
// Frozen v19 delta (R4a, the MCP actor's tool rules; the rollback delta until v20 moved it on).
export const FIRST_RUN_V19_RULE_IDS: readonly string[] = Object.freeze(['first-run-mcp-model-invocation', 'first-run-mcp-read-tools', 'first-run-mcp-scratch-tools', 'first-run-mcp-edit-shell-tools', 'first-run-mcp-tool-operations']);
