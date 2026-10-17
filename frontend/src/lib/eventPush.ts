export type PushChannelStatus = "connecting" | "connected" | "disconnected" | "fallback";

export type EventPushOptions = {
  url?: string;
  useSSE?: boolean;
  reconnectIntervalMs?: number;
  maxReconnectIntervalMs?: number;
  onStatusChange?: (status: PushChannelStatus) => void;
  onError?: (err: unknown) => void;
};

export type EventPushConnection = {
  status: PushChannelStatus;
  close: () => void;
};

/**
 * Creates a push channel (WebSocket or SSE EventSource) for real-time contract event updates.
 * Automatically handles connection status reporting, fallback, and exponential backoff reconnection.
 */
export function startEventPush(
  onEvent: (data?: unknown) => void,
  options: EventPushOptions = {},
): EventPushConnection {
  const initialReconnectDelay = Math.max(500, options.reconnectIntervalMs ?? 2000);
  const maxReconnectDelay = Math.max(initialReconnectDelay, options.maxReconnectIntervalMs ?? 30000);

  let currentReconnectDelay = initialReconnectDelay;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let activeSocket: WebSocket | null = null;
  let activeEventSource: EventSource | null = null;
  let isClosed = false;

  let currentStatus: PushChannelStatus = "connecting";

  function setStatus(status: PushChannelStatus) {
    if (isClosed && status !== "disconnected") return;
    currentStatus = status;
    options.onStatusChange?.(status);
  }

  // Resolve push URL
  function resolveUrl(): string | null {
    if (options.url) return options.url;
    try {
      if (typeof import.meta !== "undefined" && import.meta.env) {
        if (import.meta.env.VITE_EVENT_PUSH_URL) return String(import.meta.env.VITE_EVENT_PUSH_URL);
        if (import.meta.env.VITE_WS_URL) return String(import.meta.env.VITE_WS_URL);
      }
    } catch {
      // ignore
    }
    return null;
  }

  function scheduleReconnect() {
    if (isClosed) return;
    clearTimeout(reconnectTimer);
    setStatus("fallback");
    reconnectTimer = setTimeout(() => {
      if (!isClosed) {
        currentReconnectDelay = Math.min(currentReconnectDelay * 1.5, maxReconnectDelay);
        connect();
      }
    }, currentReconnectDelay);
  }

  function cleanupActiveConnection() {
    if (activeSocket) {
      activeSocket.onopen = null;
      activeSocket.onmessage = null;
      activeSocket.onerror = null;
      activeSocket.onclose = null;
      try {
        activeSocket.close();
      } catch {
        // ignore
      }
      activeSocket = null;
    }

    if (activeEventSource) {
      activeEventSource.onopen = null;
      activeEventSource.onmessage = null;
      activeEventSource.onerror = null;
      try {
        activeEventSource.close();
      } catch {
        // ignore
      }
      activeEventSource = null;
    }
  }

  function connect() {
    if (isClosed) return;
    cleanupActiveConnection();

    const pushUrl = resolveUrl();
    if (!pushUrl) {
      setStatus("fallback");
      return;
    }

    const isSSE =
      options.useSSE ||
      pushUrl.startsWith("http://") ||
      pushUrl.startsWith("https://") ||
      pushUrl.includes("/sse") ||
      pushUrl.includes("/events");

    try {
      if (isSSE && typeof EventSource !== "undefined") {
        setStatus("connecting");
        const es = new EventSource(pushUrl);
        activeEventSource = es;

        es.onopen = () => {
          if (isClosed) return;
          currentReconnectDelay = initialReconnectDelay;
          setStatus("connected");
        };

        es.onmessage = (event) => {
          if (isClosed) return;
          try {
            onEvent(event.data ? JSON.parse(event.data) : undefined);
          } catch {
            onEvent(event.data);
          }
        };

        es.onerror = (err) => {
          if (isClosed) return;
          options.onError?.(err);
          cleanupActiveConnection();
          scheduleReconnect();
        };
      } else if (typeof WebSocket !== "undefined") {
        setStatus("connecting");
        const ws = new WebSocket(pushUrl);
        activeSocket = ws;

        ws.onopen = () => {
          if (isClosed) return;
          currentReconnectDelay = initialReconnectDelay;
          setStatus("connected");
        };

        ws.onmessage = (event) => {
          if (isClosed) return;
          try {
            onEvent(event.data ? JSON.parse(event.data) : undefined);
          } catch {
            onEvent(event.data);
          }
        };

        ws.onerror = (err) => {
          if (isClosed) return;
          options.onError?.(err);
        };

        ws.onclose = () => {
          if (isClosed) return;
          cleanupActiveConnection();
          scheduleReconnect();
        };
      } else {
        // Neither WebSocket nor EventSource available in this environment
        setStatus("fallback");
      }
    } catch (err) {
      options.onError?.(err);
      scheduleReconnect();
    }
  }

  connect();

  return {
    get status() {
      return currentStatus;
    },
    close() {
      isClosed = true;
      clearTimeout(reconnectTimer);
      cleanupActiveConnection();
      setStatus("disconnected");
    },
  };
}
