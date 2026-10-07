import { createElement, type ReactElement } from 'react';
import { MonitorBody, type MonitorAppProps } from './app.js';

/** What a host window gives the monitor body: whether it owns the keyboard, how it closes and the room it has. */
export interface MonitorWindowView { readonly active: boolean; readonly onClose: () => void; readonly size: { readonly columns: number; readonly rows: number } }

/**
 * The monitor as a body for a host's window (the terminal's `/monitor`, T3 L5): the host never imports React or the view, it renders
 * what this returns inside its frame. Esc closes it once it has nothing to back out of, and the layout may be as short as 6 rows.
 */
export function monitorWindowView(options: Omit<MonitorAppProps, 'size'>): (view: MonitorWindowView) => ReactElement {
  return view => createElement(MonitorBody, { ...options, ...view, escapeCloses: true, minRows: 6 });
}
