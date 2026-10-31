import { useEffect, useRef, useState } from 'react';
import { WorklinePaletteProvider } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import { PICKER_INITIAL, pickerView, type PickerState } from '#surfaces/core/terminal-picker/index.js';
import { PickerWindow } from './picker-window.js';
import type { PanelLabels, PanelNotice, ThemePanelPort } from './contract.js';

const WCAG_LUMINANCE_OFFSET = 0.05;

// A measured ratio is possible only for RGB/xterm colours; the terminal owns ANSI16 and the inherited foreground.
function contrast(color: string | undefined, background: string | null): string | null {
  const rgb = (hex: string) => [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16));
  const index = /^ansi256\((\d+)\)$/u.exec(color ?? ''), n = index ? Number(index[1]) : -1, cube = [0, 95, 135, 175, 215, 255];
  const foreground = color?.startsWith('#') ? rgb(color) : n >= 232 ? [8 + 10 * (n - 232), 8 + 10 * (n - 232), 8 + 10 * (n - 232)]
    : n >= 16 ? [cube[Math.floor((n - 16) / 36)]!, cube[Math.floor((n - 16) / 6) % 6]!, cube[(n - 16) % 6]!] : null;
  if (!foreground || !background) return null;
  const luminance = (channels: readonly number[]) => channels.map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((total, value, i) => total + value * [0.2126, 0.7152, 0.0722][i]!, 0);
  const a = luminance(foreground), b = luminance(rgb(background));
  return ((Math.max(a, b) + WCAG_LUMINANCE_OFFSET) / (Math.min(a, b) + WCAG_LUMINANCE_OFFSET)).toFixed(2);
}

/** Claude Code /theme: one bounded picker, a nested palette preview, Enter persists, Esc discards without touching the host or config. */
export function ThemePanel({ port, labels, push, openApproval, onError, onClose }: { readonly port: ThemePanelPort; readonly labels: PanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly openApproval: (approvalId: string) => void;
  readonly onError: (error: unknown) => void; readonly onClose: () => void }) {
  const [view, setView] = useState<Awaited<ReturnType<ThemePanelPort['inspect']>> | null>(null);
  const [state, setState] = useState<PickerState>(PICKER_INITIAL), busy = useRef(false);
  const exits = useRef({ onError, onClose }); exits.current = { onError, onClose };
  useEffect(() => { let active = true;
    void port.inspect().then(next => { if (!active) return; setState({ ...PICKER_INITIAL, pos: Math.max(0, next.choices.findIndex(choice => choice.id === next.current)) }); setView(next); },
      error => { if (active) { exits.current.onError(error); exits.current.onClose(); } });
    return () => { active = false; };
  }, [port]);
  if (!view) return <PickerWindow title={[span(port.title)]} bodyRows={5} tree={null} labels={labels.picker} listHints={port.words.hints}
    position={labels.position} onClose={onClose} onResult={onClose} />;
  const tree = { title: port.title, items: view.choices.map(choice => ({ ...choice, label: choice.id === view.current ? `${choice.label} · ${port.words.current}` : choice.label })) };
  const shown = pickerView(tree, state), setting = view.choices.find(choice => choice.id === shown.rows[shown.pos]?.id)?.id ?? view.current;
  const palette = port.palette(setting), background = port.background();
  const body = [{ spans: [span(view.source, { bold: true })] }, ...view.notes.slice(0, 1).map(text => ({ spans: [span(text, { role: 'muted' as const })] })),
    { spans: [span(port.words.preview, { bold: true })] }, ...port.words.samples.map(sample => {
      const ratio = contrast(palette[sample.role].color, background);
      return { spans: [span(sample.text, { role: sample.role }), span(` · ${ratio ? fillTemplate(port.words.contrast, { ratio }) : port.words.inherited}`, { role: 'muted' as const })] };
    }), ...view.notes.slice(1).map(text => ({ spans: [span(text, { role: 'muted' as const })] }))];
  const commit = async (chosen: string) => {
    if (busy.current) return;
    busy.current = true;
    try {
      port.apply(chosen);
      const result = await port.write(chosen);
      push(result.lines.map(text => ({ level: result.status === 'applied' ? 'info' as const : 'warning' as const, text })));
      onClose();
      if (result.status === 'approval-pending' && result.approvalId) openApproval(result.approvalId);
    } catch (error) { onError(error); push([{ level: 'warning', text: port.words.sessionOnly }]); onClose(); }
  };
  return <WorklinePaletteProvider palette={palette}><PickerWindow title={[span(port.title)]} body={body} bodyRows={5} bodyPages tree={tree}
    labels={labels.picker} listHints={port.words.hints} position={labels.position} initial={{ ...PICKER_INITIAL, pos: Math.max(0, view.choices.findIndex(choice => choice.id === view.current)) }}
    onState={setState} active={!busy.current} onResult={result => { if (result.kind !== 'selected') onClose();
      else { const choice = view.choices.find(item => item.id === result.id); if (choice) void commit(choice.id); } }} /></WorklinePaletteProvider>;
}
