export { monitorWindowView, type MonitorWindowView } from './window-view.js';
export { MonitorApp, MonitorBody, type MonitorAppProps, type MonitorBodyProps } from './app.js';
export { renderMonitorText, wrapDetail, type MonitorTextOptions } from './text.js';
export { buildMonitorView, filterSnapshot, type MonitorFilters, type MonitorView } from './view.js';
export { flattenBlocks, lineText, describeDiagnostic, describeDiagnostics, configMonitorBlocks, type MonitorLine, type MonitorSpan, type MonitorBlock, type MonitorDiagnostic } from '#surfaces/core/monitor-view/index.js';
export { monitorFailureText } from './command.js';
export { rowMatches, applyControls, changeMarks, signatures, type MonitorControls } from './controls.js';

export { legendLines } from './legend.js';
