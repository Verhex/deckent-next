import { createContext, useContext } from 'react';

/**
 * SLASH-WINDOWS I-1 (owner 2026-10-08, Jev b1e8286f): a one-time note for the window a slash command opens, e.g. "typed arguments are not
 * used in the terminal; choose in the window". The host provides it while the command runs; the first window that shows it (focused, not
 * an approval card) consumes it when it closes, so it appears once. It never carries what the person typed.
 */
export type WindowNote = Readonly<{ text: string; consume: () => void }>;
export const WindowNoteContext = createContext<WindowNote | null>(null);
export function useWindowNote(): WindowNote | null { return useContext(WindowNoteContext); }
