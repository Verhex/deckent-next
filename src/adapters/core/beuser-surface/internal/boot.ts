import { DeckentJsonSchemaValidator } from '#platform/index.js';
import schema from './boot.schema.json' with { type: 'json' };
import { BeuserSurfaceError } from './input.js';

/** Private C2 → C3 wire v1. Both Python modes consume the same packaged schema. */
export interface BeuserDriverBoot {
  readonly schemaVersion: 1;
  readonly nonce: string;
  readonly mode: 'pty' | 'argv';
  readonly entry: readonly string[];
  readonly commands: Readonly<Record<string, { readonly prefix: readonly string[]; readonly allowedArgs: readonly (readonly string[])[] }>>;
  readonly secretFds: Readonly<Record<string, number>>;
  readonly columns: number; readonly rows: number; readonly maxArtifactBytes: number;
  readonly env: Readonly<Record<'TERM' | 'LANG' | 'LC_ALL' | 'HOME' | 'DECKENT_GLOBAL_HOME', string>>;
  readonly limits: Readonly<Record<'maxSteps' | 'maxWallMs' | 'maxWaitMs' | 'maxTranscriptBytes' | 'cleanupDeadlineMs'
    | 'maxInputBytes' | 'quietMs' | 'inactivityMs', number>>;
}
const check = new DeckentJsonSchemaValidator().getValidator<BeuserDriverBoot>(schema);
const UTF8_SCALAR_BYTES = Buffer.byteLength('\u{10ffff}', 'utf8');
export function pinBeuserDriverBoot(value: unknown): BeuserDriverBoot {
  const parsed = check(value);
  if (!parsed.valid) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
  const boot = parsed.data, limits = boot.limits;
  if (limits.quietMs > limits.inactivityMs || limits.inactivityMs > limits.maxWaitMs
    || limits.maxWaitMs > limits.maxWallMs || limits.cleanupDeadlineMs > limits.maxWallMs
    || limits.maxInputBytes > boot.maxArtifactBytes || boot.columns * boot.rows * UTF8_SCALAR_BYTES > boot.maxArtifactBytes) {
    throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
  }
  return boot;
}
