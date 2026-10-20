// I-S4: bare `deckent init` renders the setup plan (engine/core/setup) as a window, JSON or plain lines. The window view (Ink) lives with
// today's init window in project-instructions and loads only after the mode decision picked a person on a real terminal.
export { setupInitCommand, setupFormat, parseSetupFlags, unattendedAnswers, type SetupFlags, type SetupFormat } from './internal/command.js';
export { activeStage, createSetupController, stageChoices } from './internal/controller.js';
export { observeCoreSetup, observeSetup, suggestScope } from './internal/observe.js';
export { renderSetupLines, setupDocument, setupMessage, SETUP_DOCUMENT_SCHEMA_VERSION, type SetupDocument } from './internal/render.js';
export { isForegroundStage, runForegroundStage } from './internal/foreground.js';
export { notWiredApply, type SetupApplyHandler, type SetupApplyOptions, type SetupObserveOptions, type SetupApplyResult, type SetupCommandContext, type SetupObserveHandler } from './internal/contract.js';
