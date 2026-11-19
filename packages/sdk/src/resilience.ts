/**
 * Resilience utilities for Accord Protocol SDK:
 * Exponential backoff with jitter, retry loops, and circuit-breaker handling.
 */

import { AccordError } from "./errors.js";

export class CircuitBreakerOpenError extends AccordError {
  constructor(message = "Circuit breaker is OPEN. Requests are temporarily blocked.") {
    super(message, "CIRCUIT_BREAKER_OPEN");
    this.name = "CircuitBreakerOpenError";
  }
}

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3). */
  maxRetries?: number;
  /** Initial delay before the first retry in milliseconds (default: 100). */
  baseDelayMs?: number;
  /** Maximum delay cap between retries in milliseconds (default: 5000). */
  maxDelayMs?: number;
  /** Exponential backoff factor (default: 2). */
  factor?: number;
  /** Whether to apply randomized full jitter to delays (default: true). */
  jitter?: boolean;
  /** Optional timeout per operation in milliseconds. */
  timeoutMs?: number;
  /** Custom predicate deciding whether to retry on an error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * Executes an async operation with exponential backoff and jitter on failures.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? true;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let attempt = 0;

  while (true) {
    try {
      if (options.timeoutMs && options.timeoutMs > 0) {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new AccordError(`Operation timed out after ${options.timeoutMs}ms`, "TIMEOUT")),
              options.timeoutMs
            )
          ),
        ]);
      }
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries || !shouldRetry(err, attempt)) {
        throw err;
      }

      // Calculate backoff delay
      let delay = baseDelayMs * Math.pow(factor, attempt - 1);
      delay = Math.min(delay, maxDelayMs);
      if (jitter) {
        delay = Math.floor(Math.random() * delay);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening the circuit (default: 5). */
  failureThreshold?: number;
  /** Duration in milliseconds to stay OPEN before testing recovery in HALF_OPEN (default: 30000). */
  resetTimeoutMs?: number;
  /** Successful consecutive calls in HALF_OPEN to close the circuit (default: 2). */
  halfOpenSuccessThreshold?: number;
}

/**
 * Standard Circuit Breaker protecting remote RPC endpoints against cascading failures.
 */
export class CircuitBreaker {
  private _state: CircuitBreakerState = "CLOSED";
  private _failures = 0;
  private _successes = 0;
  private _nextAttempt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly listeners: Set<(state: CircuitBreakerState) => void> = new Set();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 2;
  }

  get state(): CircuitBreakerState {
    if (this._state === "OPEN" && Date.now() >= this._nextAttempt) {
      this.transitionTo("HALF_OPEN");
    }
    return this._state;
  }

  get failures(): number {
    return this._failures;
  }

  /**
   * Executes an operation through the circuit breaker.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state;
    if (currentState === "OPEN") {
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Reset breaker back to CLOSED initial state. */
  reset(): void {
    this._failures = 0;
    this._successes = 0;
    this._nextAttempt = 0;
    this.transitionTo("CLOSED");
  }

  onStateChange(listener: (state: CircuitBreakerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onSuccess(): void {
    if (this._state === "HALF_OPEN") {
      this._successes++;
      if (this._successes >= this.halfOpenSuccessThreshold) {
        this.reset();
      }
    } else if (this._state === "CLOSED") {
      this._failures = 0;
    }
  }

  private onFailure(): void {
    this._failures++;
    if (this._state === "HALF_OPEN" || this._failures >= this.failureThreshold) {
      this._nextAttempt = Date.now() + this.resetTimeoutMs;
      this.transitionTo("OPEN");
    }
  }

  private transitionTo(newState: CircuitBreakerState): void {
    if (this._state !== newState) {
      this._state = newState;
      for (const listener of this.listeners) {
        try {
          listener(newState);
        } catch {
          // ignore callback errors
        }
      }
    }
  }
}

/**
 * Combines retry backoff and circuit breaker wrapper around an async operation.
 */
export async function withResilience<T>(
  fn: () => Promise<T>,
  options: { retry?: RetryOptions; breaker?: CircuitBreaker } = {}
): Promise<T> {
  const runner = options.breaker
    ? () => options.breaker!.execute(fn)
    : fn;

  if (options.retry) {
    return retryWithBackoff(runner, options.retry);
  }
  return runner();
}
