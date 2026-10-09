// Connection to PostgreSQL, and applying database changes ("migrations").
//
// Each file in migrations/ is applied once, in name order, the first time a
// website container starts after it was added. The list of applied files is
// kept in the schema_migrations table.
//
// On AWS, the flight deals site has its own database ("flights") on ticket-hub's
// database server. The first time the website starts it creates that
// database, connecting to ticket-hub's own database to do so.

const fs = require("fs");
const path = require("path");
const { Pool, Client, types } = require("pg");

// Keep dates as "2026-10-03" text: they're whole days, not moments in time.
types.setTypeParser(1082, (value) => value);

const migrationsDir = path.join(__dirname, "..", "migrations");

function connectionSettings(env, database) {
  // On AWS the database only accepts encrypted connections. The Dockerfile
  // bundles Amazon's certificate so we can check we're talking to the real one.
  const ssl =
    env.DB_SSL === "off"
      ? false
      : { ca: fs.readFileSync(env.DB_CA_FILE || path.join(__dirname, "..", "rds-ca.pem"), "utf8") };
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl,
  };
}

/** Creates the flight-deals database if it isn't there yet (AWS only). */
async function ensureDatabase(env = process.env, { log = console.log } = {}) {
  if (env.DATABASE_URL || !env.DB_ADMIN_DATABASE) return;
  const name = env.DB_NAME;
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name || "")) throw new Error(`bad database name ${name}`);
  const client = new Client(connectionSettings(env, env.DB_ADMIN_DATABASE));
  await client.connect();
  try {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (!rowCount) {
      await client.query(`create database ${name}`);
      log(`created database ${name}`);
    }
  } catch (err) {
    // Two containers starting together can both try; the second one loses.
    if (err.code !== "42P04") throw err;
  } finally {
    await client.end();
  }
}

function poolFromEnv(env = process.env) {
  if (env.DATABASE_URL) {
    return new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  }
  return new Pool({ ...connectionSettings(env, env.DB_NAME), max: 5 });
}

async function migrate(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    // Only one container migrates at a time (during a deploy, old and new
    // containers can start together).
    await client.query("select pg_advisory_lock(3547891)");
    await client.query(`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
    const done = new Set(
      (await client.query("select name from schema_migrations")).rows.map((r) => r.name),
    );
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        log(`applied database change ${file}`);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`database change ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(3547891)").catch(() => {});
    client.release();
  }
}

module.exports = { poolFromEnv, migrate, ensureDatabase };
