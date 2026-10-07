import { afterEach, describe, expect, it } from 'vitest';
import { slashHelpText } from '#surfaces/core/terminal-kit/index.js';
import { terminalComposerLabels } from '#surfaces/core/terminal-labels/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { WORKLINE_TEST_LABELS, mountWorkline, settle, until } from '../support/workline-harness.js';

// TUI2 L3: /help lists the commands under five headings, one line each, in the same row text the palette shows.
describe('/help grouped', () => {
  it('EN', () => {
    expect(slashHelpText(terminalComposerLabels('en').slash).split('\n\n')[0]).toBe([
      'Commands', 'Info', '  /status  Show whether Deckent is running, its version and the model', '  /context  Show how full the model\'s context window is',
      '  /monitor  Snapshot of stuck runs, workers, approvals, pools and installs', '  /model  Show the current model and the model catalog of this scope',
      '  /usage  Show this conversation\'s token usage', '  /doctor  Run the installation health report', '  /scope  Show scope, project, mode and surface access',
      '  /help  List the commands by group'].join('\n'));
  });
  it('TR', () => {
    const text = slashHelpText(terminalComposerLabels('tr').slash);
    expect(text.split('\n')[0]).toBe('Komutlar');
    const sections = text.split('\n').slice(1).join('\n').split('\n\n');
    expect(sections.map(section => section.split('\n')[0])).toEqual(['Bilgi', 'İşler', 'Onaylar', 'Ayar', 'Oturum']);
    // /cancel is the window lane's text and is not pinned here.
    expect(sections[1]!.split('\n').slice(0, -1).join('\n')).toBe(['İşler', '  /workers  İşçileri kartlar olarak listele', '  /watch-workers  İşçileri canlı izle; yenileri kart olarak eklenir',
      '  /watch-runs  İşleri canlı izle; değişiklikler kart olarak eklenir', '  /watch-stop  İşçi ve iş izlemeyi durdur', '  /run <run-kimliği>  Bir işi ayrıntılı göster',
      '  /runs  Bu kapsamdaki tüm işleri listele', '  /transcript <n|deneme-kimliği> [sayfa]  Bir işçinin mühürlü dökümünü göster'].join('\n'));
  });
  it('lists every registry command exactly once, each on a single line', () => {
    for (const locale of ['en', 'tr'] as const) {
      const rows = slashHelpText(terminalComposerLabels(locale).slash).split('\n').filter(line => line.startsWith('  /'));
      expect(rows).toHaveLength(27);
      expect(new Set(rows.map(row => row.trim().split(' ')[0])).size).toBe(27);
    }
  });
});

// The real screen: every slash answer opens with its level word, so /help starts with a title line ("Info: Commands"), not with a group heading ("Info: Info").
describe('/help on the real workline', () => {
  const views: Array<ReturnType<typeof mountWorkline>> = [];
  afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });
  it.each([['en', 'Info: Commands\nInfo\n  /status  Show whether'], ['tr', 'Bilgi: Komutlar\nBilgi\n  /status  Deckent\'in']] as const)('%s', async (locale, opening) => {
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, composer: terminalComposerLabels(locale), work: workSurfaceLabels(locale) } });
    views.push(view);
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    for (const char of '/help \r') { view.stdin.write(char); await settle(2); }
    await until(() => view.stdout.text.includes(opening), 'help with title line');
  });
});
