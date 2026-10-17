import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const POSTGRES_MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/postgres/", import.meta.url));

// Arbitrary constant: serializes concurrent migrators (two replicas starting at once).
const MIGRATION_LOCK_ID = 7_243_001;

/** Reads `NNNN_name.sql` files in version order. */
export function loadMigrations(directory = POSTGRES_MIGRATIONS_DIR) {
  return readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(`${directory}${name}`, "utf8");
      return {
        version: name.slice(0, 4),
        name: name.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

/**
 * Applies pending migrations, each in its own transaction, and records them in
 * `schema_migrations`. A migration that was already applied but has since been
 * edited is refused: schema changes must ship as a new numbered file.
 *
 * @returns {Promise<string[]>} the names of the migrations applied by this call
 */
export async function migratePostgres(pool, { directory } = {}) {
  const migrations = loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = new Map(
      (await client.query("SELECT version, checksum FROM schema_migrations")).rows.map(
        (row) => [row.version, row.checksum]
      )
    );

    const ran = [];
    for (const migration of migrations) {
      const checksum = applied.get(migration.version);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new Error(`migration ${migration.name} was modified after it was applied`);
        }
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${migration.name} failed: ${error.message}`);
      }
      ran.push(migration.name);
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
