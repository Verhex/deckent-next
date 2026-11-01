/** Shared picker matching: case/accents folded, every word required; exact names/keywords precede descriptive matches. */
export function foldSearchText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replaceAll('ı', 'i');
}
export function filterSearchEntries<T extends Readonly<{ id: string; label: string; detail?: string; keywords?: readonly string[] }>>(entries: readonly T[], query: string): readonly T[] {
  const needle = foldSearchText(query.trim()), words = needle.split(/\s+/u).filter(Boolean);
  if (!words.length) return entries;
  const exact = (entry: T) => [entry.id, entry.label, ...(entry.keywords ?? [])].some(value => foldSearchText(value) === needle);
  const found = entries.filter(entry => {
    const haystack = foldSearchText([entry.label, entry.id, entry.detail ?? '', ...(entry.keywords ?? [])].join(' '));
    return words.every(word => haystack.includes(word));
  });
  return [...found.filter(exact), ...found.filter(entry => !exact(entry))];
}
