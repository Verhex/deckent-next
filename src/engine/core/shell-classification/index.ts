export { classifyReadOnlyShellCommand, type ShellDialect, type ShellReadOnlyVerdict } from './internal/classify.js';
export { classifyShellRisk, type ShellRisk, type ShellRiskClassification } from './internal/risk.js';
export { checkAwkProgram, checkSedScript } from './internal/scripts.js';
export type { ShellPathContext, ShellPathVerdict } from './internal/grammar.js';
export type { ShellReasonCode, ShellWord } from './internal/scanner.js';
export type { ShellReadRisk } from './internal/programs.js';
