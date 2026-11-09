import { createContext, useContext } from 'react';
import { useAnimation } from 'ink';
import { resolveRenderGlyphs, type RenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import TIMING from './assistant-timing.json' with { type: 'json' };

export const RenderGlyphsContext = createContext<RenderGlyphs>(resolveRenderGlyphs(false));

export function useRenderGlyphs(): RenderGlyphs {
  return useContext(RenderGlyphsContext);
}

/** The mark of a wait that has no count of its own (an apply behind a card): the Workline's spinner glyphs at its pace; still while inactive. */
export function useSpinnerGlyph(active: boolean): string {
  const glyphs = useRenderGlyphs(), { frame } = useAnimation({ interval: TIMING.spinnerIntervalMs, isActive: active });
  return glyphs.spinner[frame % glyphs.spinner.length]!;
}
