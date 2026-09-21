import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Test adapters from their declared platform manifests; test artifacts never enter dist.
const root = new URL('../src/adapters/', import.meta.url);
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'build' || entry.name === 'node_modules') continue;
    const child = join(directory, entry.name);
    if (entry.name !== 'native') { visit(child); continue; }
    const manifest = JSON.parse(readFileSync(join(child, 'package.json'), 'utf8'));
    if (!Array.isArray(manifest.deckentNative?.platforms) || !manifest.scripts?.test) {
      throw new Error(`Native tests require a platform manifest and test script: ${child}`);
    }
    if (manifest.deckentNative.platforms.includes(process.platform)) {
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--prefix', child], { stdio: 'inherit' });
    } else {
      console.log(`verify-native-skipped: ${JSON.stringify({ name: manifest.name,
        platform: process.platform, supportedPlatforms: manifest.deckentNative.platforms,
        reason: 'platform-not-in-native-manifest' })}`);
    }
  }
}
visit((await import('node:url')).fileURLToPath(root));
