export { classifyReadOnlyShellCommand, type ShellDialect, type ShellReadOnlyVerdict } from './internal/classify.js';
export { classifyShellRisk, type ShellRisk, type ShellRiskClassification } from './internal/risk.js';
export { checkAwkProgram, checkSedScript } from './internal/scripts.js';
export type { ShellPathContext, ShellPathVerdict } from './internal/grammar.js';
export type { ShellReasonCode, ShellWord } from './internal/scanner.js';
export type { ShellReadRisk } from './internal/programs.js';
export { classifyShellMutation, NETWORK_PROGRAMS, PACKAGE_PROGRAMS, shellPermissionTier, type ShellMutationReason, type ShellMutationVerdict,
  type ShellPermissionTier, type ShellWriteKind, type ShellWritePathContext } from './internal/mutation.js';
export { classifyShellContainment, shellNamedPaths, type ShellContainmentReason, type ShellContainmentVerdict } from './internal/containment.js';
export { globSegmentRegExp } from './internal/glob.js';
