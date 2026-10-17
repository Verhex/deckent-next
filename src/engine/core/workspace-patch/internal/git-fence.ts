import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import type { AdoptionFence } from './adoption.js';
export const adoptionFenceRef = (target: string) => `refs/deckent/adoption-fences/${createHash('sha256').update(target).digest('hex')}`;
/** Fixed versioned Git payload, unchanged for historical replay. Not queue authority. */
export const adoptionFenceText = (target: string, fence: AdoptionFence) => JSON.stringify({ schemaVersion: 1, kind: 'deckent-adoption-fence', target,
  sequence: fence.sequence, scopeId: fence.scopeId, commandId: fence.commandId }) + '\n';
export const adoptionFenceObjectSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('deckent-adoption-fence'), target: z.string(),
  sequence: z.number().int().positive().safe(), scopeId: identitySchema, commandId: identitySchema }).strict();
/** Adoption journal identity of a physical repository: its canonical Git common directory and that directory's inode. `git clone` makes a
 * new directory (and never copies refs/deckent/*), so a clone starts its own chain. The device number is deliberately left out: block
 * device numbering is not stable across reboots on some hosts (WSL2 attaches distribution disks in start order). A move or a same-path
 * re-clone that reuses the inode changes or keeps it; the fence agreement check then refuses before any write, it never misnumbers. */
export const adoptionRepositoryIdentity = (common: { readonly path: string; readonly inode: number }) =>
  createHash('sha256').update(JSON.stringify({ path: common.path, inode: common.inode })).digest('hex');
