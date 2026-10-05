// Test-only preload: leave argv/main-module detection and stdio bytes unchanged.
// The compiled MCP's transport starts consuming input only after module/config loading.
process.stdin.once('resume', () => {
  process.send('stdio-ready', () => process.disconnect());
});
