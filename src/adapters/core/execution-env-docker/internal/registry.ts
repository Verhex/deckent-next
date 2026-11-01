import { persistedInteger, persistedUrl } from '#platform/index.js';
import { z } from 'zod';
import asset from '../../../../../assets/execution-env/docker-apt.json' with { type: 'json' };

const name = z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,63}$/), path = z.string().regex(/^\/[^\0\n]{1,255}$/), ms = persistedInteger().positive().max(3_600_000);
const distribution = z.strictObject({ id: name, url: z.string().regex(/^https:\/\/[a-z0-9.-]+\/[a-z0-9/._-]+$/), codenameFields: z.array(z.string().regex(/^[A-Z_]{1,32}$/)).min(1).max(4),
  codenames: z.array(name).min(1).max(16), architectures: z.array(name).min(1).max(16) });
/** The dated, sourced Docker apt data (versioned asset): repository, pinned signing key, supported releases, packages, bounds. Parsed strictly. */
export const dockerAptSchema = z.strictObject({ $comment: z.string(), schemaVersion: z.literal(1), environment: name, checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), docs: persistedUrl(),
  key: z.strictObject({ fingerprint: z.string().regex(/^[0-9A-F]{40}$/), sha256: z.string().regex(/^[0-9a-f]{64}$/), armored: z.array(z.string().max(128)).min(3).max(256) }),
  keyring: path, sourcesFile: path, existingSources: z.array(path).max(8), distributions: z.array(distribution).min(1).max(8), packages: z.array(name).min(1).max(16),
  conflicts: z.array(name).max(32), group: name, desktopMarkers: z.array(path).max(8), sudo: z.array(path).min(1).max(4), osRelease: z.array(path).min(1).max(4),
  timeoutsMs: z.strictObject({ probe: ms, network: ms, directory: ms, key: ms, sources: ms, update: ms, install: ms, group: ms }),
  outputBytes: persistedInteger().positive() });
export type DockerAptData = z.infer<typeof dockerAptSchema>;
export const DOCKER_APT: DockerAptData = dockerAptSchema.parse(asset);
