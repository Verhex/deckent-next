import { describe, expect, it } from 'vitest';
import { agentToolApprovalSummary } from '#engine/index.js';
import { t } from '#platform/index.js';
import { fitStatusRow, worklineStatusSegments } from '#surfaces/core/terminal/index.js';

describe('derived self-source visibility', () => {
  it('names the source reason, requested path and mode in each approval locale', () => {
    for (const locale of ['en', 'tr'] as const) for (const mode of ['standart', 'full-auto'] as const) {
      const summary = agentToolApprovalSummary({ tool: 'edit_file', resource: 'dist/entry.js', argsDigest: 'a'.repeat(64), cell: 'edit-self-source',
        selfSourceReason: t('terminal.approval.selfSource', { path: 'dist/entry.js', mode }, locale) });
      expect(summary).toContain(locale === 'en' ? "Deckent's own source / running code" : "Deckent'in kendi kaynağı / çalışan kodu");
      expect(summary).toContain('dist/entry.js');
      expect(summary).toContain(mode);
      expect(summary).toContain('aaaaaaaaaaaa');
    }
  });

  it('preserves existing ordinary and authority approval summaries byte for byte', () => {
    for (const cell of [null, 'edit', 'edit-floor', 'edit-authority']) {
      expect(agentToolApprovalSummary({ tool: 'edit_file', resource: 'src/a.ts', argsDigest: 'a'.repeat(64), cell, selfSourceReason: 'ignored' }))
        .toBe('edit_file · src/a.ts · aaaaaaaaaaaa');
    }
  });

  it('keeps the derived marker and current mode whole at 80 columns in both locales', () => {
    for (const locale of ['en', 'tr'] as const) for (const mode of ['standart', 'full-auto', 'full-access'] as const) {
      const marker = t('terminal.mode.selfSourceFloor', {}, locale);
      const input = { scope: '/very/long/worktree/company/site/project-self-source', model: 'provider/model@version', state: 'Ready', busy: false,
        labels: { queued: '{count} queued', elapsed: '{seconds}s', selfSourceFloor: marker }, mode, selfSource: true };
      const row = fitStatusRow(worklineStatusSegments(input), 80, ' · ', '…').segments.map(item => item.text).join(' · ');
      expect(row.length).toBeLessThanOrEqual(80);
      expect(row).toContain(locale === 'tr' ? 'öz-kaynak zemini açık' : 'self-source floor active');
      expect(row).toContain(mode);
      expect(worklineStatusSegments({ ...input, selfSource: false }).some(item => item.id === 'self-source')).toBe(false);
      expect(worklineStatusSegments({ ...input, selfSource: undefined }).some(item => item.id === 'self-source')).toBe(false);
    }
  });
});
