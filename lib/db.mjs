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
PRAGMA user_version=1;`);
export const run = (sql, ...args) => db.prepare(sql).run(...args);
export const one = (sql, ...args) => db.prepare(sql).get(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
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
