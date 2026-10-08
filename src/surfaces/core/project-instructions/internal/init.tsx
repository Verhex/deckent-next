import { useState } from 'react';
import { render, useApp } from 'ink';
import { ErrorRegistry, emit, resolveLocale, colorCapability, type ConfigLoadOptions, type OutputSink } from '#platform/index.js';
import type { ProjectInstructionPort, InstructionInitPreview } from '#engine/index.js';
import { WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { humanRecordText } from '#surfaces/core/terminal-render/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { InstructionChoiceWindow } from './window.js';
import { projectInstructionLabels, projectSkeleton, type ProjectInstructionLabels } from './labels.js';

export function InstructionInitWindow(props: { readonly port: ProjectInstructionPort; readonly initial: InstructionInitPreview; readonly labels: ProjectInstructionLabels;
  readonly skeleton: (name: string, commands: readonly string[]) => string; readonly finish: (result: unknown, error?: unknown) => void }) {
  const [preview, setPreview] = useState(props.initial), [step, setStep] = useState<'bridges' | 'hosts' | 'preview' | 'applying'>('bridges');
  const [selected, setSelected] = useState<string[]>([]), { exit } = useApp();
  const done = (result: unknown, error?: unknown) => { props.finish(result, error); exit(); };
  const bridges = step === 'hosts' ? preview.bridges : preview.bridges.filter(row => row.detected || selected.includes(row.id));
  const choices = step === 'preview' ? [props.labels.cancel, props.labels.confirm] : [props.labels.continue,
    ...bridges.map(row => `${selected.includes(row.id) ? '[x]' : '[ ]'} ${row.id} · ${row.path}`), ...(step === 'bridges' ? [props.labels.chooseHost] : [])];
  const onChoice = async (index: number | null) => {
    if (step === 'applying') return;
    if (index === null || (step === 'preview' && index === 0)) { done(null); return; }
    if (step === 'preview') {
      setStep('applying');
      try { done(await props.port.initialize(preview)); } catch (error) { done(null, error); }
      return;
    }
    if (index === 0) { try { setPreview(await props.port.preview(selected, props.skeleton)); setStep('preview'); } catch (error) { done(null, error); } return; }
    if (step === 'bridges' && index === choices.length - 1) { setStep('hosts'); return; }
    const bridge = bridges[index - 1];
    if (bridge) setSelected(current => current.includes(bridge.id) ? current.filter(id => id !== bridge.id) : [...current, bridge.id]);
  };
  const body = step === 'preview' ? preview.changes.flatMap(change => [change.path, ...humanRecordText(change.append).split('\n')]) : [];
  return <WindowStackProvider><InstructionChoiceWindow key={`${step}:${selected.join(',')}`} title={step === 'preview' ? props.labels.initTitle : props.labels.bridgesTitle}
    labels={props.labels} choices={step === 'applying' ? [] : choices} body={body} onChoice={index => { void onChoice(index); }} /></WindowStackProvider>;
}

export async function instructionInitCommand(argv: readonly string[], context: { readonly root?: string; readonly env?: NodeJS.ProcessEnv; readonly stdout?: OutputSink;
  readonly stderr?: OutputSink; readonly openProjectInstructions?: (root: string, options: ConfigLoadOptions) => Promise<ProjectInstructionPort> }) {
  let previewOnly = false, language: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === '--preview' && !previewOnly) previewOnly = true;
    else if (argv[index] === '--lang' && language === undefined) { language = argv[++index]; if (!language) throw ErrorRegistry.createError('CLI_USAGE'); }
    else if (argv[index] !== '--no-color') throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (!context.openProjectInstructions) throw ErrorRegistry.createError('CLI_USAGE');
  const locale = resolveLocale(language, context.env), labels = projectInstructionLabels(locale);
  const port = await context.openProjectInstructions(context.root ?? process.cwd(), { env: context.env ?? process.env });
  const skeleton = projectSkeleton(locale), preview = await port.preview([], skeleton);
  const stdout = (context.stdout ?? process.stdout) as NodeJS.WriteStream;
  if (previewOnly) { emit({ schemaVersion: preview.schemaVersion, digest: preview.digest, changes: preview.changes.map(change => ({ path: change.path, append: humanRecordText(change.append) })), bridges: preview.bridges }, { stdout, json: true }); return; }
  if (!process.stdin.isTTY || !stdout.isTTY || typeof process.stdin.setRawMode !== 'function' || context.env?.['TERM'] === 'dumb') throw ErrorRegistry.createError('TERMINAL_TTY_REQUIRED');
  let result: unknown = null, failure: unknown;
  const palette = resolveWorklinePalette(colorCapability({ env: context.env ?? process.env, isTTY: true, argv }));
  const view = render(<WorklinePaletteProvider palette={palette}><InstructionInitWindow port={port} initial={preview} labels={labels} skeleton={skeleton} finish={(value, error) => { result = value; failure = error; }} /></WorklinePaletteProvider>,
    { stdout, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false });
  try { await view.waitUntilExit(); } finally { view.unmount(); }
  if (failure) throw failure;
  if (result) emit(result, { stdout, render: () => labels.done });
}
