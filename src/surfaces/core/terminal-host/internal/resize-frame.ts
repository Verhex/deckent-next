import { Box, useApp } from 'ink';
import { createElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CLEAR_VISIBLE_SCREEN } from './startup-banner.js';

/** The host's handover spans Ink's suspension through the completed resume, not just the child callback. */
export function createResizeOwnership() {
  let held = 0;
  const listeners = new Set<() => void>();
  return {
    owned: () => held === 0,
    release: () => { held++; },
    reclaim: () => { if (--held === 0) for (const listener of listeners) listener(); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** Empty Ink's incremental frame before clearing resized geometry, keeping the view and its input state mounted. */
export function ResizeFrame({ stdout, ownership, children }: { readonly stdout: NodeJS.WriteStream; readonly ownership: ReturnType<typeof createResizeOwnership>; readonly children?: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  const committedHidden = useRef(false), hiddenCommit = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    committedHidden.current = hidden;
    if (hidden) { hiddenCommit.current?.(); hiddenCommit.current = null; }
  }, [hidden]);
  const { waitUntilRenderFlush, exit } = useApp();
  useEffect(() => {
    let active = true, generation = 0, completed = 0, painting = false;
    const repaint = async () => {
      painting = true;
      try {
        while (active && ownership.owned() && completed !== generation) {
          const drawn = generation;
          // A flush drains output; after resume, first wait for React to commit the newly hidden tree.
          await new Promise<void>(resolve => { if (committedHidden.current) resolve(); else hiddenCommit.current = resolve; setHidden(true); });
          if (!active || !ownership.owned()) return;
          await waitUntilRenderFlush();
          if (!active || !ownership.owned()) return;
          if (drawn !== generation) continue;
          stdout.write(CLEAR_VISIBLE_SCREEN);
          setHidden(false);
          await waitUntilRenderFlush();
          completed = drawn;
        }
      } catch (error) { if (active) exit(error); }
      finally { painting = false; }
    };
    const resume = () => { if (active && ownership.owned() && completed !== generation && !painting) void repaint(); };
    const resize = () => { generation++; resume(); };
    const unsubscribe = ownership.subscribe(resume);
    stdout.on('resize', resize);
    return () => { active = false; stdout.off('resize', resize); unsubscribe(); hiddenCommit.current?.(); hiddenCommit.current = null; };
  }, [stdout, ownership, waitUntilRenderFlush, exit]);
  return createElement(Box, { display: hidden ? 'none' : 'flex', flexDirection: 'column' }, children);
}
