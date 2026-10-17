import pg from "pg";
import { migratePostgres } from "./store/migrations.js";
import { resolveStoreConfig } from "./store/index.js";

// Applies pending Postgres migrations and exits, so deployments can run schema
// changes as a separate step (init container, release job) before the indexer starts.
const config = resolveStoreConfig();
if (config.backend !== "postgres") {
  console.log("STORE_BACKEND is sqlite: its schema is created when the store opens; nothing to migrate.");
} else {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 1 });
  try {
    const applied = await migratePostgres(pool);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
