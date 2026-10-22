import {
  randomBytes,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { one, run } from "./db.mjs";
import { ORIGIN } from "./config.mjs";
const scrypt = promisify(scryptCallback);
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export async function passwordHash(value) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + (await scrypt(value, salt, 64)).toString("hex");
}
export async function passwordMatches(value, stored) {
  const [salt, hash] = stored.split(":");
  const actual = await scrypt(value, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}
const cookieName = "viceclipz_session";
export function cookieToken(req) {
  return (
    (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1) || ""
  );
}
export function getUser(req) {
  const token = cookieToken(req);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return (
    one(
      "SELECT u.id,u.email,u.name FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?",
      digest(token),
      Date.now(),
    ) || null
  );
}
function cookie(value, maxAge) {
  return `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${ORIGIN.startsWith("https:") ? "; Secure" : ""}`;
}
export function createSession(res, userId) {
  const token = randomBytes(32).toString("hex");
  run("DELETE FROM sessions WHERE expires<?", Date.now());
  run(
    "INSERT INTO sessions VALUES(?,?,?)",
    digest(token),
    userId,
    Date.now() + 7 * 86400000,
  );
  res.setHeader("Set-Cookie", cookie(token, 7 * 86400));
}
export function logout(req, res) {
  run("DELETE FROM sessions WHERE token=?", digest(cookieToken(req)));
  res.setHeader("Set-Cookie", cookie("", 0));
}
const attempts = new Map();
export function authAllowed(key) {
  const now = Date.now();
  if (attempts.size > 10000)
    for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  let bucket = attempts.get(key);
  if (!bucket || bucket.until < now) {
    bucket = { count: 0, until: now + 15 * 60000 };
    attempts.set(key, bucket);
  }
  return ++bucket.count <= 25;
}
