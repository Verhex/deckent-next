import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { lineCut, readPinnedFile, removePinnedFile, restorePinnedFile } from '#platform/index.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it.skipIf(process.platform !== 'linux')('removes only the bound file through its pinned parent and cuts only the one proven line, byte for byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-pinned-'));
  try {
    const owned = join(root, 'owned'), outside = join(root, 'outside'), file = join(owned, 'member');
    for (const dir of [owned, outside]) await mkdir(dir, { mode: 0o700 });
    await writeFile(file, 'OWNED', { mode: 0o600 }); await writeFile(join(outside, 'member'), 'OUTSIDE', { mode: 0o600 });
    const bound = (await readPinnedFile(file))!.identity;
    // A parent swapped for a link after the check never redirects the removal: the link is refused and the outside file stays.
    await rename(owned, `${owned}-moved`); await symlink(outside, owned);
    await expect(removePinnedFile(file, bound)).rejects.toMatchObject({ reason: 'unsafe' });
    expect(await readFile(join(outside, 'member'), 'utf8')).toBe('OUTSIDE');
    await rm(owned); await rename(`${owned}-moved`, owned);
    // A file replaced after the check (other bytes under the same name) is put back, never deleted; a leaf link is refused.
    await rm(file); await writeFile(file, 'PERSON', { mode: 0o600 });
    await expect(removePinnedFile(file, bound)).rejects.toMatchObject({ reason: 'changed' });
    expect(await readFile(file, 'utf8')).toBe('PERSON');
    await rm(file); await symlink(join(outside, 'member'), file);
    await expect(removePinnedFile(file, bound)).rejects.toMatchObject({ reason: 'unsafe' });
    expect(await readFile(join(outside, 'member'), 'utf8')).toBe('OUTSIDE');
    await rm(file); await writeFile(file, 'OWNED', { mode: 0o600 });
    expect(await removePinnedFile(file, (await readPinnedFile(file))!.identity)).toBe('removed');
    expect(await readPinnedFile(file)).toBeNull();
    // The cut keeps every other byte: CRLF, invalid UTF-8 and a last line without a newline.
    const team = Buffer.concat([Buffer.from('# Team\r\nrule: '), Buffer.from([0xff, 0xfe]), Buffer.from('\r\nlast line')]);
    const withLine = Buffer.concat([Buffer.from('@DECKENT.md\n'), team]), found = lineCut(withLine, '@DECKENT.md')!;
    expect(found.after).toBe(digest(team));
    await writeFile(file, withLine, { mode: 0o644 });
    expect(await removePinnedFile(file, (await readPinnedFile(file))!.identity, found)).toBe('removed');
    expect((await readFile(file)).equals(team)).toBe(true);
    // A newline init added in front of its line (the file had no final one) goes too only when the receipt's earlier digest proves it.
    const appended = Buffer.concat([team, Buffer.from('\n@DECKENT.md\n')]);
    expect(lineCut(appended, '@DECKENT.md', [digest(team)])!.after).toBe(digest(team));
    expect(lineCut(appended, '@DECKENT.md')!.after).toBe(digest(Buffer.concat([team, Buffer.from('\n')])));
    // A person's second copy of the line, or a changed line, is never cut.
    expect(lineCut(Buffer.from('@DECKENT.md\nmine\n@DECKENT.md\n'), '@DECKENT.md')).toBeNull();
    expect(lineCut(Buffer.from('@DECKENT.md please\n'), '@DECKENT.md')).toBeNull();
    // Restore never writes through a link and never over what is there: a linked folder or file, other bytes and an unreadable file are kept.
    const back = join(owned, 'deep/new/file'), bytes = Buffer.from('EARLIER');
    expect(await restorePinnedFile(back, bytes, 0o600, owned)).toBe('restored'); expect(await readFile(back, 'utf8')).toBe('EARLIER');
    await symlink(outside, join(owned, 'linked'));
    expect(await restorePinnedFile(join(owned, 'linked/member'), bytes, 0o600, owned)).toBe('kept');
    expect(await restorePinnedFile(join(owned, 'linked/fresh'), bytes, 0o600, owned)).toBe('kept');
    await expect(lstat(join(outside, 'fresh'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(join(outside, 'member'), 'utf8')).toBe('OUTSIDE');
    await symlink(join(outside, 'member'), join(owned, 'leaf'));
    expect(await restorePinnedFile(join(owned, 'leaf'), bytes, 0o600, owned)).toBe('kept'); expect(await readFile(join(outside, 'member'), 'utf8')).toBe('OUTSIDE');
    expect(await restorePinnedFile(file, bytes, 0o600, owned, digest(Buffer.from('not what is there')))).toBe('kept'); expect((await readFile(file)).equals(team)).toBe(true);
    await chmod(file, 0o000);
    expect(await restorePinnedFile(file, bytes, 0o600, owned, digest(team))).toBe('kept'); await chmod(file, 0o644); expect((await readFile(file)).equals(team)).toBe(true);
    // Exactly uninstall's result is replaced by the earlier bytes (moved aside and checked first).
    expect(await restorePinnedFile(file, withLine, 0o644, owned, digest(team))).toBe('restored'); expect((await readFile(file)).equals(withLine)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'linux')('R1: the retired marker is written and removed only through its pinned parent; a linked installation folder is refused, outside bytes stay', async () => {
  const { retireInstallation, reopenInstallation, uninstallRetired } = await import('#platform/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-retire-'));
  try {
    const data = join(root, 'data'), outside = join(root, 'outside'), body = { installationId: 'i', planDigest: 'd', tier: 'keep-data' };
    for (const dir of [data, outside]) await mkdir(dir, { mode: 0o700 });
    await writeFile(join(outside, 'retired.json'), 'PERSON DATA', { mode: 0o600 });
    // A global data root whose installation/ folder links elsewhere: nothing is written there and the marker write fails (no completed result).
    await symlink(outside, join(data, 'installation'));
    await expect(retireInstallation(data, body)).rejects.toMatchObject({ reason: 'unsafe' });
    expect(await readFile(join(outside, 'retired.json'), 'utf8')).toBe('PERSON DATA');
    await expect(reopenInstallation(data)).rejects.toMatchObject({ code: 'UNINSTALL_RETIRED' });
    expect(await readFile(join(outside, 'retired.json'), 'utf8')).toBe('PERSON DATA');
    // The real folder: written (created one level below the root), a second retire replaces only a marker, reopen removes only a marker.
    await rm(join(data, 'installation'));
    await retireInstallation(data, body); await retireInstallation(data, { ...body, tier: 'keep-work' });
    expect(JSON.parse(await readFile(join(data, 'installation/retired.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, tier: 'keep-work' });
    await reopenInstallation(data); expect(await uninstallRetired(data)).toBe(false);
    await writeFile(join(data, 'installation/retired.json'), 'NOT A MARKER', { mode: 0o600 });
    await expect(retireInstallation(data, body)).rejects.toMatchObject({ reason: 'changed' });
    await expect(reopenInstallation(data)).rejects.toMatchObject({ code: 'UNINSTALL_RETIRED' });
    expect(await readFile(join(data, 'installation/retired.json'), 'utf8')).toBe('NOT A MARKER');
    // F1: a file placed at the marker name while the new bytes are being synced is never replaced (no-replace publish).
    await unlink(join(data, 'installation/retired.json'));
    const { open } = await import('node:fs/promises'), probe = await open(join(root, 'probe'), 'w'), proto = Object.getPrototypeOf(probe) as { sync(): Promise<void> }; await probe.close();
    const sync = proto.sync, spy = vi.spyOn(proto, 'sync').mockImplementation(async function (this: unknown) {
      spy.mockRestore(); await writeFile(join(data, 'installation/retired.json'), 'PERSON DATA', { mode: 0o600 }); return sync.call(this); });
    await expect(retireInstallation(data, body)).rejects.toMatchObject({ reason: 'changed' });
    expect(await readFile(join(data, 'installation/retired.json'), 'utf8')).toBe('PERSON DATA');
  } finally { await rm(root, { recursive: true, force: true }); }
});
