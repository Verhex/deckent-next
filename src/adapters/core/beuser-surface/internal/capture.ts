import { createHash } from 'node:crypto';
import type { BeuserTranscriptEntry } from '#domain/index.js';
import type { BeuserContext } from '#engine/index.js';
import type { RenderedScreen } from './screen.js';
import { BeuserSurfaceError } from './input.js';

export interface HarnessAction { readonly kind: 'look' | 'type' | 'press' | 'wait' | 'argv' | 'resize' | 'capture-reset'; readonly ms?: number; readonly key?: string; readonly commandId?: string; readonly evidenceRef?: string; readonly refused?: 'BEUSER_ACTION_INVALID' }
export interface HarnessProcess { readonly state: 'ready' | 'eof'; readonly exitCode: number | null }
export interface HarnessEvent { readonly entry: BeuserTranscriptEntry; readonly screen?: RenderedScreen; readonly action?: HarnessAction; readonly process?: HarnessProcess }
export type HarnessSink = (context: BeuserContext, event: HarnessEvent) => Promise<void>;
export const surfaceDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
export class SurfaceCapture {
  private sequence = 0;
  private bytes = 0;
  private blocked = false;
  constructor(private readonly context: BeuserContext, private readonly sink: HarnessSink) {}
  assertOpen(): void { if (this.blocked) throw new BeuserSurfaceError('BEUSER_CAPTURE_BLOCKED'); }
  block(): void { this.blocked = true; }
  /** Only a fresh C2 driver, after the old secret-bearing process ended, may resume capture. */
  reopen(): void { this.blocked = false; }
  async record(kind: BeuserTranscriptEntry['kind'], atMs: number, screen?: RenderedScreen, action?: HarnessAction, process?: HarnessProcess): Promise<number> {
    if (kind !== 'secret-step') this.assertOpen();
    const sequence = ++this.sequence;
    // Neither plaintext input nor secret references/values/hashes enter harness artifacts.
    const entry: BeuserTranscriptEntry = { schemaVersion: 1, binding: this.context.binding, sequence, atMs, kind,
      evidenceRef: `${this.context.binding.transcriptId}:${sequence}`, digest: surfaceDigest(JSON.stringify({ kind, screen, action, process })) };
    const event: HarnessEvent = { entry, ...(screen ? { screen } : {}), ...(action ? { action } : {}), ...(process ? { process } : {}) };
    this.bytes += Buffer.byteLength(JSON.stringify(event));
    if (this.bytes > this.context.limits.maxTranscriptBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
    await this.sink(this.context, event);
    return sequence;
  }
}
