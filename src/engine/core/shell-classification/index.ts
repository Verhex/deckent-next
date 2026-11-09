export { classifyReadOnlyShellCommand, type ShellDialect, type ShellReadOnlyVerdict } from './internal/classify.js';
export { classifyShellRisk, type ShellRisk, type ShellRiskClassification } from './internal/risk.js';
export { checkAwkProgram, checkSedScript } from './internal/scripts.js';
export type { ShellPathContext, ShellPathVerdict } from './internal/grammar.js';
export type { ShellReasonCode, ShellWord } from './internal/scanner.js';
export type { ShellReadRisk } from './internal/programs.js';
export { classifyShellMutation, NETWORK_PROGRAMS, PACKAGE_PROGRAMS, shellPermissionTier, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ShellMutationReason, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ShellMutationVerdict,
  type ShellPermissionTier, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ShellWriteKind, type ShellWritePathContext } from './internal/mutation.js';
export { classifyShellContainment, shellNamedPaths, shellGlobalStateUnresolved, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ShellContainmentReason, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ShellContainmentVerdict } from './internal/containment.js';
export { globSegmentRegExp } from './internal/glob.js';
export { classifyShellAuthority } from './internal/authority.js';
export { scanShellCommand, type ShellCommandScan } from './internal/scan.js';
