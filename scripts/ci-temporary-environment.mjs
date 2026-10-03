import { appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// OS temporary aliases are fixture inputs, not user-authored product roots.
// Host node:test and native children do not load the Vitest fixture configuration.
const parent = realpathSync.native(tmpdir());
if (!process.env.GITHUB_ENV || /[\r\n]/u.test(parent)) throw new Error('CI_TEMP_ENV_INVALID');
appendFileSync(process.env.GITHUB_ENV, ['TMPDIR', 'TMP', 'TEMP'].map(name => `${name}=${parent}\n`).join(''));
console.log(`ci-fixture-temp: ${JSON.stringify({ platform: process.platform, canonicalized: true })}`);
