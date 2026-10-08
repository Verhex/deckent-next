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
      '  /monitor  Monitor window: stuck runs, workers, approvals, pools and installs (--install/--scope: text snapshot)', '  /model  Choose this session\'s model; models that cannot be used show why',
      '  /usage  Show this conversation\'s token usage', '  /doctor  Run the installation health report', '  /scope  Show scope, project, mode and surface access',
      '  /help  List the commands by group'].join('\n'));
  });
  it('TR', () => {
    const text = slashHelpText(terminalComposerLabels('tr').slash);
    expect(text.split('\n')[0]).toBe('Komutlar');
    const sections = text.split('\n').slice(1).join('\n').split('\n\n');
    expect(sections.map(section => section.split('\n')[0])).toEqual(['Bilgi', 'İşler', 'Onaylar', 'Ayar', 'Oturum']);
    // /cancel is the window lane's text and is not pinned here.
    expect(sections[1]!.split('\n').slice(0, -1).join('\n')).toBe(['İşler', '  /workers  İşçileri ve her birinin ne yaptığını listele', '  /watch-workers  İşçileri yerinde güncellenen bir pencerede canlı izle',
      '  /watch-runs  İşleri yerinde güncellenen bir pencerede canlı izle', '  /watch-stop  İşçi ve iş izlemeyi durdur', '  /tasks  Arka plan işleri: işçiler ve işler tek canlı pencerede (salt okunur)', '  /run <run-kimliği>  Bir işi ayrıntılı göster',
      '  /runs  Bu kapsamdaki tüm işleri listele', '  /transcript <n|deneme-kimliği> [sayfa]  Bir işçinin mühürlü dökümünü göster'].join('\n'));
  });
  it('puts the window and mode commands under their headings, one short line each (T2 integration)', () => {
    const section = (text: string, heading: string) => text.split('\n').slice(1).join('\n').split('\n\n').find(part => part.startsWith(`${heading}\n`)) ?? '';
    const en = slashHelpText(terminalComposerLabels('en').slash), tr = slashHelpText(terminalComposerLabels('tr').slash);
    expect(section(en, 'Approvals')).toContain('  /approvals [number|id|clear-session]  Pick a pending approval and decide it');
    expect(section(en, 'Jobs')).toContain('  /cancel <runId>  Cancel a run (asks y/N first)');
    expect(section(en, 'Settings')).toContain('  /service-restart  Restart the runtime service from this build (asks first)');
    expect(section(en, 'Settings')).toContain('  /mode ');
    expect(section(tr, 'Onaylar')).toContain('  /approvals [numara|kimlik|clear-session]  Bekleyen bir onayı seç ve karar ver');
    expect(section(tr, 'İşler')).toContain('  /cancel <run-kimliği>  Bir işi iptal et (önce y/N sorar)');
    expect(section(tr, 'Ayar')).toContain('  /service-restart  Çalışma servisini bu derlemeden yeniden başlat (önce sorar)');
    expect(section(tr, 'Ayar')).toContain('  /mode ');
    for (const text of [en, tr]) expect(text).not.toMatch(/\n(Other|Diğer)\n/);
  });
  it('lists every registry command exactly once, each on a single line', () => {
    for (const locale of ['en', 'tr'] as const) {
      const rows = slashHelpText(terminalComposerLabels(locale).slash).split('\n').filter(line => line.startsWith('  /'));
      expect(rows).toHaveLength(29);
      expect(new Set(rows.map(row => row.trim().split(' ')[0])).size).toBe(29);
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
