/** Serial polling shared by RPC events and the analytics API. */
export function startPolling(
  task: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void = () => {},
) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("Polling interval must be a positive finite number");
  }
  const controller = new AbortController();
  const maxDelay = Math.max(intervalMs, 30_000);
  let delay = intervalMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  function refresh(): Promise<void> {
    if (controller.signal.aborted) return Promise.resolve();
    if (running) return running;
    clearTimeout(timer);
    delay = intervalMs;
    return run();
  }

  function run(): Promise<void> {
    running = Promise.resolve()
      .then(() => {
        if (!controller.signal.aborted) return task(controller.signal);
      })
      .then(() => { delay = intervalMs; })
      .catch((error: unknown) => {
        delay = Math.min(delay * 2, maxDelay);
        if (!controller.signal.aborted) onError(error);
      })
      .finally(() => {
        running = undefined;
        if (!controller.signal.aborted) timer = setTimeout(run, delay);
      });
    return running;
  }

  void run();
  return {
    refresh,
    stop() {
      controller.abort();
      clearTimeout(timer);
    },
  };
}
