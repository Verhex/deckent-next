import { expect, it } from 'vitest';
import { detectNativeCliVersion } from '#adapters/core/native-coding/index.js';

// Host-only positive: existing local immutable image, version probe only, no login/network/provider invocation.
// Missing capability is explicitly verify-not-run; source/runner contracts are tested in the sibling file.
it('measures the chosen native CLI in the real local image (host acceptance)', async context => {
  const imageId = process.env['DECKENT_TEST_DOCKER_IMAGE'], executable = process.env['DECKENT_TEST_DOCKER_EXECUTABLE'], provider = process.env['DECKENT_TEST_NATIVE_CLI'];
  if (!imageId || !executable || !provider) {
    context.annotate('verify-not-run: needs explicit local Docker executable, immutable worker image and native CLI selection', 'platform-capability'); context.skip(); return;
  }
  const version = await detectNativeCliVersion(provider, { executable, imageId, memoryBytes: 268435456, cpus: 1,
    pids: 64, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 5000, outputBytes: 65536 });
  expect(version).toMatch(/\d+\.\d+\.\d+/);
});
