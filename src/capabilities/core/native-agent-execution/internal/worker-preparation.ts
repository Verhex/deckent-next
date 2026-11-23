import type { NativeAgentReadinessReason } from './contract.js';
import { DeckentError, headlessDiagnosticIdentifier, type HeadlessDiagnosticIdentifier } from '#platform/index.js';
import type { NativeWorkerEvidenceFile } from './worker-verification.js';
import { nativeAgentPreflightReason } from './readiness.js';

/** The execution owner prepares only unknown observations. A refusal is never refreshed into a pass. */
export async function prepareNativeWorkerObservation(ports: {
  read(diagnose: (error: DeckentError) => void): Promise<unknown | null | undefined>;
  claim: NativeWorkerEvidenceFile['claim'];
  preflight(): Promise<unknown>;
}): Promise<NativeAgentReadinessReason | HeadlessDiagnosticIdentifier | null> {
  let observed: HeadlessDiagnosticIdentifier | undefined;
  const read = () => ports.read(error => { observed = headlessDiagnosticIdentifier(error.code, error.params ?? {}) ?? observed; });
  try {
    if (await read()) return null;
    const claim = await ports.claim();
    if (!claim) return 'NATIVE_AGENT_CAPABILITY_UNSEALED';
    let failed = false;
    try { if (!await read()) await ports.preflight(); }
    catch (error) { failed = true; throw error; }
    finally {
      await Promise.resolve().then(() => claim.release()).catch((error: unknown) => { if (!failed) throw error; });
    }
    return null;
  } catch (error) {
    const diagnostic = error instanceof DeckentError ? headlessDiagnosticIdentifier(error.code, error.params ?? {}) : undefined;
    return diagnostic ?? observed ?? nativeAgentPreflightReason(error);
  }
}
