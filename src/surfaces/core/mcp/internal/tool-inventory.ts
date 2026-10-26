/** MCP write-tool inventory outside the capability groups (owner 2026-10-18 g4-mcp-grup hide_until_slice, Jev 3816ff64).
 * Every advertised write tool is either listed by an MCP capability group cell or named here with its reason; the policy catalog test
 * derives the advertised set from the server built with every application handler, so a new ungrouped write tool fails until it is decided. */
export const MCP_WITHHELD_TOOLS = Object.freeze({
  // Installation-wide pool quota release: no group grants pool/release-quota to an MCP actor, so it is not advertised until the
  // post-beta delegation slice. CLI/SDK/terminal keep the same application for the person.
  release_quota: 'post-beta-delegation-slice',
} as const);

/** Advertised write tools no capability group lists. Policy still decides each call; listing here grants nothing. */
export const MCP_UNGROUPED_WRITE_TOOLS = Object.freeze({
  connect_model: 'person-activation-preflight-or-separate-scoped-grant',
  manage_provider_spending: 'separate-budget-grant-ai-reconcile-non-delegable',
  purge_model_invocation_content: 'separate-person-content-purge-grant',
  // Only the ordinary operator control is advertised: hold, and resume of an operator hold, under the existing run cancel/reserve
  // policy. The human step (close, resume of any other park) stays unadvertised until the post-beta delegation slice.
  control_run: 'human-step-withheld-until-delegation-slice',
  // The Run create decision (run/create) and its approval card decide; MCP cannot decide approvals. Tool rows stay out of the add-only groups.
  plan_run: 'run-create-policy-and-approval',
  propose_run: 'run-create-policy-and-approval',
  // Writes plan/receipt/proposal artifacts under the installation's toolchains.update mode, never installed config.
  update_toolchains: 'toolchains-update-config-mode',
  // S8-4 (S8-DESIGN §8, §9): signed catalog writes. AI grants are a separate person act scoped to exact ids (a WorkClass for standing actions), so no
  // capability cell with `ids: all` offers them; each call needs the MCP actor's own active key and is verified at commit.
  define_agent: 'signed-catalog-action-scoped-grant', define_skill: 'signed-catalog-action-scoped-grant', import_skill: 'signed-catalog-action-scoped-grant',
  change_agent_standing: 'signed-catalog-action-scoped-grant', dismiss_agent_suggestion: 'signed-catalog-action-scoped-grant',
} as const);

export type McpWithheldTool = keyof typeof MCP_WITHHELD_TOOLS;
export const isMcpWithheldTool = (name: string): name is McpWithheldTool => Object.hasOwn(MCP_WITHHELD_TOOLS, name);
