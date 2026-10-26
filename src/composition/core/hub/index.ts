export { configuredHubClient } from './internal/application.js';
export { createGovernedHubFetch, type HubFetchDependencies, type HubFirstUseReceipt } from '#adapters/index.js';
// startHubService (internal/network.ts) is the separate Hub process's entry, not SDK API: its signature names hub surface types, and this barrel
// is in the published type closure, so exporting it here would ship every surface declaration (ink, react, JSON imports) to SDK consumers.

export { executeConfiguredHub, type ConfiguredHubPorts } from './internal/operations.js';
export { governedHubOperations } from '#adapters/index.js';
