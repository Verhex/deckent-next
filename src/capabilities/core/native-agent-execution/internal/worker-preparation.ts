import type { NativeAgentReadinessReason } from './contract.js';
import type { NativeWorkerEvidenceFile } from './worker-verification.js';

/** The execution owner prepares only unknown observations. A refusal is never refreshed into a pass. */
export async function prepareNativeWorkerObservation(ports: {
  read(): Promise<unknown | null | undefined>;
  claim: NativeWorkerEvidenceFile['claim'];
  preflight(): Promise<unknown>;
}): Promise<NativeAgentReadinessReason | null> {
  try {
    if (await ports.read()) return null;
    const claim = await ports.claim();
    if (!claim) return 'NATIVE_AGENT_CAPABILITY_UNSEALED';
    try { if (!await ports.read()) await ports.preflight(); }
    finally { await claim.release(); }
    return null;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'HEADLESS_LOGIN_REQUIRED' ? 'NATIVE_AGENT_LOGIN_REQUIRED'
      : code === 'HEADLESS_CLI_UNAVAILABLE' ? 'NATIVE_AGENT_CLI_UNAVAILABLE' : 'NATIVE_AGENT_ENVIRONMENT_REFUSED';
  }
}
