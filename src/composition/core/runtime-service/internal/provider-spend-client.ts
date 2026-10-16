import { createRuntimeSpendCalls } from '#engine/index.js';
import { createConfiguredRuntimeClient } from './client.js';
export const { inspectRuntimeProviderSpendAccount, auditRuntimeProviderSpendAccount, manageRuntimeProviderSpend } = createRuntimeSpendCalls(createConfiguredRuntimeClient);
