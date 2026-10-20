import { expect, it } from 'vitest';
import { CLI_CATALOG, hasCliAction, type CliCommandName } from '#surfaces/core/cli-kit/index.js';
import { t } from '#platform/index.js';

// g2-approvals-ipucu (analysis 2026-10-18): the CLI hint of a pending config change named `deckent approvals`, which is no command (exit 2).
// Every `deckent <command> <action>` the hint names must be a command and action of the CLI catalog, in both languages.
it('the pending config-change hint names only CLI commands that exist', () => {
  for (const locale of ['en', 'tr'] as const) {
    const hint = t('config.approval.resubmitCli', { commandId: 'C', expect: 'E' }, locale);
    const named = [...hint.matchAll(/\bdeckent ([a-z-]+)(?: ([a-z-]+))?/gu)];
    expect(named.length).toBeGreaterThan(0);
    for (const [, family, action] of named) {
      expect(CLI_CATALOG.some(item => item.name === family), `${locale}: deckent ${family}`).toBe(true);
      if (action) expect(hasCliAction(family as CliCommandName, action), `${locale}: deckent ${family} ${action}`).toBe(true);
    }
    expect(hint).toContain('deckent approval decide --input');
  }
});
