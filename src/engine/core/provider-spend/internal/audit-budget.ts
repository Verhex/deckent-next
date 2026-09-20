import { ProviderSpendError } from './error.js';

/** One deadline for the whole audit. Racing bounds waiting, not execution inside a foreign dependency. */
export class ProviderSpendAuditBudget {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly started: number;
  private readonly abort = () => this.controller.abort();
  constructor(private readonly timeoutMs: number, private readonly elapsed: () => number,
    private readonly caller?: AbortSignal) {
    this.started = elapsed();
    this.timer = setTimeout(this.abort, timeoutMs);
    caller?.addEventListener('abort', this.abort, { once: true });
    if (caller?.aborted) this.abort();
  }
  get signal(): AbortSignal { return this.controller.signal; }
  check() {
    if (this.elapsed() - this.started >= this.timeoutMs) this.abort();
    if (this.signal.aborted) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  }
  async run<T>(operation: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
    this.check(); let abandoned = false;
    const drop = (value: T) => { try { discard?.(value); } catch { /* Late cleanup cannot replace the delivered timeout. */ } };
    const pending = Promise.resolve().then(() => { this.check(); return operation(); }).then(value => {
      if (abandoned) drop(value);
      return value;
    });
    let interrupt: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE'));
      this.signal.addEventListener('abort', interrupt, { once: true });
      if (this.signal.aborted) interrupt();
    });
    try {
      const value = await Promise.race([pending, cancelled]);
      try { this.check(); } catch (error) { drop(value); throw error; }
      return value;
    } catch (error) { abandoned = true; throw error; }
    finally { if (interrupt) this.signal.removeEventListener('abort', interrupt); }
  }
  dispose() { clearTimeout(this.timer); this.caller?.removeEventListener('abort', this.abort); }
}
