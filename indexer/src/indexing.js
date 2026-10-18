import { parseAccordEvent, parseTokenTransferEvent } from "./events.js";
import { DEFAULT_FINALITY_LAG, detectReorg, finalLedgerFor } from "./finality.js";

/** Builds the contract filter covering both the token contracts and the treasury. */
export function buildContractFilters({ tokens, treasuryAddress }) {
  const contractIds = [...new Set([
    ...tokens.map(({ address }) => address),
    ...(treasuryAddress ? [treasuryAddress] : []),
  ])];
  return [{ type: "contract", contractIds }];
}

/**
 * Ingests one batch of contract events, up to `maxPages` of RPC pagination.
 *
 * Events are only ingested once their ledger is final (see `finality.js`); the
 * batch stops at the last final ledger and leaves a checkpoint that the held
 * back ledgers can be re-fetched from, so nothing is dropped. A rollback (chain
 * head moving backwards) rewinds the store to the new final ledger before the
 * walk restarts.
 *
 * @returns {Promise<{pages: number, latestLedger: number, finalLedger: number,
 *   indexed: number, heldBack: number, reorg: object|null}>}
 */
export async function indexEventBatch({
  stellar,
  store,
  tokens,
  treasuryAddress,
  startLedger,
  pageLimit = 1000,
  maxPages = 100,
  finalityLag = DEFAULT_FINALITY_LAG,
}) {
  const tokenNames = new Map(tokens.map(({ name, address }) => [address.toLowerCase(), name]));
  const filters = buildContractFilters({ tokens, treasuryAddress });
  let cursor = await store.getState("event_cursor");
  let nextLedger = Number(await store.getState("next_ledger") ?? startLedger);
  // Checkpoint the batch started from, so the live checkpoint never walks
  // backwards on its own (only a reorg is allowed to do that).
  let startingLedger = nextLedger;
  let previousLatest = Number(await store.getState("last_seen_ledger") ?? 0);
  let latestSeen = previousLatest;
  let pages = 0;
  let indexed = 0;
  let heldBack = 0;
  let reorg = null;
  let firstHeldBackLedger = Number.POSITIVE_INFINITY;
  let reorgChecked = false;

  while (pages < maxPages) {
    const response = await stellar.getEvents({
      ...(cursor ? { cursor } : { startLedger: nextLedger }),
      filters,
      limit: pageLimit,
    });

    const observedLatest = Number(response.latestLedger ?? latestSeen);
    if (Number.isSafeInteger(observedLatest) && observedLatest > latestSeen) {
      latestSeen = observedLatest;
    }

    // The head moving backwards means we are reading from a different chain
    // view than the one the indexed tail was built from. Rewind to the new
    // final ledger and restart the walk from there.
    if (!reorgChecked) {
      reorgChecked = true;
      const detected = detectReorg({
        previousLatestLedger: previousLatest,
        latestLedger: observedLatest,
        finalityLag,
      });
      if (detected) {
        reorg = detected;
        previousLatest = detected.toLedger;
        // The chain view changed, so the head we had recorded is meaningless.
        latestSeen = detected.toLedger;
        const removed = await store.rewindToLedger(detected.rewindTo);
        nextLedger = detected.rewindTo + 1;
        startingLedger = nextLedger;
        cursor = null;
        await store.setState("event_cursor", "");
        firstHeldBackLedger = Number.POSITIVE_INFINITY;
        reorg.removedEntries = removed.removedEntries;
        reorg.removedEvents = removed.removedEvents;
        continue;
      }
      previousLatest = observedLatest;
    }

    const finalLedger = finalLedgerFor(latestSeen, finalityLag);

    for (const event of response.events) {
      const eventLedger = Number(event.ledger);
      if (eventLedger > finalLedger) {
        heldBack += 1;
        if (eventLedger < firstHeldBackLedger) firstHeldBackLedger = eventLedger;
        continue;
      }

      const transferEntry = parseTokenTransferEvent(event, tokenNames, treasuryAddress);
      if (transferEntry && (await store.recordTransfer(transferEntry))) indexed += 1;

      const accordEntry = parseAccordEvent(event, treasuryAddress);
      if (accordEntry && (await store.recordAccordEvent(accordEntry))) indexed += 1;
    }

    if (response.events.length === pageLimit) {
      if (!response.cursor || response.cursor === cursor) {
        throw new Error("RPC event pagination did not advance its cursor");
      }
      cursor = response.cursor;
      await store.setState("event_cursor", cursor);
      pages += 1;
      continue;
    }

    // Reached the tip of the chain view. Hold the checkpoint at the first
    // non-final ledger we actually saw (so those ledgers are re-fetched), or at
    // the next ledger after the final one when nothing was held back.
    const checkpoint = Number.isFinite(firstHeldBackLedger)
      ? Math.max(startingLedger, firstHeldBackLedger)
      : Math.max(startingLedger, finalLedger + 1);
    await store.setState("next_ledger", checkpoint);
    await store.setState("event_cursor", "");
    break;
  }

  if (latestSeen > 0) await store.setState("last_seen_ledger", latestSeen);

  return {
    pages,
    latestLedger: latestSeen,
    finalLedger: finalLedgerFor(latestSeen, finalityLag),
    indexed,
    heldBack,
    reorg,
  };
}
