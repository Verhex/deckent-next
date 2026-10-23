import type { Writable } from 'node:stream';
import limits from './clipboard-limits.json' with { type: 'json' };

/** The most bytes of one clipboard request and the furthest `/copy [n]` reaches back (registry data: `clipboard-limits.json`). */
export const CLIPBOARD_LIMITS: Readonly<{ maxBytes: number; maxAnswerBack: number }> = Object.freeze({ ...limits });

/** Why a clipboard request was refused before anything was written (typed, so the surface can say so in the person's language). */
export type ClipboardRefusal = 'empty' | 'too-large' | 'unavailable';
export type ClipboardResult = Readonly<{ ok: true; bytes: number }> | Readonly<{ ok: false; reason: ClipboardRefusal; bytes: number }>;

/**
 * The terminal clipboard write (OSC 52, BEL-terminated) for `text`. Under tmux (`TMUX` set) the request is wrapped in a DCS passthrough with every ESC doubled
 * (tmux then needs `allow-passthrough on` / `set-clipboard on`); the request is capped so a terminal that drops long sequences is never fed one.
 * Whether the terminal honours OSC 52 cannot be probed: a written request is "sent", never "copied".
 */
export function clipboardRequest(text: string, env: NodeJS.ProcessEnv = process.env, maxBytes: number = CLIPBOARD_LIMITS.maxBytes):
  Readonly<{ ok: true; bytes: number; sequence: string }> | Extract<ClipboardResult, { ok: false }> {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) return { ok: false, reason: 'empty', bytes };
  if (bytes > maxBytes) return { ok: false, reason: 'too-large', bytes };
  const osc = `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
  return { ok: true, bytes, sequence: env['TMUX'] ? `\u001bPtmux;${osc.replaceAll('\u001b', '\u001b\u001b')}\u001b\\` : osc };
}

/** The clipboard writer of one output stream; a stream that is not a TTY has none, so a pipe never receives escape sequences. */
export function createClipboardWriter(out: Pick<Writable, 'write'> & { readonly isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): (text: string) => ClipboardResult {
  return text => {
    if (out.isTTY !== true) return { ok: false, reason: 'unavailable', bytes: Buffer.byteLength(text, 'utf8') };
    const request = clipboardRequest(text, env);
    if (!request.ok) return request;
    try { out.write(request.sequence); } catch { return { ok: false, reason: 'unavailable', bytes: request.bytes }; }
    return { ok: true, bytes: request.bytes };
  };
}
