/**
 * Typed Event Subscription and Stream Decoding for Accord Protocol SDK.
 * Supports polling, reconnects, cursor resumption, and deduplication.
 */

export type AccordEventType =
  | "proposal_created"
  | "proposal_approved"
  | "proposal_executed"
  | "proposal_revoked"
  | "owner_added"
  | "owner_removed"
  | "threshold_changed"
  | "emergency_paused"
  | "emergency_unpaused"
  | "transfer"
  | "unknown";

export interface AccordParsedEvent<T = Record<string, unknown>> {
  /** Unique composite event identifier: `${txHash}:${ledger}:${eventIndex}` */
  id: string;
  type: AccordEventType;
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  timestamp: string;
  data: T;
}

export interface EventSubscriptionFilter {
  /** Target contract address. */
  contractId?: string;
  /** Filter to specific event types. */
  types?: AccordEventType[];
  /** Starting paging token / cursor. */
  fromCursor?: string;
  /** Polling interval in milliseconds (default: 2000). */
  pollIntervalMs?: number;
  /** Max recent event IDs to keep in memory for deduplication (default: 1000). */
  maxDedupeHistory?: number;
}

export type EventListener = (event: AccordParsedEvent) => void;

/**
 * Manages an event subscription with cursor tracking and deduplication.
 */
export class EventSubscription {
  private _cursor: string | null = null;
  private _active = false;
  private readonly listeners: Map<string, Set<EventListener>> = new Map();
  private readonly seenEventIds: Set<string> = new Set();
  private readonly filter: EventSubscriptionFilter;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fetcher?: (cursor: string | null) => Promise<AccordParsedEvent[]>;

  constructor(filter: EventSubscriptionFilter = {}, fetcher?: (cursor: string | null) => Promise<AccordParsedEvent[]>) {
    this.filter = filter;
    this._cursor = filter.fromCursor ?? null;
    this.fetcher = fetcher;
  }

  get cursor(): string | null {
    return this._cursor;
  }

  get active(): boolean {
    return this._active;
  }

  /** Subscribe a listener for specific event types or '*' for all events. */
  on(eventType: AccordEventType | "*", listener: EventListener): this {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);
    return this;
  }

  /** Unsubscribe a listener. */
  off(eventType: AccordEventType | "*", listener: EventListener): this {
    this.listeners.get(eventType)?.delete(listener);
    return this;
  }

  /**
   * Processes an incoming batch of events, deduplicating and emitting to listeners.
   * Returns newly processed events.
   */
  processEvents(events: AccordParsedEvent[]): AccordParsedEvent[] {
    const fresh: AccordParsedEvent[] = [];
    const maxDedupe = this.filter.maxDedupeHistory ?? 1000;

    for (const ev of events) {
      if (this.seenEventIds.has(ev.id)) {
        continue;
      }

      if (this.filter.types && !this.filter.types.includes(ev.type)) {
        continue;
      }

      this.seenEventIds.add(ev.id);
      if (this.seenEventIds.size > maxDedupe) {
        const oldest = this.seenEventIds.values().next().value;
        if (oldest) this.seenEventIds.delete(oldest);
      }

      this._cursor = ev.id;
      fresh.push(ev);

      // Emit to specific listeners
      const specific = this.listeners.get(ev.type);
      if (specific) {
        for (const listener of specific) {
          try {
            listener(ev);
          } catch {
            // keep processing
          }
        }
      }

      // Emit to wildcard listeners
      const wildcard = this.listeners.get("*");
      if (wildcard) {
        for (const listener of wildcard) {
          try {
            listener(ev);
          } catch {
            // keep processing
          }
        }
      }
    }

    return fresh;
  }

  /** Start polling if a fetcher is provided. */
  start(): this {
    if (this._active) return this;
    this._active = true;
    if (this.fetcher) {
      this.schedulePoll();
    }
    return this;
  }

  /** Stop polling. */
  stop(): this {
    this._active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this;
  }

  private schedulePoll(): void {
    if (!this._active || !this.fetcher) return;
    const interval = this.filter.pollIntervalMs ?? 2000;
    this.timer = setTimeout(async () => {
      if (!this._active || !this.fetcher) return;
      try {
        const events = await this.fetcher(this._cursor);
        this.processEvents(events);
      } catch {
        // Retry on next cycle
      } finally {
        this.schedulePoll();
      }
    }, interval);
  }
}

/**
 * Creates and returns an EventSubscription instance.
 */
export function subscribeEvents(
  fetcher: (cursor: string | null) => Promise<AccordParsedEvent[]>,
  options?: EventSubscriptionFilter
): EventSubscription {
  const sub = new EventSubscription(options, fetcher);
  return sub.start();
}
