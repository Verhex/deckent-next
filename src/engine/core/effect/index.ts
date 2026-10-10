export { EffectApplication, EffectTargetError, OperationPolicyAuthorization, refuseRequiredApproval } from './internal/application.js';
export type { OperationCatalog, EffectApplyRequest, EffectTarget, EffectTargets, EffectStore, EffectApprovalGate, EffectApprovalContext, EffectAdmission,
  EffectApprovalPendingRequest, EffectApprovalPending, EffectOutcome, EffectResult } from './internal/application.js';
export { applySandboxWriteSet, describeSandboxWriteSet } from './internal/sandbox-writes.js';
export type { SandboxWriteCell, SandboxWriteChange, SandboxWriteDecider, SandboxWriteDecision, SandboxWriteRefusal, SandboxWriteSetReport, SandboxWriteSetScan } from './internal/sandbox-writes.js';
