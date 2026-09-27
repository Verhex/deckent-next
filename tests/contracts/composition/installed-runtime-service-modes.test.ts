import { it } from 'vitest';
import { installedScenario } from '../support/installed-runtime-harness.js';

it.skipIf(process.platform !== 'linux').each(['plain', 'conditional', 'approval', 'contention'])('runs installed mode=%s across SDK, CLI and MCP through the configured service', async mode => {
  await installedScenario(mode);
}, 60_000);
