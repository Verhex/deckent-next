import { createRuntimeModelCalls } from '#engine/index.js';
import { createConfiguredRuntimeClient } from './client.js';
export const { invokeRuntimeModel, invokeRuntimeModelStream, inspectRuntimeModelInvocation, purgeRuntimeModelInvocationContent, cancelRuntimeModelInvocation, runRuntimeChatTurn, cancelRuntimeChatTurn, findRuntimeWorkspaceFiles, attachRuntimeWorkspaceFile } = createRuntimeModelCalls(createConfiguredRuntimeClient);
