import { parseAccordEvent, parseTokenTransferEvent } from "./events.js";

/**
 * Pulls every event available for one (network, contract) target and writes it
 * to the store tagged with that target. Pagination state is checkpointed under
 * the same target, so targets advance independently of one another.
 */
export async function indexEventBatch({ stellar, store, target, pageLimit = 1000, maxPages = 100 }) {
  const scope = { network: target.network, contractId: target.contractId };
  const tokenNames = new Map(
    target.tokens.map(({ name, address }) => [address.toLowerCase(), name])
  );
  const contractIds = [target.contractId, ...target.tokens.map(({ address }) => address)];

  let cursor = store.getState(scope, "event_cursor");
  let nextLedger = Number(store.getState(scope, "next_ledger") ?? target.startLedger);
  let pages = 0;
  let transfers = 0;
  let events = 0;

  while (pages < maxPages) {
    const response = await stellar.getEvents({
      ...(cursor ? { cursor } : { startLedger: nextLedger }),
      filters: [{ type: "contract", contractIds }],
      limit: pageLimit,
    });

    for (const event of response.events) {
      const transferEntry = parseTokenTransferEvent(event, tokenNames, target.contractId, target);
      if (transferEntry && store.recordTransfer(transferEntry)) transfers += 1;

      const accordEntry = parseAccordEvent(event, target.contractId, target);
      if (accordEntry && store.recordAccordEvent(accordEntry)) events += 1;
    }

    if (response.events.length === pageLimit) {
      if (!response.cursor || response.cursor === cursor) {
        throw new Error("RPC event pagination did not advance its cursor");
      }
      cursor = response.cursor;
      store.setState(scope, "event_cursor", cursor);
      pages += 1;
      continue;
    }

    store.setState(scope, "next_ledger", Number(response.latestLedger) + 1);
    store.setState(scope, "event_cursor", "");
    break;
  }

  store.setState(scope, "last_indexed_at", new Date().toISOString());
  return { target: target.key, transfers, events, pages: pages + 1 };
}
