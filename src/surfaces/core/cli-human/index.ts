// L-KIT: one CLI toolkit for human output. Ink-free (CLI start must not reach ink/react: startup-graph test), so every command may use it.
export { AGENT_ENVIRONMENT, cliMode, detectCliMode, type CliMode, type CliModeReason } from './internal/mode.js';
export { formatAgo, formatBytes, formatClock, formatDecimal, formatDuration, orderPendingFirst } from './internal/format.js';
export { cliTableStyle, renderCliTable, safeCell, textCells, type CliTableColumn, type CliTableStyle } from './internal/table.js';
export { displayId, listRunIds, matchIdPrefix, requireIdPrefix, type IdMatch } from './internal/short-id.js';
export { resolveCommandScope, scopeLister, scopeNotice, type ScopePick, type ScopeResolution } from './internal/scope.js';
export { cliCardGate, standingCardOptions, type CliCardIo, type CliCardOption, type CliCardRequest, type StandingAnswer } from './internal/card.js';
export { renderInputSchema, schemaRequested } from './internal/schema.js';
export { acceptanceEvidenceText } from './internal/acceptance.js';
