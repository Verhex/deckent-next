import type { ConfigLoadOptions } from '#platform/index.js';
import type { PolicyAdministrationQuery, PolicyAdministrationStatus } from '#engine/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { PolicyUpgradeHandler, StandingGrantsHandler, StandingRevokeHandler } from './policy-grants.js';
import type { AllStandingGrantsHandler } from './policy-grants-all.js';
import type { RecoveryHandlers } from './recovery.js';

/** The host operations the `approval` and `policy` commands use; the CLI's full command context satisfies it. */
export interface ApprovalCommandContext extends CliBaseContext, Pick<TerminalLaunchContext, 'decideApproval' | 'listApprovals' | 'mcpCapabilities' | 'delegations' | 'configChoiceSources'> {
  renewApproval?: (input: unknown) => Promise<unknown>;
  inspectApproval?: (input: unknown) => Promise<unknown>;
  // Doctor-only, read-soft (SCR-B): null on a missing/unsafe/custom policy, never a hard failure of `doctor`.
  listStandingGrants?: StandingGrantsHandler;
  /** CA-1: everyone's standing approvals, decided by `policy inspect-standing-grants`. */
  listAllStandingGrants?: AllStandingGrantsHandler;
  revokeStandingGrant?: StandingRevokeHandler;
  inspectPolicyAdministration?: (root: string, query: PolicyAdministrationQuery, options: ConfigLoadOptions) => Promise<PolicyAdministrationStatus>;
  upgradePolicyTemplate?: PolicyUpgradeHandler;
  /** alpha.56: the lost-worker recovery cards (`deckent policy recovery`, `deckent recovery [review]`). */
  recovery?: RecoveryHandlers;
}
