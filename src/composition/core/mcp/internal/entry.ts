#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig, resolveLocale } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { createMcpServer } from '#surfaces/index.js';
import { inspectConfiguredRun, requestConfiguredRunCancellation, deliverConfiguredRunCancellation } from '#composition/core/runs/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
/** Stdio peer inherits this local OS user's identity. This entry is not a remote authentication mechanism. */
export async function main(root = process.cwd()) {
  registerProviderConfig(); const config = await loadConfig(root, { heal: false });
  const locale = resolveLocale(undefined, process.env, config.language);
  return serveStdio(() => createMcpServer({ deliverRunCancellation: command => deliverConfiguredRunCancellation(root, command), requestRunCancellation: command => requestConfiguredRunCancellation(root, command), inspectRun: query => inspectConfiguredRun(root, query),
    inspectInventory: query => inspectConfiguredInventory(root, query) }, { maxConcurrentCalls: config.mcp.maxConcurrentCalls, responseMaxBytes: config.mcp.responseMaxBytes }, locale), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: config.mcp.inputMaxBytes }),
    onerror: () => { process.stderr.write('MCP_TRANSPORT_FAILED\n'); },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    const { values } = parseArgs({ options: { project: { type: 'string' } }, strict: true, allowPositionals: false });
    if (values.project !== undefined && !values.project.trim()) throw new Error('MCP_PROJECT_INVALID');
    await main(resolve(values.project ?? process.cwd()));
  })().catch(() => { process.stderr.write('MCP_START_FAILED\n'); process.exitCode = 1; });
}
