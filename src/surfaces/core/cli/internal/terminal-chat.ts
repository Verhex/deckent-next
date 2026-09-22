import type { InferenceServingProfile } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { InferenceChatMessage } from '#engine/index.js';

export type TerminalChatTurnHandler = (
  root: string,
  profile: InferenceServingProfile,
  messages: readonly InferenceChatMessage[],
  options: ConfigLoadOptions,
  signal?: AbortSignal,
) => Promise<string>;

export type TerminalChatPlanHandler = (
  root: string,
  options: ConfigLoadOptions,
) => Promise<{ readonly backend: string; readonly invokeReady: boolean; readonly blockCode?: string }>;
