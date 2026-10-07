/** Pure scroll model of a window body: which rows show, and how a key moves the first visible row. */
export type ScrollKey = 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end';

/** The largest first row that still fills the view; never negative. */
export function maxScrollOffset(total: number, visible: number): number {
  return Math.max(0, total - Math.max(1, visible));
}

export function clampScroll(offset: number, total: number, visible: number): number {
  return Math.min(Math.max(0, offset), maxScrollOffset(total, visible));
}

/** A page keeps one row of context; a one-row view still moves. */
export function scrollBy(offset: number, key: ScrollKey, total: number, visible: number): number {
  const page = Math.max(1, visible - 1);
  const next = key === 'up' ? offset - 1 : key === 'down' ? offset + 1 : key === 'pageUp' ? offset - page : key === 'pageDown' ? offset + page
    : key === 'home' ? 0 : maxScrollOffset(total, visible);
  return clampScroll(next, total, visible);
}

/** Maps an Ink key event to a scroll key; modified keys are not scroll keys. */
export function scrollKeyOf(key: Readonly<{ upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean; home?: boolean; end?: boolean;
  ctrl?: boolean; meta?: boolean; shift?: boolean }>): ScrollKey | null {
  if (key.ctrl || key.meta || key.shift) return null;
  return key.upArrow ? 'up' : key.downArrow ? 'down' : key.pageUp ? 'pageUp' : key.pageDown ? 'pageDown' : key.home ? 'home' : key.end ? 'end' : null;
}
