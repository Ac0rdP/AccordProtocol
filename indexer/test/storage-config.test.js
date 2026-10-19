import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { migratePostgres, loadMigrations } from "../src/store/migrations.js";
import { resolveStoreConfig } from "../src/store/index.js";
import { openPostgresStore } from "../src/store/postgres.js";
import { cleanupTempStores, postgresUrl } from "./helpers.js";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(cleanupTempStores);

describe("storage configuration", () => {
  it("keeps SQLite as the default backend", () => {
    assert.deepEqual(resolveStoreConfig({}), { backend: "sqlite", databasePath: "./data/treasury.sqlite" });
    assert.deepEqual(resolveStoreConfig({ DATABASE_PATH: "/var/lib/accord.db" }), {
      backend: "sqlite", databasePath: "/var/lib/accord.db",
    });
    // DATABASE_URL alone must not silently switch an existing deployment's store.
    assert.equal(resolveStoreConfig({ DATABASE_URL: "postgres://x/y" }).backend, "sqlite");
  });

  it("selects Postgres explicitly and validates its settings", () => {
    assert.deepEqual(resolveStoreConfig({ STORE_BACKEND: "Postgres", DATABASE_URL: "postgres://x/y" }), {
      backend: "postgres", connectionString: "postgres://x/y", poolMax: 10, migrate: true,
    });
    const config = resolveStoreConfig({
      STORE_BACKEND: "postgres", DATABASE_URL: "postgres://x/y", DATABASE_POOL_MAX: "3", DATABASE_AUTO_MIGRATE: "false",
    });
    assert.equal(config.poolMax, 3);
    assert.equal(config.migrate, false);
    assert.throws(() => resolveStoreConfig({ STORE_BACKEND: "postgres" }), /DATABASE_URL must be set/);
    assert.throws(() => resolveStoreConfig({ STORE_BACKEND: "mysql" }), /must be one of: sqlite, postgres/);
    assert.throws(
      () => resolveStoreConfig({ STORE_BACKEND: "postgres", DATABASE_URL: "postgres://x/y", DATABASE_POOL_MAX: "0" }),
      /DATABASE_POOL_MAX/
    );
  });
});

describe("postgres migrations", () => {
  it("ships ordered, uniquely numbered migrations", () => {
    const migrations = loadMigrations();
    assert.ok(migrations.length >= 2);
    assert.deepEqual(migrations.map(({ version }) => version), migrations.map((_, index) => String(index + 1).padStart(4, "0")));
  });

  const options = postgresUrl ? {} : { skip: "TEST_POSTGRES_URL is not set" };

  async function withSchema(fn) {
    const schema = `mig_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: postgresUrl, max: 2, options: `-c search_path="${schema}"` });
    try {
      return await fn(pool);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }

  it("applies pending migrations once and records them", options, async () => {
    await withSchema(async (pool) => {
      const expected = loadMigrations().map(({ name }) => name);
      assert.deepEqual(await migratePostgres(pool), expected);
      assert.deepEqual(await migratePostgres(pool), [], "re-running is a no-op");
      const { rows } = await pool.query("SELECT version, name FROM schema_migrations ORDER BY version");
      assert.deepEqual(rows.map(({ name }) => name), expected);
      const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()");
      for (const table of ["ledger_entries", "token_balances", "accord_events", "indexer_state", "reconciliation_results", "webhook_deliveries"]) {
        assert.ok(tables.rows.some((row) => row.table_name === table), `${table} exists`);
      }
    });
  });

  it("applies only what is missing when the schema is partially migrated", options, async () => {
    await withSchema(async (pool) => {
      const directory = mkdtempSync(join(tmpdir(), "accord-migrations-"));
      try {
        const [first, second] = loadMigrations();
        writeFileSync(join(directory, `${first.name}.sql`), first.sql);
        assert.deepEqual(await migratePostgres(pool, { directory: `${directory}/` }), [first.name]);
        writeFileSync(join(directory, `${second.name}.sql`), second.sql);
        assert.deepEqual(await migratePostgres(pool, { directory: `${directory}/` }), [second.name]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("refuses to run when an applied migration was edited", options, async () => {
    await withSchema(async (pool) => {
      await migratePostgres(pool);
      const directory = mkdtempSync(join(tmpdir(), "accord-migrations-"));
      try {
        for (const migration of loadMigrations()) {
          writeFileSync(join(directory, `${migration.name}.sql`), `${migration.sql}\n-- edited`);
        }
        await assert.rejects(() => migratePostgres(pool, { directory: `${directory}/` }), /was modified after it was applied/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("rolls back a failing migration and reports which one", options, async () => {
    await withSchema(async (pool) => {
      const directory = mkdtempSync(join(tmpdir(), "accord-migrations-"));
      try {
        writeFileSync(join(directory, "0001_ok.sql"), "CREATE TABLE ok_table (id INT);");
        writeFileSync(join(directory, "0002_broken.sql"), "CREATE TABLE half_done (id INT); SELECT * FROM missing_table;");
        await assert.rejects(() => migratePostgres(pool, { directory: `${directory}/` }), /0002_broken failed/);
        const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()");
        const names = tables.rows.map((row) => row.table_name);
        assert.ok(names.includes("ok_table"));
        assert.ok(!names.includes("half_done"), "the failed migration left nothing behind");
        const applied = await pool.query("SELECT name FROM schema_migrations");
        assert.deepEqual(applied.rows.map((row) => row.name), ["0001_ok"]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("can open a store without migrating, for deployments that migrate separately", options, async () => {
    const schema = `nomig_${randomUUID().replaceAll("-", "")}`;
    const store = await openPostgresStore({ connectionString: postgresUrl, schema, migrate: false });
    try {
      await assert.rejects(() => store.getBalance("USDC"), /does not exist/);
    } finally {
      await store.close();
      const admin = new pg.Client({ connectionString: postgresUrl });
      await admin.connect();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
