// L-KIT: one CLI toolkit for human output. Ink-free at import (CLI start must not reach ink/react: startup-graph test), so every command may
// use it; only askCliCard loads its Ink view (./internal/card-view.js) lazily, after the TTY gate.
export { AGENT_ENVIRONMENT, cliMode, detectCliMode, type CliMode, type CliModeReason } from './internal/mode.js';
export { formatAgo, formatBytes, formatClock, formatDecimal, formatDuration, formatKnown, formatUsd, orderPendingFirst, untitledWorkName } from './internal/format.js';
export { cliTableStyle, renderCliTable, safeCell, textCells, type CliTableColumn, type CliTableStyle } from './internal/table.js';
export { displayId, listRunIds, matchIdPrefix, requireIdPrefix, type IdMatch } from './internal/short-id.js';
export { resolveCommandScope, scopeLister, scopeNotice, type ScopePick, type ScopeResolution } from './internal/scope.js';
export { holdTerminalInput, lendHeldInput } from './internal/input-hold.js';
export { askCliCard, cliCardGate, standingCardOptions, type CliCardIo, type CliCardOption, type CliCardRequest, type StandingAnswer } from './internal/card.js';
export { assertInputFields, renderInputSchema, schemaRequested, type InputSchema } from './internal/schema.js';
export { acceptanceEvidenceQualifier, acceptanceEvidenceText } from './internal/acceptance.js';
export { withFounderStep } from './internal/refusal.js';
export { heldPoolId, runStatusKey } from './internal/run-status.js';
export { reopenRetiredFolder } from './internal/reopen.js';
