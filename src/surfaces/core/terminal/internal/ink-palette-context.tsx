import { createContext, useContext, createElement, type ReactElement, type ReactNode } from 'react';
import { DEFAULT_INK_PALETTE, type WorklineInkPalette } from './ink-palette.js';

const WorklinePaletteContext = createContext<WorklineInkPalette>(DEFAULT_INK_PALETTE);

export function WorklinePaletteProvider({ palette, children }: { readonly palette: WorklineInkPalette; readonly children: ReactNode }): ReactElement {
  return createElement(WorklinePaletteContext.Provider, { value: palette }, children);
}

export function useWorklinePalette(): WorklineInkPalette {
  return useContext(WorklinePaletteContext);
}
