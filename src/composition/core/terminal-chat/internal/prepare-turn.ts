import { randomUUID } from 'node:crypto';
import type { InferenceServingProfile, JsonObject, ModelInvocationCommand } from '#domain/index.js';
import { resolveServedModelId, type InferenceChatMessage } from '#engine/index.js';
import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { invokeModelConfigReady, readTerminalChatSection, resolveConfiguredChatBackend } from './config.js';
import { buildOpenAiChatNativeRequest } from './openai-native.js';
import { terminalChatBlockCode } from './block.js';
import type { TerminalChatBackend } from './turn.js';

export interface TerminalChatPlan {
  readonly backend: TerminalChatBackend;
  readonly modelInvocation?: ModelInvocationCommand;
  readonly invokeReady: boolean;
  readonly blockCode?: string;
}

export function describeTerminalChatPlan(config: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env): TerminalChatPlan {
  const section = readTerminalChatSection(config);
  const invokeReady = invokeModelConfigReady(section);
  const backend = resolveConfiguredChatBackend(section, env);
  const blockCode = terminalChatBlockCode(backend, section);
  return { backend, invokeReady, ...(blockCode ? { blockCode } : {}) };
}

export async function loadTerminalChatTurnPlan(projectRoot: string, profile: InferenceServingProfile,
  messages: readonly InferenceChatMessage[], options: ConfigLoadOptions = {},
  env: Record<string, string | undefined> = process.env, signal?: AbortSignal): Promise<TerminalChatPlan> {
  const config = await loadConfig(projectRoot, options);
  const section = readTerminalChatSection(config as Record<string, unknown>);
  const invokeReady = invokeModelConfigReady(section);
  const backend = resolveConfiguredChatBackend(section, env);
  const blockCode = terminalChatBlockCode(backend, section);
  if (blockCode) {
    return { backend, invokeReady, blockCode };
  }
  if (backend !== 'invoke_model' || !section?.reference || !section.catalogRevision || !section.expectedBinding) {
    return { backend, invokeReady };
  }
  const model = await resolveServedModelId(profile, signal);
  const nativeRequest = buildOpenAiChatNativeRequest(profile, model, messages);
  const command: ModelInvocationCommand = {
    schemaVersion: 1,
    commandId: randomUUID(),
    scopeId: profile.scopeId,
    reference: section.reference,
    catalogRevision: section.catalogRevision,
    expectedBinding: section.expectedBinding,
    nativeRequest: nativeRequest as JsonObject,
  };
  return { backend: 'invoke_model', modelInvocation: command, invokeReady: true };
}
