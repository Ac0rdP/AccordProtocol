import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBigQueryConnector,
  createSnowflakeConnector,
  createWarehouseExportManager,
  WAREHOUSE_TABLE_SCHEMAS,
} from "../src/warehouse-connectors.js";
import { resolveWarehouseConfig } from "../src/config.js";
import { openLedgerStore } from "../src/store/sqlite.js";

describe("Warehouse connectors configuration", () => {
  it("resolves default configuration with connectors disabled", () => {
    const config = resolveWarehouseConfig({});
    assert.equal(config.bigquery.enabled, false);
    assert.equal(config.bigquery.dataset, "accord_analytics");
    assert.equal(config.snowflake.enabled, false);
    assert.equal(config.snowflake.database, "ACCORD_DB");
  });

  it("applies environment overrides for BigQuery and Snowflake", () => {
    const config = resolveWarehouseConfig({
      BIGQUERY_EXPORT_ENABLED: "true",
      BIGQUERY_PROJECT_ID: "my-gcp-project",
      BIGQUERY_DATASET: "analytics_prod",
      SNOWFLAKE_EXPORT_ENABLED: "true",
      SNOWFLAKE_ACCOUNT: "xy12345",
      SNOWFLAKE_DATABASE: "PROD_ACCORD",
    });
    assert.equal(config.bigquery.enabled, true);
    assert.equal(config.bigquery.projectId, "my-gcp-project");
    assert.equal(config.bigquery.dataset, "analytics_prod");
    assert.equal(config.snowflake.enabled, true);
    assert.equal(config.snowflake.account, "xy12345");
    assert.equal(config.snowflake.database, "PROD_ACCORD");
  });
});

describe("Table schemas", () => {
  it("defines schema definitions for ledger_entries and accord_events", () => {
    assert.ok(WAREHOUSE_TABLE_SCHEMAS.ledger_entries);
    assert.ok(WAREHOUSE_TABLE_SCHEMAS.accord_events);
    assert.equal(WAREHOUSE_TABLE_SCHEMAS.ledger_entries.version, 1);
    const colNames = WAREHOUSE_TABLE_SCHEMAS.ledger_entries.columns.map((c) => c.name);
    assert.ok(colNames.includes("event_id"));
    assert.ok(colNames.includes("amount"));
  });
});

describe("BigQuery connector", () => {
  it("exports batch of rows and deduplicates replayed rows", async () => {
    const inserted = [];
    const mockClient = {
      connect: async () => {},
      insert: async (table, rows) => {
        inserted.push({ table, rows });
      },
      close: async () => {},
    };

    const connector = createBigQueryConnector({
      projectId: "test-proj",
      clientImpl: mockClient,
    });

    await connector.connect();
    assert.equal(connector.isConnected(), true);

    const rows = [
      { id: 1, event_id: "ev1", token: "XLM", amount: "100" },
      { id: 2, event_id: "ev2", token: "USDC", amount: "200" },
    ];

    const count = await connector.exportBatch("ledger_entries", rows);
    assert.equal(count, 2);
    assert.equal(connector.getExportedCount("ledger_entries"), 2);
    assert.equal(inserted.length, 1);

    // Replay / duplicate export: rows with same id are skipped
    const dupCount = await connector.exportBatch("ledger_entries", rows);
    assert.equal(dupCount, 0);
    assert.equal(connector.getExportedCount("ledger_entries"), 2);

    await connector.close();
    assert.equal(connector.isConnected(), false);
  });
});

describe("Snowflake connector", () => {
  it("exports rows to snowflake staging and prevents duplicates", async () => {
    const copied = [];
    const mockClient = {
      connect: async () => {},
      copyInto: async (table, rows) => {
        copied.push({ table, rows });
      },
      close: async () => {},
    };

    const connector = createSnowflakeConnector({
      account: "test-acct",
      clientImpl: mockClient,
    });

    await connector.connect();
    assert.equal(connector.isConnected(), true);

    const rows = [{ id: 10, event_id: "ev10", topic: "created", ledger: 100 }];
    const count = await connector.exportBatch("accord_events", rows);
    assert.equal(count, 1);
    assert.equal(copied.length, 1);

    // Idempotent duplicate check
    const dupCount = await connector.exportBatch("accord_events", rows);
    assert.equal(dupCount, 0);

    await connector.close();
  });
});

describe("WarehouseExportManager", () => {
  it("syncs table data and updates warehouse checkpoints in store", async () => {
    const store = openLedgerStore(":memory:");
    const bqInserted = [];

    const manager = createWarehouseExportManager({
      store,
      config: {
        bigquery: { enabled: true, projectId: "test", dataset: "ds" },
      },
      bigqueryImpl: {
        connect: async () => {},
        insert: async (table, rows) => bqInserted.push({ table, rows }),
        close: async () => {},
      },
    });

    await manager.start();

    const testRows = [
      { id: 100, event_id: "ev100", token: "XLM", amount: "500", ledger: 1234 },
    ];

    const synced = await manager.syncTable("ledger_entries", testRows);
    assert.equal(synced, 1);
    assert.equal(bqInserted.length, 1);

    // Checkpoint recorded in store
    const cp = await store.getWarehouseCheckpoint("bigquery", "ledger_entries");
    assert.ok(cp);
    assert.equal(cp.lastExportedId, 100);
    assert.equal(cp.lastLedger, 1234);
    assert.equal(cp.rowsExported, 1);

    await manager.close();
    await store.close();
  });
});
