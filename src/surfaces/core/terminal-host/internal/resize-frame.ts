import { Box, useApp } from 'ink';
import { createElement, useEffect, useState, type ReactNode } from 'react';
import { CLEAR_VISIBLE_SCREEN } from './startup-banner.js';

/** Empty Ink's incremental frame before clearing resized geometry, keeping the view and its input state mounted. */
export function ResizeFrame({ stdout, children }: { readonly stdout: NodeJS.WriteStream; readonly children?: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  const { waitUntilRenderFlush, exit } = useApp();
  useEffect(() => {
    let active = true, generation = 0, painting = false;
    const repaint = async () => {
      painting = true;
      try {
        let drawn: number;
        do {
          drawn = generation;
          await waitUntilRenderFlush();
          if (!active) return;
          if (drawn !== generation) continue;
          stdout.write(CLEAR_VISIBLE_SCREEN);
          setHidden(false);
          await waitUntilRenderFlush();
        } while (active && drawn !== generation);
      } catch (error) { if (active) exit(error); }
      finally { painting = false; }
    };
    const resize = () => { generation++; setHidden(true); if (!painting) void repaint(); };
    stdout.on('resize', resize);
    return () => { active = false; stdout.off('resize', resize); };
  }, [stdout, waitUntilRenderFlush, exit]);
  return createElement(Box, { display: hidden ? 'none' : 'flex', flexDirection: 'column' }, children);
}
