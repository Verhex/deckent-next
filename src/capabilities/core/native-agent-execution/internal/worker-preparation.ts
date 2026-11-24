import type { NativeAgentReadinessReason } from './contract.js';
import { DeckentError, headlessDiagnosticIdentifier, isHeadlessDiagnosticCode, refuseHeadlessDiagnostic, type HeadlessDiagnosticIdentifier } from '#platform/index.js';
import type { NativeWorkerEvidenceFile } from './worker-verification.js';
import { nativeAgentPreflightReason } from './readiness.js';

/** The execution owner prepares only unknown observations. A refusal is never refreshed into a pass. */
export async function prepareNativeWorkerObservation(ports: {
  read(diagnose: (error: DeckentError) => void): Promise<unknown | null | undefined>;
  claim: NativeWorkerEvidenceFile['claim'];
  preflight(): Promise<unknown>;
}): Promise<NativeAgentReadinessReason | HeadlessDiagnosticIdentifier | null> {
  let observed: HeadlessDiagnosticIdentifier | undefined;
  try {
    if (await ports.read(error => { observed = headlessDiagnosticIdentifier(error.code, error.params ?? {}); })) return null;
    const claim = await ports.claim();
    if (!claim) return observed ?? 'NATIVE_AGENT_CAPABILITY_UNSEALED';
    let failed = false;
    try { if (!await ports.read(() => undefined)) await ports.preflight(); }
    catch (error) { failed = true; throw error; }
    finally {
      await Promise.resolve().then(() => claim.release()).catch((error: unknown) => {
        if (failed) return;
        if (error instanceof DeckentError && isHeadlessDiagnosticCode(error.code)) throw error;
        refuseHeadlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'worker-preparation-release' });
      });
    }
    return null;
  } catch (error) {
    const diagnostic = error instanceof DeckentError ? headlessDiagnosticIdentifier(error.code, error.params ?? {}) : undefined;
    return diagnostic ?? nativeAgentPreflightReason(error);
  }
}
