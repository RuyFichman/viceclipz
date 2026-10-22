import { db, one, run } from "./db.mjs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { ORIGIN } from "./config.mjs";
db.exec(`
CREATE TABLE IF NOT EXISTS social_connections(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),provider TEXT NOT NULL,remote_id TEXT NOT NULL,label TEXT NOT NULL,secret TEXT NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'connected',updated INTEGER NOT NULL,UNIQUE(user_id,provider));
CREATE TABLE IF NOT EXISTS oauth_states(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),provider TEXT NOT NULL,nonce_hash TEXT NOT NULL,verifier TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scheduled_posts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),job_id TEXT NOT NULL REFERENCES jobs(id),connection_id TEXT NOT NULL REFERENCES social_connections(id),request_key TEXT NOT NULL,due INTEGER NOT NULL,timezone TEXT NOT NULL,title TEXT NOT NULL,caption TEXT NOT NULL,privacy TEXT NOT NULL,made_for_kids INTEGER NOT NULL,status TEXT NOT NULL,checkpoint TEXT,remote_id TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_run INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(user_id,request_key));
CREATE INDEX IF NOT EXISTS posts_due ON scheduled_posts(status,next_run);
CREATE TABLE IF NOT EXISTS billing_customers(user_id TEXT PRIMARY KEY REFERENCES users(id),customer_id TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),customer_id TEXT NOT NULL,price_id TEXT NOT NULL,status TEXT NOT NULL,period_end INTEGER NOT NULL,cancel_at_end INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS billing_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_run INTEGER NOT NULL,error TEXT,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS checkout_requests(user_id TEXT PRIMARY KEY REFERENCES users(id),price_id TEXT NOT NULL,request_id TEXT NOT NULL,url TEXT,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage_events(job_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),period TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS account_tokens(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS verified_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id),verified INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS service_heartbeats(name TEXT PRIMARY KEY,updated INTEGER NOT NULL);
`);
export const billingRequired = () => process.env.BILLING_REQUIRED === "true";
export const plans = () => ({
  free: { name: "Grátis", renders: 10, storage: 2 * 1024 ** 3, social: false },
  creator: {
    name: "Creator",
    renders: 100,
    storage: 2 * 1024 ** 3,
    social: true,
    price: process.env.STRIPE_CREATOR_PRICE_ID,
  },
  studio: {
    name: "Studio",
    renders: 500,
    storage: 10 * 1024 ** 3,
    social: true,
    price: process.env.STRIPE_STUDIO_PRICE_ID,
  },
});
export function planFor(userId) {
  if (!billingRequired())
    return {
      key: "local",
      name: "Desenvolvimento local",
      renders: 100000,
      storage: 2 * 1024 ** 3,
      social: true,
    };
  const sub = one(
    "SELECT * FROM subscriptions WHERE user_id=? AND status IN ('active','trialing') AND period_end>? ORDER BY period_end DESC LIMIT 1",
    userId,
    Date.now(),
  );
  const list = plans();
  const key = sub
    ? Object.keys(list).find((k) => list[k].price === sub.price_id)
    : "free";
  return { key: key || "free", ...list[key || "free"] };
}
export const month = () => new Date().toISOString().slice(0, 7);
export function renderUsage(userId) {
  return Number(
    one(
      "SELECT count(*) AS n FROM usage_events WHERE user_id=? AND period=? AND state IN ('reserved','completed')",
      userId,
      month(),
    ).n,
  );
}
export function canRender(userId) {
  return renderUsage(userId) < planFor(userId).renders;
}
export function reserveRender(jobId, userId) {
  run(
    "INSERT INTO usage_events VALUES(?,?,?,'reserved',?) ON CONFLICT(job_id) DO UPDATE SET state='reserved',period=excluded.period",
    jobId,
    userId,
    month(),
    Date.now(),
  );
}
export function releaseRender(jobId) {
  run(
    "UPDATE usage_events SET state='released' WHERE job_id=? AND state='reserved'",
    jobId,
  );
}
export function secretReady() {
  return /^[a-fA-F0-9]{64}$/.test(process.env.TOKEN_ENCRYPTION_KEY || "");
}
function key() {
  if (!secretReady())
    throw new Error(
      "Configure TOKEN_ENCRYPTION_KEY com 32 bytes em hexadecimal.",
    );
  return Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "hex");
}
export function seal(value) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
export function unseal(value) {
  const data = Buffer.from(value, "base64url"),
    decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString(),
  );
}
export function mediaSignature(postId, expires) {
  return createHmac("sha256", key())
    .update(`media:${postId}:${expires}`)
    .digest("hex");
}
export function mediaLink(postId) {
  const expires = Date.now() + 3600000;
  return `${ORIGIN}/api/social/media/${postId}?expires=${expires}&signature=${mediaSignature(postId, expires)}`;
}
export function validMediaSignature(postId, expires, signature) {
  if (
    !secretReady() ||
    !Number.isSafeInteger(expires) ||
    expires < Date.now() ||
    expires > Date.now() + 3600000 ||
    !/^[a-f0-9]{64}$/.test(signature || "")
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(mediaSignature(postId, expires), "hex"),
  );
}
