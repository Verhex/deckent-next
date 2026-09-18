#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig, resolveLocale } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { createReadOnlyMcpServer } from '#surfaces/index.js';
import { inspectConfiguredRun } from '#composition/core/runs/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
/** Stdio peer inherits this local OS user's identity. This entry is not a remote authentication mechanism. */
export async function main(root = process.cwd()) {
  registerProviderConfig(); const config = await loadConfig(root, { heal: false });
  const locale = resolveLocale(undefined, process.env, config.language);
  return serveStdio(() => createReadOnlyMcpServer({ inspectRun: query => inspectConfiguredRun(root, query),
    inspectInventory: query => inspectConfiguredInventory(root, query) }, { maxConcurrentCalls: config.mcp.maxConcurrentCalls, responseMaxBytes: config.mcp.responseMaxBytes }, locale), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: config.mcp.inputMaxBytes }),
    onerror: () => { process.stderr.write('MCP_TRANSPORT_FAILED\n'); },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { process.stderr.write('MCP_START_FAILED\n'); process.exitCode = 1; });
}
