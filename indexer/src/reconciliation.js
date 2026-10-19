import {
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

/**
 * Reads the authoritative values straight off the chain so they can be held
 * against what the indexer believes. Injected into the reconciler so tests can
 * substitute a stub that returns known-divergent values.
 */
export function createChainReader({ stellar, networkPassphrase, simulationSource }) {
  async function simulate(contractId, method, args = []) {
    const account = await stellar.getAccount(simulationSource);
    const transaction = new TransactionBuilder(account, { fee: "100", networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();

    const simulation = await stellar.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation)) {
      throw new Error(simulation.error ?? `Failed to simulate ${method} on ${contractId}`);
    }
    return scValToNative(simulation.result.retval);
  }

  return {
    async readTokenBalance(target, tokenAddress) {
      return BigInt(
        await simulate(tokenAddress, "balance", [
          nativeToScVal(target.contractId, { type: "address" }),
        ])
      );
    },
    async readTotalProposals(target) {
      return BigInt(await simulate(target.contractId, "get_total_proposals"));
    },
  };
}

/**
 * Compares a single target's on-chain values to its indexed aggregates.
 * Every check is recorded — matching or not — so `/reconciliation` always shows
 * when each value was last verified, and drift is never silently dropped.
 */
export async function reconcileTarget({ store, target, chainReader, now = () => new Date() }) {
  const scope = { network: target.network, contractId: target.contractId };
  const checkedAt = now().toISOString();
  const results = [];

  function record(result) {
    const full = { ...scope, checkedAt, ...result };
    store.recordReconciliation(full);
    results.push(full);
    return full;
  }

  for (const { name, address } of target.tokens) {
    const implied = BigInt(store.getBalance({ ...scope, token: name }));
    try {
      const actual = await chainReader.readTokenBalance(target, address);
      const drift = actual - implied;
      record({
        check: "token_balance",
        subject: name,
        subjectAddress: address,
        impliedBalance: implied.toString(),
        actualBalance: actual.toString(),
        drift: drift.toString(),
        status: drift === 0n ? "ok" : "drift",
        details: { unit: "stroops" },
      });
    } catch (error) {
      record({
        check: "token_balance",
        subject: name,
        subjectAddress: address,
        impliedBalance: implied.toString(),
        actualBalance: "unknown",
        drift: "unknown",
        status: "error",
        details: { error: String(error.message ?? error) },
      });
    }
  }

  const impliedProposals = BigInt(store.countAccordEvents({ ...scope, topic: "created" }));
  try {
    const actualProposals = await chainReader.readTotalProposals(target);
    const drift = actualProposals - impliedProposals;
    record({
      check: "total_proposals",
      subject: "proposals",
      subjectAddress: target.contractId,
      impliedBalance: impliedProposals.toString(),
      actualBalance: actualProposals.toString(),
      drift: drift.toString(),
      status: drift === 0n ? "ok" : "drift",
      details: { source: "created events vs get_total_proposals" },
    });
  } catch (error) {
    record({
      check: "total_proposals",
      subject: "proposals",
      subjectAddress: target.contractId,
      impliedBalance: impliedProposals.toString(),
      actualBalance: "unknown",
      drift: "unknown",
      status: "error",
      details: { error: String(error.message ?? error) },
    });
  }

  store.setState(scope, "last_reconciled_at", checkedAt);
  return results;
}

/**
 * Posts drift to an optional webhook and always logs it. Delivery is retried
 * with linear backoff; a webhook that stays down is logged rather than thrown,
 * so a broken alert sink never stops reconciliation.
 */
export function createAlerter({
  webhookUrl,
  attempts = 3,
  backoffMs = 500,
  fetchImpl = globalThis.fetch,
  logger = console,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  const delivered = [];
  return {
    delivered,
    async alert(payload) {
      const line =
        `[reconciliation] ${payload.network}/${payload.contractId} ${payload.check}:${payload.subject} ` +
        `status=${payload.status} implied=${payload.impliedBalance} actual=${payload.actualBalance} drift=${payload.drift}`;
      logger.error(line);
      delivered.push(payload);
      if (!webhookUrl || !fetchImpl) return { delivered: false, reason: "no webhook configured" };

      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await fetchImpl(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: line, ...payload }),
          });
          if (!response.ok) throw new Error(`webhook responded ${response.status}`);
          return { delivered: true, attempts: attempt };
        } catch (error) {
          lastError = error;
          if (attempt < attempts) await sleep(backoffMs * attempt);
        }
      }
      logger.error(`[reconciliation] alert webhook failed after ${attempts} attempts: ${lastError?.message}`);
      return { delivered: false, reason: String(lastError?.message ?? lastError) };
    },
  };
}

export async function runReconciliation({ store, targets, chainReader, alerter, now }) {
  const all = [];
  for (const target of targets) {
    const results = await reconcileTarget({ store, target, chainReader, now });
    all.push(...results);
    if (alerter) {
      for (const result of results.filter((entry) => entry.status !== "ok")) {
        await alerter.alert(result);
      }
    }
  }
  return all;
}

function metricLines(name, help, type, samples) {
  if (samples.length === 0) return [];
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples];
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Renders the indexer's reconciliation and checkpoint state as Prometheus text. */
export function renderMetrics(store, targets = []) {
  const lines = [];
  const latest = store.getLatestReconciliations();

  lines.push(
    ...metricLines(
      "accord_reconciliation_drift",
      "Difference between the on-chain value and the indexed value (actual - implied).",
      "gauge",
      latest
        .filter((row) => row.drift !== "unknown")
        .map(
          (row) =>
            `accord_reconciliation_drift{network="${escapeLabel(row.network)}",contract_id="${escapeLabel(row.contractId)}",check="${escapeLabel(row.check)}",subject="${escapeLabel(row.subject)}"} ${row.drift}`
        )
    )
  );

  lines.push(
    ...metricLines(
      "accord_reconciliation_status",
      "1 when the last reconciliation of this value matched the chain, 0 otherwise.",
      "gauge",
      latest.map(
        (row) =>
          `accord_reconciliation_status{network="${escapeLabel(row.network)}",contract_id="${escapeLabel(row.contractId)}",check="${escapeLabel(row.check)}",subject="${escapeLabel(row.subject)}"} ${row.status === "ok" ? 1 : 0}`
      )
    )
  );

  lines.push(
    ...metricLines(
      "accord_reconciliation_last_run_seconds",
      "Unix time of the last reconciliation of this value.",
      "gauge",
      latest.map(
        (row) =>
          `accord_reconciliation_last_run_seconds{network="${escapeLabel(row.network)}",contract_id="${escapeLabel(row.contractId)}",check="${escapeLabel(row.check)}",subject="${escapeLabel(row.subject)}"} ${Math.floor(new Date(row.checkedAt).getTime() / 1000)}`
      )
    )
  );

  const checkpoints = targets.map((target) => {
    const value = store.getState({ network: target.network, contractId: target.contractId }, "next_ledger");
    return `accord_indexer_next_ledger{network="${escapeLabel(target.network)}",contract_id="${escapeLabel(target.contractId)}"} ${Number(value ?? target.startLedger)}`;
  });
  lines.push(
    ...metricLines(
      "accord_indexer_next_ledger",
      "Next ledger each (network, contract) target will resume indexing from.",
      "gauge",
      checkpoints
    )
  );

  return `${lines.join("\n")}\n`;
}
