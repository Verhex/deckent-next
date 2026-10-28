type Tree = Readonly<{ state: string; files: ReadonlyMap<string, string> }> | null;
/** Owner option A K5: the files a run-here turn actually changed, from two working-tree reads (before/after, stat signatures); never the model's own
 * words. A read that could not tell says so instead of "nothing changed". */
export function treeChangeLine(before: Tree, after: Tree, words: Readonly<{ changed: string; unchanged: string; unread: string }>): string {
  if (!before || !after || before.state === 'unknown' || after.state === 'unknown') return words.unread;
  const changed = [...new Set([...after.files.keys(), ...before.files.keys()])].filter(path => after.files.get(path) !== before.files.get(path)).sort();
  return changed.length ? words.changed.replace('{files}', () => changed.slice(0, 20).join(', ') + (changed.length > 20 ? ` (+${changed.length - 20})` : '')) : words.unchanged;
}
