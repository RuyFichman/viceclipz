import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA } from "./config.mjs";
for (const dir of ["", "assets", "exports", "temp"])
  mkdirSync(path.join(DATA, dir), { recursive: true });
export const db = new DatabaseSync(path.join(DATA, "viceclipz.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,size INTEGER NOT NULL,duration REAL NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,has_audio INTEGER NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL,state TEXT NOT NULL,progress INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,size INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(user_id,created);
CREATE INDEX IF NOT EXISTS projects_owner ON projects(user_id);
CREATE INDEX IF NOT EXISTS assets_owner ON assets(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),request_key TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,total INTEGER NOT NULL,created INTEGER NOT NULL,UNIQUE(user_id,request_key));
CREATE INDEX IF NOT EXISTS batches_owner ON batches(user_id,project_id,created);
CREATE TABLE IF NOT EXISTS saved_profiles(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,data TEXT NOT NULL,updated INTEGER NOT NULL,UNIQUE(user_id,name));
CREATE TABLE IF NOT EXISTS saved_styles(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,data TEXT NOT NULL,updated INTEGER NOT NULL,UNIQUE(user_id,name));
CREATE TABLE IF NOT EXISTS ai_requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),period TEXT NOT NULL,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ai_requests_owner ON ai_requests(user_id,period);
CREATE TABLE IF NOT EXISTS asset_kinds(asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,kind TEXT NOT NULL,mime TEXT);`);
// Additive, repeatable upgrades for databases created by earlier versions.
// Table and column names come from this fixed list, never from requests.
// `assets` keeps its original columns: the previous release inserts into it
// positionally, so a rollback keeps uploading. Media kind lives in asset_kinds.
function addColumn(table, column, definition) {
  if (
    !db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column)
  )
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn("jobs", "batch_id", "TEXT REFERENCES batches(id)");
addColumn("jobs", "item_index", "INTEGER");
addColumn("jobs", "reserve", "INTEGER");
addColumn("jobs", "started", "INTEGER");
addColumn("jobs", "crc", "INTEGER");
db.exec(`CREATE INDEX IF NOT EXISTS jobs_batch ON jobs(batch_id,item_index);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state,created);
PRAGMA user_version=2;`);
// Assets without an asset_kinds row are videos (every asset before images existed).
export const ASSET_SELECT =
  "SELECT a.*,coalesce(k.kind,'video') AS kind,k.mime FROM assets a LEFT JOIN asset_kinds k ON k.asset_id=a.id";
export const run = (sql, ...args) => db.prepare(sql).run(...args);
export const one = (sql, ...args) => db.prepare(sql).get(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function usage(userId) {
  return (
    Number(
      one(
        "SELECT coalesce(sum(size),0) AS n FROM assets WHERE user_id=?",
        userId,
      ).n,
    ) +
    Number(
      one(
        "SELECT coalesce(sum(size),0) AS n FROM jobs WHERE user_id=? AND state=?",
        userId,
        "done",
      ).n,
    )
  );
}
