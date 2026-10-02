import { CLI_COMMANDS } from '#surfaces/core/cli/index.js';
import { renderTopHelp, renderCommandHelp } from '#surfaces/core/cli-kit/index.js';
import { expect, it } from 'vitest';
import { ErrorRegistry, exitCodeFor, t } from '#platform/index.js';

it('keeps localized CLI help ordered, pipe-safe, and explicit about output and exit semantics', () => {
  for (const locale of ['en', 'tr'] as const) {
    const help = renderTopHelp(locale);
    expect(help.indexOf('  run ')).toBeLessThan(help.indexOf('  task '));
    expect(help).toContain('--no-color'); expect(help).toContain('--lang en|tr');
    expect(renderCommandHelp(CLI_COMMANDS.find(command => command.name === 'run')!, locale)).toContain(locale === 'en' ? '--graph <file|->' : '--graph <dosya|->');
  }
  expect(t('cli.run.desc', {}, 'en')).not.toContain('directives');
  expect(t('cli.run.inspect.task', { task: 't', kind: 'k' }, 'tr')).toContain('Görev');
  expect(t('inventory.row', { run: 'r', task: 't', attempt: 'a', owner: 'o', state: 's', cancel: 'n', output: 'x' }, 'tr')).toContain('Attempt');
});

it('maps registry categories to the documented CLI exit codes', () => {
  expect(exitCodeFor()).toBe(0);
  expect(exitCodeFor(new Error('operation'))).toBe(1);
  expect(exitCodeFor(ErrorRegistry.createError('CLI_USAGE'))).toBe(2);
  expect(exitCodeFor(ErrorRegistry.createError('CONFIG_VALIDATION'))).toBe(78);
});
