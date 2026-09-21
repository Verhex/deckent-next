import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Development evidence only. Never print environment values or infer successful execution.
export function verificationContext(env = process.env, platform = process.platform) {
  return { schemaVersion: 1, platform,
    docker: { imageConfigured: Boolean(env.DECKENT_TEST_DOCKER_IMAGE),
      availability: 'not-probed', execution: 'not-assessed' },
    canonicalMemory: { comparison: env.DECKENT_CORE_MEMORY_CANONICAL ? 'requested' : 'skipped',
      reason: env.DECKENT_CORE_MEMORY_CANONICAL ? 'validated-by-lint-core-memory' : 'DECKENT_CORE_MEMORY_CANONICAL-not-set',
      localManifest: 'validated-by-lint-core-memory' },
    scope: 'current-platform-only; collected test outcomes follow; no other-platform or dogfood acceptance' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`verify-context: ${JSON.stringify(verificationContext())}`);
}
