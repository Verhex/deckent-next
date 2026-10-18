/**
 * Owner 2026-10-18 ("okuma kartı kalksın", Jev 5e6dd7aa), allowlist shape after the security re-reviews of 03d82341 and 6f987adf: a segment
 * reads a read-only floor name only when it is fully modelled here — the exact bare program token, only the flags listed for it (combined
 * short flags included; no long option but `--`), values of its value flags and operands without any expansion, and no redirection but a
 * discard into `/dev/null` or a descriptor copy. Anything else (an unknown flag, a `--long=value`, `$`/backtick, `<>`, `{fd}>`, a target
 * file) is not modelled, so the caller keeps the card.
 */
interface Reader { readonly flags: ReadonlySet<string>; readonly valued: ReadonlySet<string>; readonly text: boolean; readonly counts: boolean }
const reader = (flags: string, valued = '', text = false, counts = false): Reader => ({ flags: new Set(flags.split(' ').filter(Boolean)),
  valued: new Set(valued.split(' ').filter(Boolean)), text, counts });
const GREP = reader('-n -i -v -c -l -L -w -x -h -H -o -q -s -r -R -E -F -I', '-e -m -A -B -C', true), SUM = reader('-b -t');
const READERS: ReadonlyMap<string, Reader> = new Map([['cat', reader('-n -b -s -A -E -T -v')], ['head', reader('-q -v', '-n -c', false, true)],
  ['tail', reader('-q -v', '-n -c', false, true)], ['wc', reader('-l -c -w -m -L')], ['grep', GREP], ['egrep', GREP], ['fgrep', GREP],
  ['ls', reader('-l -a -A -h -R -1 -d -t -r -S -F')], ['stat', reader('-L -t')], ['diff', reader('-u -q -r -N -w -b -B -i', '-U')], ['cmp', reader('-s -l -b')],
  ['cut', reader('-s', '-d -f -c -b')], ['md5sum', SUM], ['sha1sum', SUM], ['sha256sum', SUM], ['jq', reader('-r -c -S -e -s -n -j', '', true)]]);
const DISCARDS: ReadonlySet<string> = new Set(['2>/dev/null', '>/dev/null', '1>/dev/null', '&>/dev/null', '2>&1', '1>&2', '>&2']);
/** A path operand or a flag value: no expansion, quoting residue, redirection or glob character. */
const PLAIN = /^[A-Za-z0-9_./@+,:%=-]+$/u;
/** A text operand (a grep pattern, a jq filter) after quote removal: anything but an expansion, a substitution marker, a redirection or a line break. */
const TEXT = /^[^$`<>\n\r]*$/u;

/** Whether `program args…` is a fully modelled read (see above). */
export function readsOnlyModelled(program: string, args: readonly string[]): boolean {
  const spec = READERS.get(program);
  if (!spec) return false;
  let options = true, textPending = spec.text;
  for (let at = 0; at < args.length; at++) {
    const word = args[at]!;
    if (/[<>]/u.test(word)) { if (DISCARDS.has(word)) continue; return false; }
    if (options && word === '--') { options = false; continue; }
    if (options && word.startsWith('-') && word !== '-') {
      if (spec.counts && /^-\d+$/u.test(word)) continue;
      if (spec.valued.has(word)) { const value = args[++at]; if (value === undefined || !(word === '-e' ? TEXT : PLAIN).test(value)) return false; if (word === '-e') textPending = false; continue; }
      const attached = [...spec.valued].find(flag => word.startsWith(flag) && word.length > flag.length);
      if (attached) { if (!(attached === '-e' ? TEXT : PLAIN).test(word.slice(attached.length))) return false; if (attached === '-e') textPending = false; continue; }
      if (word.startsWith('--') || ![...word.slice(1)].every(flag => spec.flags.has(`-${flag}`))) return false;
      continue;
    }
    if (textPending) { if (!TEXT.test(word)) return false; textPending = false; continue; }
    if (!PLAIN.test(word) || word.startsWith('-') && word !== '-') return false;
  }
  return true;
}
