import { createElement } from 'react';
import { renderToString, Text } from 'ink';
import { expect, it } from 'vitest';
import { modelProviderSpans, plainText, SpanText, fitStatusRow, worklineStatusSegments } from '#surfaces/core/terminal-render/index.js';
import { addSessionUsage, EMPTY_SESSION_USAGE, WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { SystemSummaryLine, infoWindowLines, type InfoWindowModel } from '#surfaces/core/terminal-window/index.js';
import { modelPanelTree } from '#surfaces/core/terminal-panels/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { terminalAdminPorts } from '#surfaces/core/terminal-admin/index.js';
import { t, snapshotKnownSecrets } from '#platform/index.js';
import { mountWorkline, settle } from '../support/workline-harness.js';

const identity = { model: 'GLM 5.3', provider: 'OpenRouter' };
const wrap = (node: ReturnType<typeof createElement>) => createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: node });

it('renders the model/provider text in NO_COLOR and maps the names to distinct semantic roles', () => {
  const spans = modelProviderSpans('GLM 5.3 (OpenRouter)', identity);
  expect(spans.filter(part => part.role).map(part => [part.text, part.role])).toEqual([['GLM 5.3', 'model'], ['OpenRouter', 'provider']]);
  expect(renderToString(wrap(createElement(Text, null, createElement(SpanText, { spans }))))).toMatchInlineSnapshot('"GLM 5.3 (OpenRouter)"');
  for (const theme of ['dark', 'light', 'dark-daltonized', 'light-daltonized'] as const) {
    const color = resolveWorklinePalette('truecolor', theme);
    expect(color.model.color).not.toBe(color.provider.color);
    expect(resolveWorklinePalette('none', theme).provider).toEqual({});
  }
  // A fully masked projected label adds no original identity text back into the view.
  expect(plainText(modelProviderSpans('[masked]', identity))).toBe('[masked]');
});

it('keeps model and provider together when the status row narrows', () => {
  const segments = worklineStatusSegments({ scope: 'scope', ...identity, state: 'Ready', busy: false, labels: { queued: '{count}', elapsed: '{seconds}s' } });
  expect(segments.filter(row => row.id === 'model' || row.id === 'provider').map(row => [row.text, row.role])).toEqual([['GLM 5.3', 'model'], ['(OpenRouter)', 'provider']]);
  for (let columns = 1; columns <= 100; columns++) {
    const fitted = fitStatusRow(segments, columns, ' · ', '…');
    expect(fitted.segments.some(row => row.id === 'model')).toBe(fitted.segments.some(row => row.id === 'provider'));
  }
});

it('projects the complete status identity before names become separate styled segments', async () => {
  const view = mountWorkline({ ...identity, knownSecrets: snapshotKnownSecrets([{ name: 'IDENTITY', value: 'GLM 5.3 (OpenRouter)' }]) });
  try {
    await settle(60);
    expect(view.stdout.frame).toContain('‹secret:IDENTITY›');
    expect(view.stdout.frame).not.toContain('GLM 5.3'); expect(view.stdout.frame).not.toContain('OpenRouter');
  } finally { view.instance.unmount(); }
});

it.each(['en', 'tr'] as const)('%s model row and switch notice carry the provider', locale => {
  const reference = { providerId: 'openrouter-api', providerVersion: 1, modelId: 'glm-5.3', modelVersion: 1 };
  const tree = modelPanelTree({ title: 'Models', notes: [], defaultBlocked: null, choices: [{ reference, label: identity.model, providerLabel: identity.provider,
    detail: '', group: 'openrouter-api', blocked: null, command: null, exact: '', configured: false }] }, null, terminalPanelLabels(locale).model, 'Models', true);
  expect(tree.items[0]!.label).toBe('GLM 5.3 (OpenRouter)');
  expect(tree.items[0]!.identity).toEqual(identity);
  const text = t('tui.panel.model.pinned', identity, locale);
  expect(text).toContain('GLM 5.3 (OpenRouter)');
  const rendered = renderToString(wrap(createElement(SystemSummaryLine, { text, identity, label: 'Deckent' })), { columns: 200 });
  expect(rendered).toContain('GLM 5.3 (OpenRouter)'); expect(rendered).not.toContain('\u001b[38');
});

it.each(['en', 'tr'] as const)('%s usage rows retain the actual models used across switches', async locale => {
  const report = { promptTokens: 100, completionTokens: 10, reasoningTokens: null };
  const first = addSessionUsage(EMPTY_SESSION_USAGE, { ...report, identity });
  const total = addSessionUsage(first, { ...report, identity: { model: 'Sol', provider: 'OpenAI' } });
  const admin = terminalAdminPorts({ root: '/missing-identity-fixture', scopeId: 'scope', installationId: 'i', projectId: 'p', options: {}, locale,
    context: {}, status: async () => '', doctor: async () => undefined });
  const view = await admin.info.ports.usage!({ usage: total });
  const rows = view.model.sections.flatMap(section => section.rows ?? []).filter(row => row.identity);
  expect(rows.map(row => row.value)).toEqual([expect.stringContaining('GLM 5.3 (OpenRouter)'), expect.stringContaining('Sol (OpenAI)')]);
  const model: InfoWindowModel = { title: '', summary: '', sections: [{ rows }] };
  const { lines } = infoWindowLines(model);
  expect(lines.flatMap(row => row.spans).filter(part => part.role === 'provider').map(part => part.text)).toEqual(['OpenRouter', 'OpenAI']);
  expect(total.models?.map(row => row.promptTokens)).toEqual([100, 100]);
});
