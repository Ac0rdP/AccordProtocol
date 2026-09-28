import { parseTokenTransferEvent } from "./events.js";

export async function indexEventBatch({
  stellar,
  store,
  tokens,
  treasuryAddress,
  startLedger,
  pageLimit = 1000,
  maxPages = 100,
}) {
  const tokenNames = new Map(tokens.map(({ name, address }) => [address.toLowerCase(), name]));
  let cursor = store.getState("event_cursor");
  let nextLedger = Number(store.getState("next_ledger") ?? startLedger);
  let pages = 0;

  while (pages < maxPages) {
    const response = await stellar.getEvents({
      ...(cursor ? { cursor } : { startLedger: nextLedger }),
      filters: [{ type: "contract", contractIds: tokens.map(({ address }) => address) }],
      limit: pageLimit,
    });

    for (const event of response.events) {
      const entry = parseTokenTransferEvent(event, tokenNames, treasuryAddress);
      if (entry) store.recordTransfer(entry);
    }

    if (response.events.length === pageLimit) {
      if (!response.cursor || response.cursor === cursor) {
        throw new Error("RPC event pagination did not advance its cursor");
      }
      cursor = response.cursor;
      store.setState("event_cursor", cursor);
      pages += 1;
      continue;
    }

    store.setState("next_ledger", Number(response.latestLedger) + 1);
    store.setState("event_cursor", "");
    break;
  }
}
