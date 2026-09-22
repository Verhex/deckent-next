import { describe, expect, it } from 'vitest';
import { describeTerminalChatPlan, buildOpenAiChatNativeRequest } from '#composition/core/terminal-chat/index.js';
import type { InferenceServingProfile } from '#domain/index.js';

const profile: InferenceServingProfile = {
  schemaVersion: 1,
  id: 'p1',
  scopeId: 'scope-1',
  hardware: { gpus: 1, vramGbPerGpu: 32, arch: 'blackwell_consumer', topology: 'single' },
  model: { modelId: 'm1', weightGb: 16, kvBytesPerTokenBf16: 1, kvBytesPerTokenFp8: 1, deltaNetStateGbPerSeq: 0 },
  serving: { backend: 'openai-compatible', openaiBaseUrl: 'http://127.0.0.1:1/v1', weightQuant: 'q4', kvDtype: 'fp8', gpuMemUtil: 0.9, overheadGb: 1 },
  workload: { maxCtx: 8192, avgActiveCtx: 2048, roleMaxCtx: { brain: 8192, worker: 4096, auditor: 2048 } },
  calibration: { computeCap: 4 },
};

describe('terminal chat plan', () => {
  it('defaults to invoke_model and blocks without binding', () => {
    const plan = describeTerminalChatPlan({}, {});
    expect(plan.backend).toBe('invoke_model');
    expect(plan.invokeReady).toBe(false);
    expect(plan.blockCode).toBe('TERMINAL_CHAT_INVOKE_BINDING_REQUIRED');
  });

  it('allows dev inference_http when explicitly configured', () => {
    const plan = describeTerminalChatPlan({
      terminal: { chat: { schemaVersion: 1, backend: 'inference_http' } },
    }, {});
    expect(plan.backend).toBe('inference_http');
    expect(plan.blockCode).toBeUndefined();
  });

  it('blocks invoke_model without binding instead of silent http fallback', () => {
    const plan = describeTerminalChatPlan({
      terminal: { chat: { schemaVersion: 1, backend: 'invoke_model' } },
    }, {});
    expect(plan.backend).toBe('invoke_model');
    expect(plan.invokeReady).toBe(false);
    expect(plan.blockCode).toBe('TERMINAL_CHAT_INVOKE_BINDING_REQUIRED');
  });

  it('builds openai native request shape', () => {
    const body = buildOpenAiChatNativeRequest(profile, 'm1', [{ role: 'user', content: 'hi' }]);
    expect(body.model).toBe('m1');
    expect(body.stream).toBe(false);
    expect((body.messages as unknown[]).length).toBe(1);
  });
});
