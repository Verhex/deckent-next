import { describe, expect, it } from 'vitest';
import { PICKER_INITIAL, filterPickerNodes, pickerActionOf, pickerActionOfAnswer, pickerFirstRow, pickerNeedsTextFallback, pickerNumberedLines, pickerReduce, pickerView,
  type PickerAction, type PickerNode, type PickerOutcome, type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { pickerLabels } from '#surfaces/core/work-labels/index.js';

// Saf seçici çekirdeği: süzgeç, sayfalama, çok seviye, kapsam adımı, nedenli engelli satır, numaralı yedek. Yan etki yok; sonuç tipli.
const OPTS = { pageSize: 4 };
const leaf = (id: string, extra: Partial<PickerNode> = {}): PickerNode => ({ id, label: id.toUpperCase(), ...extra });
const TREE: PickerTree = {
  title: 'Settings',
  items: [
    { id: 'model', label: 'Model', childTitle: 'Model keys', children: [
      { id: 'name', label: 'Name', childTitle: 'Names', children: [leaf('alpha'), leaf('beta', { blocked: { reason: 'needs approval' } }), leaf('gamma', { keywords: ['Ünlü'] })] },
      leaf('temp'),
    ] },
    leaf('theme'),
    leaf('locked', { blocked: { reason: 'managed by policy' } }),
  ],
};
const SCOPED: PickerTree = { ...TREE, scopes: [{ id: 'project', label: 'Project' }, { id: 'user', label: 'User' }] };

function run(tree: PickerTree, actions: readonly PickerAction[], from: PickerState = PICKER_INITIAL): { state: PickerState; outcomes: PickerOutcome[] } {
  let state = from; const outcomes: PickerOutcome[] = [];
  for (const action of actions) { const next = pickerReduce(tree, state, action, OPTS); state = next.state; outcomes.push(next.outcome); }
  return { state, outcomes };
}
const type = (text: string): PickerAction => ({ type: 'type', text });
const down: PickerAction = { type: 'move', direction: 'down' }, enter: PickerAction = { type: 'enter' }, esc: PickerAction = { type: 'escape' };

describe('picker core: filter', () => {
  it('matches every word against label, id, detail and keywords, folding case and accents', () => {
    const nodes = [leaf('alpha'), leaf('beta', { detail: 'second' }), leaf('gamma', { keywords: ['Ünlü'] })];
    expect(filterPickerNodes(nodes, 'ALP').map(n => n.id)).toEqual(['alpha']);
    expect(filterPickerNodes(nodes, 'sec bet').map(n => n.id)).toEqual(['beta']);
    expect(filterPickerNodes(nodes, 'unlu').map(n => n.id)).toEqual(['gamma']);
    expect(filterPickerNodes(nodes, '   ')).toHaveLength(3);
    expect(filterPickerNodes(nodes, 'zzz')).toHaveLength(0);
  });
  it('typing narrows the rows and resets the pos; Backspace widens; control characters are dropped', () => {
    let { state } = run(TREE, [down, type('th')]);
    expect(pickerView(TREE, state).rows.map(r => r.id)).toEqual(['theme']);
    expect(state.pos).toBe(0);
    ({ state } = run(TREE, [type('\u001b[A\n')], state));
    expect(state.filter).toBe('th[A');
    ({ state } = run(TREE, [{ type: 'backspace' }, { type: 'backspace' }, { type: 'backspace' }, { type: 'backspace' }], state));
    expect(pickerView(TREE, state).rows).toHaveLength(3);
  });
  it('Enter on an empty filtered list is invalid and returns nothing', () => {
    const { outcomes } = run(TREE, [type('zzz'), enter]);
    expect(outcomes[1]).toEqual({ kind: 'invalid' });
  });
});

describe('picker core: paging', () => {
  const many: PickerTree = { title: 'Many', items: Array.from({ length: 10 }, (_, i) => leaf(`row${i}`)) };
  it('page keys move by page-1 and clamp; Home/End jump', () => {
    let { state } = run(many, [{ type: 'page', direction: 'down' }]);
    expect(state.pos).toBe(3);
    ({ state } = run(many, [{ type: 'page', direction: 'down' }, { type: 'page', direction: 'down' }, { type: 'page', direction: 'down' }], state));
    expect(state.pos).toBe(9);
    ({ state } = run(many, [{ type: 'edge', edge: 'first' }], state));
    expect(state.pos).toBe(0);
    ({ state } = run(many, [{ type: 'page', direction: 'up' }], state));
    expect(state.pos).toBe(0);
  });
  it('the visible window always contains the pos', () => {
    for (let pos = 0; pos < 10; pos += 1) {
      const first = pickerFirstRow(pos, 10, 4);
      expect(pos).toBeGreaterThanOrEqual(first); expect(pos).toBeLessThan(first + 4);
    }
  });
  it('Up on the first row wraps to the last', () => {
    expect(run(many, [{ type: 'move', direction: 'up' }]).state.pos).toBe(9);
  });
});

describe('picker core: levels', () => {
  it('descends section -> key -> value and returns the full id path; Esc climbs one level and restores the pos', () => {
    let { state } = run(TREE, [enter]);
    expect(pickerView(TREE, state).crumbs).toEqual(['Settings', 'Model keys']);
    ({ state } = run(TREE, [enter], state));
    expect(pickerView(TREE, state).crumbs).toEqual(['Settings', 'Model keys', 'Names']);
    ({ state } = run(TREE, [esc], state));
    expect(pickerView(TREE, state).crumbs).toEqual(['Settings', 'Model keys']);
    ({ state } = run(TREE, [esc], state));
    expect(pickerView(TREE, state).crumbs).toEqual(['Settings']);
    const result = run(TREE, [enter, enter, down, down, enter]);
    expect(result.outcomes.at(-1)).toEqual({ kind: 'done', result: { kind: 'selected', path: ['model', 'name', 'gamma'], id: 'gamma' } });
  });
  it('Esc with a filter clears the filter first, then climbs, then cancels at the root', () => {
    const { state, outcomes } = run(TREE, [enter, type('na'), esc]);
    expect(state.filter).toBe(''); expect(state.trail).toHaveLength(1);
    expect(run(TREE, [esc], state).state.trail).toHaveLength(0);
    expect(outcomes.at(-1)).toEqual({ kind: 'continue' });
    expect(run(TREE, [esc]).outcomes[0]).toEqual({ kind: 'done', result: { kind: 'cancelled' } });
  });
  it('Ctrl+C cancels from any level and stage', () => {
    expect(run(SCOPED, [enter, enter, { type: 'cancel' }]).outcomes.at(-1)).toEqual({ kind: 'done', result: { kind: 'cancelled' } });
  });
});

describe('picker core: scope step', () => {
  it('opens after a leaf, cycles with Tab/arrows, confirms with Enter, and Esc goes back to the list', () => {
    const first = run(SCOPED, [down, enter]);
    let state = first.state;
    const outcomes = first.outcomes;
    expect(state.stage).toBe('scope'); expect(outcomes.at(-1)).toEqual({ kind: 'continue' });
    expect(pickerView(SCOPED, state).rows.map(r => r.id)).toEqual(['project', 'user']);
    ({ state } = run(SCOPED, [{ type: 'scope', direction: 'next' }], state));
    expect(state.scopePos).toBe(1);
    const done = run(SCOPED, [enter], state);
    expect(done.outcomes[0]).toEqual({ kind: 'done', result: { kind: 'selected', path: ['theme'], id: 'theme', scope: 'user' } });
    ({ state } = run(SCOPED, [esc], state));
    expect(state.stage).toBe('list'); expect(state.pending).toBeNull();
  });
  it('typing does not edit the filter in the scope step; a blocked scope is refused with its reason', () => {
    const blockedScopes: PickerTree = { ...TREE, scopes: [{ id: 'project', label: 'Project', blocked: { reason: 'not trusted' } }, { id: 'user', label: 'User' }] };
    const { state, outcomes } = run(blockedScopes, [down, enter, type('q')]);
    expect(state.filter).toBe(''); expect(state.scopePos).toBe(1);
    expect(run(blockedScopes, [{ type: 'scope', direction: 'previous' }, enter], state).outcomes.at(-1)).toEqual({ kind: 'blocked', reason: 'not trusted' });
    expect(outcomes).toHaveLength(3);
  });
  it('without scopes a leaf returns immediately', () => {
    expect(run(TREE, [down, enter]).outcomes.at(-1)).toMatchObject({ kind: 'done', result: { kind: 'selected', id: 'theme' } });
  });
});

describe('picker core: blocked rows', () => {
  it('a blocked leaf is visible with its reason and can never be selected, with or without scopes', () => {
    for (const tree of [TREE, SCOPED]) {
      const view = pickerView(tree, run(tree, [{ type: 'edge', edge: 'last' }]).state);
      expect(view.rows[view.pos]).toMatchObject({ id: 'locked', blocked: 'managed by policy' });
      const result = run(tree, [{ type: 'edge', edge: 'last' }, enter]);
      expect(result.outcomes.at(-1)).toEqual({ kind: 'blocked', reason: 'managed by policy' });
      expect(result.state.stage).toBe('list');
    }
  });
  it('a blocked section does not open; a blocked value inside an open section stays unselected', () => {
    const tree: PickerTree = { title: 'T', items: [{ id: 's', label: 'S', blocked: { reason: 'no' }, children: [leaf('x')] }] };
    const closed = run(tree, [enter]);
    expect(closed.state.trail).toHaveLength(0); expect(closed.outcomes[0]).toEqual({ kind: 'blocked', reason: 'no' });
    const inner = run(TREE, [enter, enter, down, enter]);
    expect(inner.outcomes.at(-1)).toEqual({ kind: 'blocked', reason: 'needs approval' });
  });
  it('the numbered fallback cannot choose a blocked row either', () => {
    const view = pickerView(TREE, PICKER_INITIAL);
    expect(run(TREE, [pickerActionOfAnswer(view, '3')]).outcomes[0]).toEqual({ kind: 'blocked', reason: 'managed by policy' });
  });
});

describe('picker core: keys and numbered fallback', () => {
  it('printable keys filter (j and k included); control and meta chords do not', () => {
    expect(pickerActionOf('j', {}, 'list')).toEqual({ type: 'type', text: 'j' });
    expect(pickerActionOf('k', {}, 'list')).toEqual({ type: 'type', text: 'k' });
    expect(pickerActionOf('x', { ctrl: true }, 'list')).toBeNull();
    expect(pickerActionOf('x', { meta: true }, 'list')).toBeNull();
    expect(pickerActionOf('c', { ctrl: true }, 'scope')).toEqual({ type: 'cancel' });
    expect(pickerActionOf('', { tab: true, shift: true }, 'scope')).toEqual({ type: 'scope', direction: 'previous' });
    expect(pickerActionOf('', { tab: true }, 'list')).toBeNull();
    expect(pickerActionOf('a', {}, 'scope')).toBeNull();
  });
  it('falls back to text without a TTY or with TERM=dumb', () => {
    expect(pickerNeedsTextFallback({ TERM: 'xterm-256color' }, true)).toBe(false);
    expect(pickerNeedsTextFallback({ TERM: 'xterm-256color' }, false)).toBe(true);
    expect(pickerNeedsTextFallback({ TERM: 'dumb' }, true)).toBe(true);
  });
  it('numbers rows, marks sections and blocked rows, and maps answers (number, id, empty, junk) to actions', () => {
    const view = pickerView(TREE, PICKER_INITIAL);
    expect(pickerNumberedLines(view, 'blocked')).toEqual(['1) Model >', '2) THEME', '3) LOCKED [blocked: managed by policy]']);
    expect(pickerActionOfAnswer(view, ' 2 ')).toEqual({ type: 'choose', index: 1 });
    expect(pickerActionOfAnswer(view, 'theme')).toEqual({ type: 'choose', index: 1 });
    expect(pickerActionOfAnswer(view, '')).toEqual({ type: 'escape' });
    expect(run(TREE, [pickerActionOfAnswer(view, '9')]).outcomes[0]).toEqual({ kind: 'invalid' });
    expect(run(TREE, [pickerActionOfAnswer(view, 'nope')]).outcomes[0]).toEqual({ kind: 'invalid' });
    expect(run(TREE, [pickerActionOfAnswer(view, '2')]).outcomes[0]).toMatchObject({ kind: 'done', result: { id: 'theme' } });
  });
  it('is pure: the input tree and state are not mutated', () => {
    const before = JSON.stringify(SCOPED);
    run(SCOPED, [enter, enter, down, enter, { type: 'scope', direction: 'next' }, enter]);
    expect(JSON.stringify(SCOPED)).toBe(before);
    expect(Object.isFrozen(PICKER_INITIAL)).toBe(true);
  });
  it('labels exist in English and Turkish', () => {
    const en = pickerLabels('en'), tr = pickerLabels('tr');
    for (const key of Object.keys(en) as Array<keyof typeof en>) { expect(en[key]).not.toMatch(/^tui\./); expect(tr[key]).not.toMatch(/^tui\./); }
    expect(tr.noMatches).not.toBe(en.noMatches);
  });
});
