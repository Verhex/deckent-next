import { useRef, useState } from 'react';
import type { ProjectInstructionPort, ProjectInstructionSource, ProjectInstructionView } from '#engine/index.js';
import { fillTemplate } from '#surfaces/core/terminal-render/index.js';
import { InstructionChoiceWindow } from './window.js';
import type { ProjectInstructionLabels } from './labels.js';
export function instructionSourceLine(source: ProjectInstructionSource, labels: ProjectInstructionLabels) {
  return fillTemplate(labels.source, { path: source.path, bytes: source.bytes, digest: source.digest });
}
export function instructionModelContext(view: ProjectInstructionView): string {
  return view.status === 'ready' ? `\n\n<project-instructions source=${JSON.stringify(view.source.path.split(/[\\/]/).at(-1))}>\n${view.source.content}\n</project-instructions>` : '';
}
/** Each turn re-reads the file. Declined, changed, unsafe and absent instructions cannot reach the model. */
export function useInstructionContext(port: ProjectInstructionPort | undefined, labels: ProjectInstructionLabels | undefined) {
  const [pending, setPending] = useState<ProjectInstructionSource | null>(null), source = useRef<ProjectInstructionSource | null>(null);
  const answer = useRef<((allow: boolean) => void) | null>(null), declined = useRef(new Set<string>());
  const finish = (allow: boolean) => { const resolve = answer.current; answer.current = null; setPending(null); resolve?.(allow); };
  const prepare = async (signal: AbortSignal): Promise<string> => {
    if (!port || !labels || signal.aborted) return '';
    source.current = null;
    let view = await port.inspect();
    if (view.status === 'trust-required' && !declined.current.has(view.source.digest)) {
      const digest = view.source.digest;
      const abort = () => finish(false);
      const allow = await new Promise<boolean>(resolve => { answer.current = resolve; setPending(view.status === 'trust-required' ? view.source : null);
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
      signal.removeEventListener('abort', abort);
      if (!allow) declined.current.add(digest);
      else view = await port.trust(digest);
    }
    if (view.status === 'ready' && !signal.aborted) source.current = view.source;
    return signal.aborted ? '' : instructionModelContext(view);
  };
  return { prepare, open: pending !== null, sourceLines: () => source.current && labels ? [instructionSourceLine(source.current, labels)] : [],
    window: pending && labels ? <InstructionChoiceWindow title={labels.trustTitle} labels={labels}
      body={[labels.trustBody, instructionSourceLine(pending, labels), ...pending.content.split('\n')]}
      choices={[labels.skip, labels.trust]} onChoice={index => finish(index === 1)} /> : null };
}
/** Line mode never infers consent from a pipe, full-access, identity or a workspace-local record. */
export async function lineInstructionContext(port: ProjectInstructionPort | undefined, digest?: string): Promise<ProjectInstructionView> {
  if (!port) return { status: 'absent' };
  const view = await port.inspect();
  return view.status === 'trust-required' && digest === view.source.digest ? port.trust(digest) : view;
}
