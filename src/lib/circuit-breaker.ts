// ---------------------------------------------------------------------------
// Circuit breaker — stop hammering a dependency that is already down.
//
// Motivated by the 2026-09-22 D1 incident: a ~40s Cloudflare-side slow window
// turned into an error storm because every caller kept retrying through it —
// the VPS containers re-ticked every 5s, the worker accepted every inbound
// raw-batch request and held each D1 call for the full 15s timeout. A breaker
// converts that into ~threshold failures per caller, then a quiet cool-down
// with ONE probe request when it elapses.
//
// Shared by both D1 entry points:
//   • src/store.ts d1HttpRawExecutor (VPS process, one instance per executor)
//   • src/cf/internal.ts POST /internal/raw-batch (per-isolate instance)
//
// Half-open gating: after the cool-down exactly ONE caller passes as the
// probe; concurrent callers still fail fast until the probe settles. Only
// infra-shaped failures (timeouts, D1 errors, 5xx, network) count — an
// application bug must not open the circuit. Consecutive successes reset.
// ---------------------------------------------------------------------------

export class CircuitOpenError extends Error {
  constructor(name: string, msLeft: number, lastError: string) {
    super(
      `${name}: circuit open for another ${Math.ceil(msLeft / 1000)}s — failing fast `
      + `(last infra error: ${lastError})`,
    );
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Appears in the thrown error so logs name the dependency. */
  name: string;
  /** Consecutive infra failures before the circuit opens. Default 3. */
  threshold?: number;
  /** How long an open circuit refuses traffic before probing again. Default 60s. */
  cooldownMs?: number;
  /** Which failures count as infra. Default: timeouts, D1 errors, 5xx, network. */
  isInfraError?: (err: unknown) => boolean;
  now?: () => number;
}

const DEFAULT_IS_INFRA = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /timed out|timeout|aborted|D1_ERROR|internal error|fetch failed|HTTP 5\d\d|network/i.test(msg);
};

export class CircuitBreaker {
  private readonly name: string;
  private failures = 0;
  private openUntil = 0;
  private probing = false;
  private lastError = '';
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly isInfraError: (err: unknown) => boolean;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.threshold = Math.max(1, opts.threshold ?? 3);
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.isInfraError = opts.isInfraError ?? DEFAULT_IS_INFRA;
    this.now = opts.now ?? Date.now;
  }

  /** True while the circuit refuses traffic (also used by tests/metrics). */
  get isOpen(): boolean {
    return this.now() < this.openUntil || (this.failures >= this.threshold && this.probing);
  }

  async execute<T>(op: () => Promise<T>): Promise<T> {
    const t = this.now();
    if (t < this.openUntil) {
      throw new CircuitOpenError(this.name, this.openUntil - t, this.lastError);
    }
    const wasOpen = this.failures >= this.threshold;
    if (wasOpen && this.probing) {
      // Cool-down elapsed but the single probe has not settled yet.
      throw new CircuitOpenError(this.name, 0, this.lastError);
    }
    if (wasOpen) this.probing = true;
    try {
      const result = await op();
      this.failures = 0;
      this.openUntil = 0;
      this.probing = false;
      return result;
    } catch (err) {
      this.probing = false;
      if (this.isInfraError(err)) {
        this.failures++;
        this.lastError = err instanceof Error ? err.message : String(err);
        if (this.failures >= this.threshold) this.openUntil = this.now() + this.cooldownMs;
      }
      throw err;
    }
  }
}
