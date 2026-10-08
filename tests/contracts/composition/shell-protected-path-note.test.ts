import { describe, expect, it } from 'vitest';
import { protectedPathShellNote } from '#adapters/index.js';

// B3 (owner terminal test 2026-10-07): `rm src/deneme.md` ran without a card in full-auto and failed in the sandbox with a bare
// "Read-only file system". The result now explains the protected path in the person's language; the model reads the same text.
// The EROFS line is the one bubblewrap printed on this host (`unlink` over a read-only bind, measured 2026-10-07).
const floor = (path: string) => path === 'src' || path.startsWith('src/') || path === 'package.json';
const EROFS = "unlink: cannot unlink 'src/deneme.md': Read-only file system\n";

describe('protectedPathShellNote (B3)', () => {
  it('names the protected path, why and what can change it, in English and Turkish', () => {
    const en = protectedPathShellNote('rm src/deneme.md && echo silindi || echo silemedi', EROFS, floor, 'en');
    expect(en).toMatch(/^\[deckent\] src\/deneme\.md: protected path \(Deckent's own source or the write floor\)\./u);
    expect(en).toContain('edit tools (write_file, edit_file), which ask for approval'); expect(en).toContain('full access');
    const tr = protectedPathShellNote('rm src/deneme.md && echo silindi || echo silemedi', EROFS, floor, 'tr');
    expect(tr).toMatch(/^\[deckent\] src\/deneme\.md: korunan yol \(Deckent'in kendi kaynağı ya da yazma zemini\)\./u);
    expect(tr).toContain('onay isteyen düzenleme araçlarını'); expect(tr).toContain('tam erişimde');
    expect(en).not.toContain('\n'); expect(tr).not.toContain('\n');
  });
  it('lists several named paths once each and bounds the list', () => {
    const many = Array.from({ length: 7 }, (_, i) => `src/f${i}.ts`).join(' ');
    expect(protectedPathShellNote(`touch ${many} package.json src/f0.ts`, EROFS, floor, 'en'))
      .toMatch(/^\[deckent\] src\/f0\.ts, src\/f1\.ts, src\/f2\.ts, src\/f3\.ts, src\/f4\.ts \(\+3\): protected path/u);
  });
  it('says nothing without the read-only error, or when no protected path is named (negative)', () => {
    expect(protectedPathShellNote('rm src/deneme.md', "rm: cannot remove 'src/deneme.md': No such file or directory\n", floor, 'en')).toBeNull();
    expect(protectedPathShellNote('touch docs/x.md', "touch: cannot touch 'docs/x.md': Read-only file system\n", floor, 'en')).toBeNull();
    expect(protectedPathShellNote('d=sr; rm ${d}c/x', EROFS, floor, 'en')).toBeNull();
  });
});
