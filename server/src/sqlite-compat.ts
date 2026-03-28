/**
 * SQLite compatibility layer — abstracts over better-sqlite3 (Node.js)
 * and bun:sqlite (Bun runtime).
 *
 * Both APIs are nearly identical. The only differences:
 * - Import path: "better-sqlite3" vs "bun:sqlite"
 * - better-sqlite3 has `db.pragma()`, bun:sqlite does not
 *
 * This module detects the runtime and provides a unified `openDatabase()`
 * that returns a standard Database handle usable with .exec(), .prepare(),
 * .transaction(), and .close().
 */

import { createRequire } from "node:module";

const cjsRequire = createRequire(import.meta.url);

/** Minimal Database interface covering the API surface we actually use. */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

/**
 * Open a SQLite database file using the best available driver.
 *
 * Under Bun: uses bun:sqlite (built-in, no native addon needed).
 * Under Node.js: uses better-sqlite3 (native addon).
 */
export function openDatabase(path: string): SqliteDatabase {
  if (isBun) {
    return openBunDatabase(path);
  }
  return openBetterSqlite3Database(path);
}

// ---------------------------------------------------------------------------
// Bun runtime
// ---------------------------------------------------------------------------

function openBunDatabase(path: string): SqliteDatabase {
  // bun:sqlite is a Bun built-in — always available under Bun.
  // Use cjsRequire because this file is ESM and dynamic import() is async.
  const { Database } = cjsRequire("bun:sqlite") as {
    Database: new (path: string) => BunSqliteDb;
  };
  const db = new Database(path);

  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql) as SqliteStatement,
    transaction: <T>(fn: () => T) => db.transaction(fn) as () => T,
    close: () => db.close(),
  };
}

/** Minimal bun:sqlite Database shape. */
interface BunSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

// ---------------------------------------------------------------------------
// Node.js runtime
// ---------------------------------------------------------------------------

function openBetterSqlite3Database(path: string): SqliteDatabase {
  // better-sqlite3 is only needed under Node.js.
  const BetterSqlite3 = cjsRequire("better-sqlite3") as new (path: string) => BetterSqlite3Db;
  const db = new BetterSqlite3(path);

  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql) as SqliteStatement,
    transaction: <T>(fn: () => T) => db.transaction(fn) as () => T,
    close: () => db.close(),
  };
}

/** Minimal better-sqlite3 Database shape. */
interface BetterSqlite3Db {
  exec(sql: string): this;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}
