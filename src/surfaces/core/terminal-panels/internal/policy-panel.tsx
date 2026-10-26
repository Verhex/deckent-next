import { useEffect, useRef, useState } from 'react';
import { ArrowPicker } from '#surfaces/core/terminal-picker/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { panelWindowLines } from './lines.js';
import type { PanelLabels, PanelNotice, PolicyPanelPort, PolicyPanelPreview } from './contract.js';

type Groups = Awaited<ReturnType<PolicyPanelPort['inspect']>>['groups'];
type Stage = { kind: 'scopes'; scopes: readonly string[] } | { kind: 'groups'; scopeId: string; groups: Groups; delegation?: boolean }
  | { kind: 'action'; scopeId: string; group: Groups[number] } | { kind: 'preview'; preview: PolicyPanelPreview };
/** The existing bounded window/arrow selection pattern, with no text entry or filter. Page keys reveal every exact preview row. */
export function PolicyPanel({ port, labels, push, onError, onClose }: { readonly port: PolicyPanelPort; readonly labels: PanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly onError: (error: unknown) => void; readonly onClose: () => void }) {
  const words = labels.policy!;
  const [stage, setStage] = useState<Stage | null>(null), [busy, setBusy] = useState(true);
  const exits = useRef({ onError, onClose }); exits.current = { onError, onClose };
  useEffect(() => {
    let live = true;
    port.scopes().then(scopes => { if (live) { setStage({ kind: 'scopes', scopes }); setBusy(false); } }, error => {
      if (live) { exits.current.onError(error); exits.current.onClose(); }
    });
    return () => { live = false; };
  }, [port]);
  const fail = (error: unknown) => { onError(error); setBusy(false); };
  const scopes = () => { setBusy(true); void port.scopes().then(value => { setStage({ kind: 'scopes', scopes: value }); setBusy(false); }, fail); };
  const groups = (scopeId: string) => { setBusy(true); void port.inspect(scopeId).then(view => { setStage({ kind: 'groups', scopeId, groups: view.groups }); setBusy(false); }, fail); };
  const delegations = (scopeId: string) => { setBusy(true); void port.delegations?.(scopeId).then(view => { setStage({ kind: 'groups', scopeId, groups: view.groups, delegation: true }); setBusy(false); }, fail); };
  const preview = (scopeId: string, groupId: string, action: 'grant' | 'revoke' | 'narrow') => {
    setBusy(true); void port.preview(scopeId, groupId, action).then(view => { setStage({ kind: 'preview', preview: view }); setBusy(false); }, fail);
  };
  if (busy || !stage) return <Window maxColumns={80} title={[span(words.title)]} body={[{ spans: [span(labels.loading)] }]} hints={words.hints} position={labels.position} onInput={() => true} />;
  const rows = stage.kind === 'scopes' ? [...stage.scopes, words.back]
    : stage.kind === 'groups' ? [...stage.groups.map(group => `${group.label} · ${group.detail}`), ...(port.delegations && !stage.delegation ? [words.delegations!] : []), words.back]
    : stage.kind === 'action' ? stage.group.id.startsWith('decision:') ? [words.delegateGrant!, words.delegateRevoke!, words.back] : [stage.group.widerEarlier ? words.narrow! : words.grant, words.revoke, words.back]
    : stage.preview.applicable ? [words.confirm, words.back] : stage.preview.needsBaseline && port.ownerBaseline ? [words.completeBaseline!, words.back] : [words.back];
  const details = stage.kind === 'groups' ? stage.groups.map(group => group.detail) : [];
  const title = stage.kind === 'scopes' ? words.scope : stage.kind === 'groups' ? `${stage.delegation ? words.delegations : words.groups} · ${stage.scopeId}`
    : stage.kind === 'action' ? stage.group.label : words.preview;
  const lines = stage.kind === 'preview' ? stage.preview.lines : stage.kind === 'action' ? [{ label: '', text: stage.group.note }]
    : stage.kind === 'scopes' && !stage.scopes.length ? [{ label: '', text: words.empty }] : [];
  const select = (index: number) => {
    if (stage.kind === 'scopes') { const id = stage.scopes[index]; if (id) groups(id); else onClose(); }
    else if (stage.kind === 'groups') { const group = stage.groups[index]; if (group) setStage({ kind: 'action', scopeId: stage.scopeId, group }); else if (!stage.delegation && port.delegations && index === stage.groups.length) delegations(stage.scopeId); else if (stage.delegation) groups(stage.scopeId); else scopes(); }
    else if (stage.kind === 'action') { if (index < 2) preview(stage.scopeId, stage.group.id, index === 0 ? stage.group.widerEarlier ? 'narrow' : 'grant' : 'revoke'); else groups(stage.scopeId); }
    else if (stage.preview.applicable && index === 0) {
      setBusy(true);
      void port.apply(stage.preview).then(notices => { push(notices); if (stage.preview.delegation) delegations(stage.preview.scopeId); else groups(stage.preview.scopeId); }, fail);
    } else if (index === 0 && stage.preview.needsBaseline && port.ownerBaseline) {
      setBusy(true); void port.ownerBaseline(stage.preview.scopeId).then(preview => { setStage({ kind: 'preview', preview }); setBusy(false); }, fail);
    } else groups(stage.preview.scopeId);
  };
  return <Window maxColumns={80} title={[span(`${words.title} · ${title}`)]} body={panelWindowLines(lines)} hints={stage.kind === 'preview' && stage.preview.delegation ? words.delegationConfirm! : words.hints} position={labels.position}
    footerRows={stage.kind === 'preview' && stage.preview.delegation ? 0 : Math.min(rows.length, 6) + (details.length ? 1 : 0) + (rows.length > 6 ? 1 : 0)}
    onInput={(input, key) => {
      if (stage.kind === 'preview' && stage.preview.delegation) {
        if (/^y$/iu.test(input) && stage.preview.applicable) select(0);
        else if (/^n$/iu.test(input) || key.return || key.escape) delegations(stage.preview.scopeId);
        return !key.pageUp && !key.pageDown && !key.home && !key.end;
      }
      return key.upArrow || key.downArrow || key.return || key.escape || key.ctrl || (!key.pageUp && !key.pageDown && !key.home && !key.end);
    }}
    footer={focused => stage.kind === 'preview' && stage.preview.delegation ? null : <ArrowPicker key={`${stage.kind}:${title}`} rows={rows} details={details} maxColumns={76} active={focused && !(stage.kind === 'preview' && stage.preview.delegation)} onSelect={select}
      onCancel={() => stage.kind === 'scopes' ? onClose() : stage.kind === 'groups' ? scopes() : groups(stage.kind === 'action' ? stage.scopeId : stage.preview.scopeId)} />} />;
}
