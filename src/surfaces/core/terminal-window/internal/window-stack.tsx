import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Bounded modal windows (owner 2026-10-07): one input owner at a time. Every open window registers a layer; the top layer — highest
 * priority, then the most recently opened — owns the keyboard, and every other window, card, picker and the composer listen only while
 * they own it (`useInput` `isActive`). Ink's own focus manager is deliberately not used: once a `useFocus` component is mounted Ink takes
 * Tab, Shift+Tab and Escape for focus navigation (ink 7.1.1 `App.js`), which would steal the reason field's Tab, the mode cycle's
 * Shift+Tab and a card's Escape (= deny). This stack is a view concern only: which decision is legal stays with the panel controller.
 */
export const WINDOW_PRIORITY = Object.freeze({ window: 0, approval: 100 } as const);

type Layer = Readonly<{ id: string; priority: number; sequence: number }>;
type Stack = Readonly<{ register: (id: string, priority: number) => () => void; top: string | null; open: number; reservedRows: number | undefined }>;

const WindowStackContext = createContext<Stack | null>(null);

/** The owning layer: highest priority wins; among equals the newest. */
export function topWindowLayer(layers: readonly Layer[]): Layer | null {
  let top: Layer | null = null;
  for (const layer of layers) if (!top || layer.priority > top.priority || (layer.priority === top.priority && layer.sequence > top.sequence)) top = layer;
  return top;
}

/** `reservedRows`: rows the rest of the live area takes now (status, composer, a visible worker panel); windows cap their height to leave them. */
export function WindowStackProvider({ children, reservedRows }: { readonly children: ReactNode; readonly reservedRows?: number }) {
  const [layers, setLayers] = useState<readonly Layer[]>([]);
  const sequence = useRef(0);
  const register = useCallback((id: string, priority: number) => {
    const layer: Layer = Object.freeze({ id, priority, sequence: ++sequence.current });
    setLayers(current => [...current.filter(item => item.id !== id), layer]);
    // Closing returns the keyboard to whoever is on top now: the window below, or the composer when none is left.
    return () => setLayers(current => current.filter(item => item !== layer));
  }, []);
  const top = topWindowLayer(layers)?.id ?? null;
  const value = useMemo<Stack>(() => ({ register, top, open: layers.length, reservedRows }), [register, top, layers.length, reservedRows]);
  return <WindowStackContext.Provider value={value}>{children}</WindowStackContext.Provider>;
}

/**
 * Registers an open window and answers whether it owns the keyboard now. Outside a provider (a card rendered on its own) an open window
 * owns its input, as every card did before the stack existed.
 */
export function useWindowLayer(id: string, open = true, priority: number = WINDOW_PRIORITY.window): boolean {
  const stack = useContext(WindowStackContext);
  const register = stack?.register;
  useLayoutEffect(() => (open && register ? register(id, priority) : undefined), [id, open, priority, register]);
  if (!stack) return open;
  return open && stack.top === id;
}

/** Rows the live area outside the window needs (the provider's measure, or none given). */
export function useWindowReserve(): number | undefined {
  return useContext(WindowStackContext)?.reservedRows;
}

/** Whether no window is open: the composer (and any other base-layer input) listens only then. Without a provider nothing is open. */
export function useFocusOwner(): Readonly<{ idle: boolean; top: string | null }> {
  const stack = useContext(WindowStackContext);
  return { idle: !stack || stack.open === 0, top: stack?.top ?? null };
}
