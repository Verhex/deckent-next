import { useState } from 'react';
import { useApp } from 'ink';
import { ErrorRegistry, emit, resolveLocale, colorCapability, loadConfigTerminalLaunch, type ConfigLoadOptions, type Locale, type OutputSink } from '#platform/index.js';
import type { ProjectInstructionPort, InstructionInitPreview } from '#engine/index.js';
import { WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { humanRecordText } from '#surfaces/core/terminal-render/index.js';
import { terminalPalette, TERMINAL_THEME_SETTINGS } from '#surfaces/core/terminal-kit/index.js';
import { runTerminalHost } from '#surfaces/core/terminal-host/index.js';
import { InstructionChoiceWindow } from './window.js';
import { projectInstructionLabels, projectSkeleton, type ProjectInstructionLabels } from './labels.js';

export function InstructionInitWindow(props: { readonly port: ProjectInstructionPort; readonly initial: InstructionInitPreview; readonly labels: ProjectInstructionLabels;
  readonly skeleton: (name: string, commands: readonly string[]) => string; readonly finish: (result: unknown, error?: unknown) => void }) {
  const [applying, setApplying] = useState(false), { exit } = useApp();
  const done = (result: unknown, error?: unknown) => { props.finish(result, error); exit(); };
  const onChoice = async (index: number | null) => {
    if (applying) return;
    if (index !== 1) { done(null); return; }
    setApplying(true);
    try { done(await props.port.initialize(props.initial)); } catch (error) { done(null, error); }
  };
  const body = props.initial.changes.flatMap(change => [change.path, ...humanRecordText(change.append).split('\n')]);
  return <WindowStackProvider><InstructionChoiceWindow title={props.labels.initTitle}
    labels={props.labels} choices={applying ? [] : [props.labels.cancel, props.labels.confirm]} body={body} onChoice={index => { void onChoice(index); }} /></WindowStackProvider>;
}

export async function instructionInitCommand(argv: readonly string[], context: { readonly root?: string; readonly env?: NodeJS.ProcessEnv; readonly stdout?: OutputSink;
  readonly stderr?: OutputSink; readonly locale?: Locale; readonly onLocale?: (locale: Locale) => void; readonly openProjectInstructions?: (root: string, options: ConfigLoadOptions) => Promise<ProjectInstructionPort> }) {
  let previewOnly = false, language: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === '--preview' && !previewOnly) previewOnly = true;
    else if (argv[index] === '--lang' && language === undefined) { language = argv[++index]; if (!language) throw ErrorRegistry.createError('CLI_USAGE'); }
    else if (argv[index] !== '--no-color') throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (!context.openProjectInstructions) throw ErrorRegistry.createError('CLI_USAGE');
  const locale = resolveLocale(language, context.env, context.locale), labels = projectInstructionLabels(locale); context.onLocale?.(locale);
  const port = await context.openProjectInstructions(context.root ?? process.cwd(), { env: context.env ?? process.env });
  const skeleton = projectSkeleton(locale), preview = await port.preview([], skeleton);
  const stdout = (context.stdout ?? process.stdout) as NodeJS.WriteStream;
  if (previewOnly) { emit({ schemaVersion: preview.schemaVersion, digest: preview.digest, changes: preview.changes.map(change => ({ path: change.path, append: humanRecordText(change.append) })), bridges: preview.bridges }, { stdout, json: true }); return; }
  if (!process.stdin.isTTY || !stdout.isTTY || typeof process.stdin.setRawMode !== 'function' || context.env?.['TERM'] === 'dumb') throw ErrorRegistry.createError('TERMINAL_TTY_REQUIRED');
  let result: unknown = null, failure: unknown;
  const env = context.env ?? process.env;
  const presentation = await loadConfigTerminalLaunch(context.root ?? process.cwd(), { env }).catch(() => null);
  const setting = TERMINAL_THEME_SETTINGS.find(value => value === presentation?.terminal['theme']) ?? TERMINAL_THEME_SETTINGS[0];
  const theme = { setting, capability: colorCapability({ env, isTTY: true, argv }), colorfgbg: env['COLORFGBG'] };
  await runTerminalHost({ palette: terminalPalette(setting, theme.capability, theme.colorfgbg), theme, stdout, stdin: process.stdin, clearScreen: false, fullscreen: false,
    view: () => <InstructionInitWindow port={port} initial={preview} labels={labels} skeleton={skeleton} finish={(value, error) => { result = value; failure = error; }} /> });
  if (failure) throw failure;
  if (result) emit(result, { stdout, render: () => labels.done });
}
