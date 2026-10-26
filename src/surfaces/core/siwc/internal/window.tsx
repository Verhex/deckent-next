import { useEffect, useRef, useState } from 'react';
import { ErrorRegistry, t, terminalSafeText } from '#platform/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import { Window, QuestionRows, questionStep, WINDOW_PRIORITY, type QuestionState } from '#surfaces/core/terminal-window/index.js';
import type { SiwcResult, SiwcWindowPort } from './port.js';

const SECOND_MS = 1000;
/** The same bounded window/focus owner as every terminal card; no second shell or runtime sign-in. */
export default function SiwcWindow({ port, onClose, onError }: { readonly port: SiwcWindowPort; readonly onClose: () => void; readonly onError: (error: unknown) => void }) {
  const freshAccount = useRef(false), busy = useRef(false), [problem, setProblem] = useState<string | null>(null);
  const [stage, setStage] = useState<'background' | 'api' | 'browser' | 'result'>('background');
  const [selection, setSelection] = useState<QuestionState>({ at: 0, ticked: [] }), current = useRef(selection); current.current = selection;
  const [targets, setTargets] = useState<NonNullable<SiwcResult['apiTargets']>>([]), [result, setResult] = useState<SiwcResult | null>(null);
  const [url, setUrl] = useState<string | null>(null), [seconds, setSeconds] = useState(0), [usageUrl, setUsageUrl] = useState<string | null>(null), background = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (stage !== 'browser') return;
    const started = Date.now(), timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / SECOND_MS)), SECOND_MS);
    return () => clearInterval(timer);
  }, [stage]);
  const close = () => { controller.current?.abort(); onClose(); };
  const options = stage === 'background' ? [{ id: 'no', label: t('siwc.card.onlyTyping', {}, port.locale) }, { id: 'yes', label: t('siwc.card.backgroundYes', {}, port.locale) }]
    : stage === 'api' ? [{ id: 'no', label: t('siwc.card.apiOff', {}, port.locale) }, ...targets.map((row, index) => ({ id: String(index), label: terminalSafeText(row.id) }))]
      : stage === 'result' ? [...(result?.state === 'disconnected' ? [{ id: 'new-account', label: t('siwc.card.otherAccount', {}, port.locale) }] : []), { id: 'close', label: t('siwc.card.close', {}, port.locale) }, ...(result?.connectionId && result.state !== 'disconnected' ? [{ id: 'usage', label: t('siwc.usage.title', {}, port.locale) }, { id: 'revoke', label: t('siwc.card.revokeConsent', {}, port.locale) }, { id: 'logout', label: t('siwc.revoke.title', {}, port.locale) }] : [])] : [];
  const lines = stage === 'background' ? [t('siwc.card.body', {}, port.locale), t('siwc.privacy.body', {}, port.locale), t('siwc.card.connectedAppOnly', {}, port.locale), t('siwc.card.background', {}, port.locale)]
    : stage === 'api' ? [t('siwc.card.apiQuestion', {}, port.locale), t('siwc.card.apiCost', {}, port.locale)]
      : stage === 'browser' ? [t('siwc.browser.waiting', { seconds }, port.locale), ...(url ? [t('siwc.browser.fallback', {}, port.locale), url] : [])]
        : problem ? [problem] : [t('siwc.preview', {}, port.locale), result?.state === 'disconnected' ? t('siwc.revoke.done', {}, port.locale) : t('siwc.welcome.body', {}, port.locale), ...(result?.email ? [result.email] : []),
          ...(usageUrl ? [t('siwc.usage.manage', { url: usageUrl }, port.locale)] : []),
          ...(result?.usage ? [result.usage.state === 'complete' ? t('siwc.usage.summary', { days: result.usage.days, total: result.usage.completedRequests!, busiest: result.usage.busiestDayRequests!, active: result.usage.activeDays! }, port.locale) : t('siwc.usage.unknown', {}, port.locale)] : []),
          ...(result?.remoteRevocation === 'unconfirmed' ? [t('siwc.revoke.unconfirmed', {}, port.locale)] : []),
          ...(result?.models?.status === 'approval-pending' ? [t('siwc.card.approvalPending', {}, port.locale)] : [t('siwc.welcome.ready', {}, port.locale)])];
  const choose = async (id: string) => {
    if (stage === 'result') {
      if (id === 'close') { close(); return; }
      if (id === 'new-account') { freshAccount.current = true; setResult(null); setSelection({ at: 0, ticked: [] }); setStage('background'); return; }
      if (!result?.connectionId) return;
      const abort = new AbortController(); controller.current = abort;
      const updated = await port.execute({ operation: id === 'usage' ? 'usage' : id === 'logout' ? 'logout' : 'connect', connectionId: result.connectionId,
        ...(id === 'revoke' ? { delegate: [], apiContinuation: null } : {}) }, { signal: abort.signal });
      if (abort.signal.aborted) return;
      setResult(id === 'usage' ? { ...result, ...updated } : updated); return;
    }
    if (stage === 'background') {
      background.current = id === 'yes';
      const prepared = await port.execute({ operation: 'prepare' }); setTargets(prepared.apiTargets ?? []); setUsageUrl(prepared.usageUrl ?? null); setSelection({ at: 0, ticked: [] }); setStage('api'); return;
    }
    if (stage !== 'api') return;
    const target = id === 'no' ? null : targets[Number(id)];
    if (id !== 'no' && !target) return;
    const abort = new AbortController(); controller.current = abort; setStage('browser');
    const connected = await port.execute({ operation: 'connect', ...(freshAccount.current ? { newAccount: true } : {}), delegate: background.current ? ['ai', 'system'] : [], apiContinuation: target?.reference ?? null },
      { signal: abort.signal, fallback: value => { if (!abort.signal.aborted) setUrl(value); } });
    if (!abort.signal.aborted) { setResult(connected); setSelection({ at: 0, ticked: [] }); setStage('result'); }
  };
  return <Window title={[span(t('siwc.card.title', {}, port.locale))]} body={lines.map(text => ({ spans: [span(terminalSafeText(text))], ...(text === url ? { exact: true } : {}) }))}
    hints={t('siwc.card.keys', {}, port.locale)} position="{from}-{to}/{total}" priority={WINDOW_PRIORITY.approval} decision footerRows={options.length}
    footer={owns => <QuestionRows kind="single" options={options} state={selection} focused={owns} />} onClose={close}
    onInput={(input, key, meta) => {
      if (meta?.burst) return true;
      const next = questionStep('single', options, current.current, input, key);
      if (next.kind === 'cancel') { close(); return true; }
      if (next.kind === 'move') { current.current = next.state; setSelection(next.state); return true; }
      if (next.kind === 'submit' && next.ids[0] && !busy.current) { busy.current = true; void choose(next.ids[0]).catch(error => {
        // R23: the refusal keeps its own cause (the CLI's and doctor's words and fix); the card resets its selection so Enter closes it.
        if (!controller.current?.signal.aborted) { const code = (error as { code?: string })?.code ?? 'unknown', params = (error as { params?: Readonly<Record<string, string | number>> })?.params ?? {};
          setProblem(ErrorRegistry.get(code, port.locale, params)?.message ?? t('error.unknown', { code }, port.locale)); current.current = { at: 0, ticked: [] }; setSelection(current.current); setStage('result'); onError(ErrorRegistry.createError(code, { params })); }
      }).finally(() => { busy.current = false; }); return true; }
      return key.tab;
    }} />;
}
