import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  retryWithBackoff,
  withResilience,
} from "../resilience.js";

describe("Resilience: retryWithBackoff", () => {
  it("resolves immediately on success", async () => {
    let calls = 0;
    const res = await retryWithBackoff(async () => {
      calls++;
      return "ok";
    });
    expect(res).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on failure and succeeds when succeeding within maxRetries", async () => {
    let calls = 0;
    const res = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "success";
      },
      { maxRetries: 3, baseDelayMs: 1, jitter: false }
    );
    expect(res).toBe("success");
    expect(calls).toBe(3);
  });

  it("fails after exceeding maxRetries", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new Error("permanent");
        },
        { maxRetries: 2, baseDelayMs: 1, jitter: false }
      )
    ).rejects.toThrow("permanent");
    expect(calls).toBe(3);
  });
});

describe("Resilience: CircuitBreaker", () => {
  it("trips to OPEN after failure threshold", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });
    expect(cb.state).toBe("CLOSED");

    await expect(cb.execute(async () => { throw new Error("fail 1"); })).rejects.toThrow("fail 1");
    expect(cb.state).toBe("CLOSED");

    await expect(cb.execute(async () => { throw new Error("fail 2"); })).rejects.toThrow("fail 2");
    expect(cb.state).toBe("OPEN");

    await expect(cb.execute(async () => "fast fail")).rejects.toThrow(CircuitBreakerOpenError);
  });

  it("can be manually reset", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    expect(cb.state).toBe("CLOSED");
    cb.reset();
    expect(cb.state).toBe("CLOSED");
    expect(cb.failures).toBe(0);
  });
});

describe("Resilience: withResilience", () => {
  it("combines retry and breaker execution", async () => {
    const breaker = new CircuitBreaker();
    let calls = 0;
    const res = await withResilience(
      async () => {
        calls++;
        return 42;
      },
      { retry: { maxRetries: 1 }, breaker }
    );
    expect(res).toBe(42);
    expect(calls).toBe(1);
  });
});
