#!/usr/bin/env node
// P5a (owner 2026-10-31): bin + service entry (runtime-autostart ENTRY). Only node: built-ins and the platform common unit load before the compile cache is on; imported, it starts nothing.
import { enableDeckentCompileCache } from '#platform/core/state-root/index.js';
import { startProcessTiming } from '#platform/core/state-root/index.js';
if (import.meta.main) { enableDeckentCompileCache(); startProcessTiming(process.argv.slice(2)); }
const { startCli } = await import('./cli-main.js');
if (import.meta.main) startCli();
