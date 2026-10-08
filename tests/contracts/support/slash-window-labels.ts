import { t } from '#platform/index.js';
import { pickerLabels } from '#surfaces/core/work-labels/index.js';
import type { SlashWindowLabels } from '#surfaces/core/terminal/index.js';

/** The rich terminal's slash-window words (`WorklineLabels.windows`, absent on TERM=dumb) from the EN catalog; their presence is what turns typed slash arguments off. */
const words = (key: string) => t(key, {}, 'en');
export const SLASH_WINDOW_TEST_LABELS: SlashWindowLabels = { picker: pickerLabels('en'), position: '{from}-{to}/{total}', hints: words('terminal.window.hints'),
  infoHints: words('terminal.window.infoHints'), typedArgument: words('terminal.window.typedArgument'),
  reasoning: { title: 'Reasoning', thinkingOn: 'on', thinkingOff: 'off', previewOn: 'shown', previewOff: 'hidden', current: 'current', thinkingOnDetail: '', thinkingOffDetail: '',
    previewOnDetail: '', previewOffDetail: '', statusOn: 'reasoning on', statusOnHidden: 'reasoning on · preview hidden', statusOff: 'reasoning off' },
  scratch: { title: 'Scratch', status: '{count} {bytes} {limit}', folder: 'Folder', more: '+{count}', empty: 'empty', fileDetail: '{bytes}', clear: 'Clear', clearDetail: '',
    clearTitle: 'Clear?', clearBody: '{count} {bytes} {path}', clearPrompt: 'y/n', pathTitle: 'Path' },
  unknown: { title: words('terminal.window.unknown.title'), body: words('terminal.window.unknown.body'), closest: words('terminal.window.unknown.closest'),
    none: words('terminal.window.unknown.none'), all: words('terminal.window.unknown.all'), allDetail: words('terminal.window.unknown.allDetail') } };
export const TYPED_ARGUMENT_NOTE = words('terminal.window.typedArgument');
