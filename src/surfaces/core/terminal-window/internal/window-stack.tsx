import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInput } from 'ink';

/**
 * Bounded modal windows (owner 2026-10-07): one input owner at a time. Every open window registers a layer; the top layer — highest
 * priority, then the most recently opened — owns the keyboard, and every other window, card, picker and the composer listen only while
 * they own it (`useInput` `isActive`). In rich Workline, foreground windows take focus, background windows leave the composer focused,
 * and Ctrl+O explicitly transfers ownership (TERMINAL-SABIT R2, owner 2026-10-14).
 * Ink's own focus manager is deliberately not used: once a `useFocus` component is mounted Ink takes
 * Tab, Shift+Tab and Escape for focus navigation (ink 7.1.1 `App.js`), which would steal the reason field's Tab, the mode cycle's
 * Shift+Tab and a card's Escape (= deny). This stack is a view concern only: which decision is legal stays with the panel controller.
 */
export const WINDOW_PRIORITY = Object.freeze({ window: 0, approval: 100 } as const);

type Layer = Readonly<{ id: string; priority: number; sequence: number }>;
type Stack = Readonly<{ register: (id: string, priority: number, foreground: boolean) => () => void; top: string | null; open: number; reservedRows: number | undefined;
  composing: boolean; composerWindows: boolean; accepts: (id: string | null) => boolean; focusTop: () => boolean;
  /** The top layer's priority (null: no window); approval-priority layers in opening order (one shown at a time, "1/3"). */
  topPriority: number | null; decisions: readonly string[] }>;

const WindowStackContext = createContext<Stack | null>(null);
/** A window's opening cause, independent of its priority or authority. User-opened windows are the default. */
export const WindowOpeningContext = createContext<'foreground' | 'background'>('foreground');
/** The catalog sentence a decision window shows while it waits behind the focused composer: how to reach the decision (Ctrl+O). */
export const WindowDecideHintContext = createContext<string | undefined>(undefined);

/** The owning layer: highest priority wins; among equals the newest. */
export function topWindowLayer(layers: readonly Layer[]): Layer | null {
  let top: Layer | null = null;
  for (const layer of layers) if (!top || layer.priority > top.priority || (layer.priority === top.priority && layer.sequence > top.sequence)) top = layer;
  return top;
}

/** `reservedRows`: rows the rest of the live area takes now (status, composer, a visible worker panel); windows cap their height to leave them. */
export function WindowStackProvider({ children, reservedRows, composerDefault = false }: { readonly children: ReactNode; readonly reservedRows?: number | undefined; readonly composerDefault?: boolean }) {
  const [layers, setLayers] = useState<readonly Layer[]>([]);
  const [windowFocused, setWindowFocused] = useState(!composerDefault);
  const focus = useRef(!composerDefault), currentLayers = useRef(layers);
  currentLayers.current = layers;
  const sequence = useRef(0);
  const register = useCallback((id: string, priority: number, foreground: boolean) => {
    const layer: Layer = Object.freeze({ id, priority, sequence: ++sequence.current });
    currentLayers.current = [...currentLayers.current.filter(item => item.id !== id), layer];
    // A new automatic card never inherits the previous window's focus. A foreground picker/card takes it immediately, and so does a decision
    // (approval priority, TERMINAL-SABIT-DUZEN slice 2, owner 2026-10-18): it arms before its keys count, so no Ctrl+O is needed to answer it.
    if (composerDefault && topWindowLayer(currentLayers.current) === layer) { const takes = foreground || priority >= WINDOW_PRIORITY.approval; focus.current = takes; setWindowFocused(takes); }
    setLayers(currentLayers.current);
    return () => {
      const wasTop = topWindowLayer(currentLayers.current) === layer;
      currentLayers.current = currentLayers.current.filter(item => item !== layer);
      if (composerDefault && wasTop) { focus.current = false; setWindowFocused(false); }
      setLayers(currentLayers.current);
    };
  }, [composerDefault]);
  const topLayer = topWindowLayer(layers), top = topLayer?.id ?? null;
  const decisions = useMemo(() => layers.filter(layer => layer.priority >= WINDOW_PRIORITY.approval).sort((a, b) => a.sequence - b.sequence).map(layer => layer.id), [layers]);
  useInput((input, key) => {
    if (!composerDefault || !key.ctrl || key.meta || input !== 'o' || currentLayers.current.length === 0) return;
    focus.current = !focus.current; setWindowFocused(focus.current);
  }, { isActive: composerDefault });
  const accepts = useCallback((id: string | null) => {
    const owner = topWindowLayer(currentLayers.current)?.id ?? null;
    return id === null ? owner === null || !focus.current : owner === id && focus.current;
  }, []);
  /** The same explicit transfer as Ctrl+O, from another person-driven key (the active work strip's Enter); never a decision. */
  const focusTop = useCallback(() => {
    if (!composerDefault || currentLayers.current.length === 0) return false;
    focus.current = true; setWindowFocused(true); return true;
  }, [composerDefault]);
  const composing = top === null || !windowFocused;
  const topPriority = topLayer?.priority ?? null;
  const value = useMemo<Stack>(() => ({ register, top, open: layers.length, reservedRows, composing, composerWindows: composerDefault, accepts, focusTop, topPriority, decisions }),
    [register, top, layers.length, reservedRows, composing, composerDefault, accepts, focusTop, topPriority, decisions]);
  return <WindowStackContext.Provider value={value}>{children}</WindowStackContext.Provider>;
}

/**
 * Registers an open window and answers whether it owns the keyboard now. Outside a provider (a card rendered on its own) an open window
 * owns its input, as every card did before the stack existed.
 */
export function useWindowLayer(id: string, open = true, priority: number = WINDOW_PRIORITY.window): boolean {
  const stack = useContext(WindowStackContext);
  const opening = useContext(WindowOpeningContext), foreground = useRef(opening === 'foreground');
  foreground.current = opening === 'foreground';
  const register = stack?.register;
  // Sample the opening cause only when registering, so a turn ending or a refreshed snapshot cannot steal focus.
  useLayoutEffect(() => (open && register ? register(id, priority, foreground.current) : undefined), [id, open, priority, register]);
  if (!stack) return open;
  return open && stack.top === id && !stack.composing;
}

/** Synchronous guard as well as isActive: a focus-switch and an answer may arrive in the same input chunk. */
export function useWindowLayerGuard(id: string): () => boolean {
  const stack = useContext(WindowStackContext);
  return () => stack?.accepts(id) ?? true;
}
export const WindowInputContext = createContext<(() => boolean) | null>(null);
export function useWindowInputGuard(): () => boolean { return useContext(WindowInputContext) ?? (() => true); }

/** Rows the live area outside the window needs (the provider's measure, or none given). */
export function useWindowReserve(): number | undefined {
  return useContext(WindowStackContext)?.reservedRows;
}

/** One input owner: the composer listens when no window exists or the person has returned focus to it. */
export function useFocusOwner(): Readonly<{ idle: boolean; top: string | null; composing: boolean; composerWindows: boolean; inputAllowed: () => boolean; focusTop: () => boolean;
  topPriority: number | null }> {
  const stack = useContext(WindowStackContext);
  return { idle: !stack || stack.open === 0, top: stack?.top ?? null, composing: stack?.composing ?? true, composerWindows: stack?.composerWindows ?? false,
    inputAllowed: () => stack?.accepts(null) ?? true, focusTop: () => stack?.focusTop() ?? false, topPriority: stack?.topPriority ?? null };
}

/** A decision's place in the queue: decisions wait one at a time (the one on top shows, the rest hide behind it), counted "n/total". */
export function useDecisionQueue(id: string, priority: number): Readonly<{ hidden: boolean; position: number; total: number }> {
  const stack = useContext(WindowStackContext), decisions = stack?.decisions ?? [];
  if (priority < WINDOW_PRIORITY.approval || decisions.length < 2) return { hidden: false, position: 1, total: decisions.length };
  const shown = stack?.top !== null && decisions.includes(stack?.top ?? '') ? stack!.top! : decisions.at(-1)!;
  // The shown decision counts as the first of the waiting ones; the others keep their opening order behind it.
  const order = [shown, ...decisions.filter(item => item !== shown)];
  return { hidden: id !== shown, position: order.indexOf(id) + 1, total: decisions.length };
}
