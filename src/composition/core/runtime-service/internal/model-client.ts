import { createRuntimeModelCalls } from '#engine/index.js';
import { createConfiguredRuntimeClient } from './client.js';
export const { invokeRuntimeModel, invokeRuntimeModelStream, inspectRuntimeModelInvocation, purgeRuntimeModelInvocationContent, cancelRuntimeModelInvocation, runRuntimeChatTurn, cancelRuntimeChatTurn, steerRuntimeChatTurn, findRuntimeWorkspaceFiles, attachRuntimeWorkspaceFile } = createRuntimeModelCalls(createConfiguredRuntimeClient);
