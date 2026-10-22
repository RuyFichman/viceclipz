import { randomBytes, randomUUID } from "node:crypto";
import { db, one, run } from "./db.mjs";
import { digest, passwordHash, logout } from "./auth.mjs";
import { seal, unseal, secretReady } from "./launch-store.mjs";
import { ORIGIN } from "./config.mjs";
import { InputError } from "./composition.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS account_mail(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),payload TEXT,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_run INTEGER NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS account_mail_due ON account_mail(state,next_run);
CREATE TABLE IF NOT EXISTS account_rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS account_tokens_owner ON account_tokens(user_id,kind);
`);
export const mailReady = () =>
  Boolean(
    process.env.RESEND_API_KEY && process.env.EMAIL_FROM && secretReady(),
  );
export const verificationRequired = () =>
  process.env.NODE_ENV === "production" ||
  process.env.EMAIL_VERIFICATION_REQUIRED === "true" ||
  mailReady();
export const isVerified = (id) =>
  Boolean(one("SELECT user_id FROM verified_accounts WHERE user_id=?", id));
export const accountStatus = (id) => ({
  verified: isVerified(id),
  required: verificationRequired(),
  emailConfigured: mailReady(),
});
export const genericResetMessage =
  "Se houver uma conta para este e-mail, enviaremos as instruções de recuperação. Confira também o spam.";
export function normalizeEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new InputError("Informe um e-mail válido.");
  return email;
}
export function requireMail() {
  if (!mailReady())
    throw new InputError(
      "O envio de e-mails ainda não está configurado. Tente novamente mais tarde.",
      503,
    );
}
// Hashed keys keep addresses and IPs out of the persistent throttle table.
export function accountLimit(key, limit, windowMs) {
  const now = Date.now(),
    hashed = digest(key);
  run("DELETE FROM account_rate_limits WHERE until<=?", now);
  run(
    "INSERT INTO account_rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
    hashed,
    now + windowMs,
  );
  return (
    one("SELECT count FROM account_rate_limits WHERE key=?", hashed).count <=
    limit
  );
}
function transaction(fn) {
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
export function queueAccountEmail(user, kind) {
  requireMail();
  if (!["verify", "reset"].includes(kind))
    throw Error("Unsupported account token kind.");
  const now = Date.now(),
    token = randomBytes(32).toString("hex"),
    hash = digest(token),
    expires = now + (kind === "verify" ? 86400000 : 1800000);
  const link =
    ORIGIN +
    "/#" +
    (kind === "verify" ? "verify-email" : "reset-password") +
    "?token=" +
    token;
  const payload = {
    from: process.env.EMAIL_FROM,
    to: [user.email],
    subject:
      kind === "verify"
        ? "Confirme seu e-mail no ViceClipz"
        : "Redefina sua senha no ViceClipz",
    text:
      kind === "verify"
        ? `Confirme seu e-mail para acessar o ViceClipz:\n\n${link}\n\nO link expira em 24 horas e funciona uma única vez. A confirmação encerrará as sessões existentes. Se você não criou esta conta, ignore a mensagem. Não compartilhe este link.`
        : `Foi solicitada a recuperação de senha da sua conta ViceClipz:\n\n${link}\n\nO link expira em 30 minutos e funciona uma única vez. Se você não solicitou a recuperação, ignore esta mensagem: sua senha continua igual. Não compartilhe este link.`,
  };
  transaction(() => {
    run("DELETE FROM account_tokens WHERE user_id=? AND kind=?", user.id, kind);
    run(
      "UPDATE account_mail SET state='cancelled',payload=NULL WHERE user_id=? AND token_hash NOT IN (SELECT hash FROM account_tokens) AND state IN ('pending','sending')",
      user.id,
    );
    run(
      "INSERT INTO account_tokens VALUES(?,?,?,?)",
      hash,
      user.id,
      kind,
      expires,
    );
    run(
      "INSERT INTO account_mail(id,token_hash,user_id,payload,next_run,expires,created) VALUES(?,?,?,?,?,?,?)",
      randomUUID(),
      hash,
      user.id,
      seal(payload),
      now,
      expires,
      now,
    );
  });
}
function validToken(token, kind) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    throw new InputError("Link inválido ou expirado. Solicite um novo link.");
  const entry = one(
    "SELECT * FROM account_tokens WHERE hash=? AND kind=? AND expires>?",
    digest(token),
    kind,
    Date.now(),
  );
  if (!entry)
    throw new InputError("Link inválido ou expirado. Solicite um novo link.");
  return entry;
}
function invalidateAccountLinks(id) {
  run("DELETE FROM account_tokens WHERE user_id=?", id);
  run(
    "UPDATE account_mail SET state='cancelled',payload=NULL WHERE user_id=? AND state IN ('pending','sending')",
    id,
  );
  run("DELETE FROM sessions WHERE user_id=?", id);
  run("DELETE FROM oauth_states WHERE user_id=?", id);
}
export function verifyEmail(token) {
  return transaction(() => {
    const entry = validToken(token, "verify");
    run(
      "INSERT INTO verified_accounts VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET verified=excluded.verified",
      entry.user_id,
      Date.now(),
    );
    invalidateAccountLinks(entry.user_id);
  });
}
export async function resetPassword(token, password) {
  validToken(token, "reset");
  if (
    typeof password !== "string" ||
    password.length < 10 ||
    password.length > 128
  )
    throw new InputError("Use uma senha entre 10 e 128 caracteres.");
  const hash = await passwordHash(password);
  // Recheck after asynchronous scrypt; concurrent requests may already have consumed the token.
  transaction(() => {
    const entry = validToken(token, "reset");
    run("UPDATE users SET password=? WHERE id=?", hash, entry.user_id);
    run(
      "INSERT INTO verified_accounts VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET verified=excluded.verified",
      entry.user_id,
      Date.now(),
    );
    invalidateAccountLinks(entry.user_id);
  });
}
export async function sendResend(payload, id) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.RESEND_API_KEY,
      "Content-Type": "application/json",
      "Idempotency-Key": "account-" + id,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.id)
    throw Error("Email provider did not accept the message.");
}
export function recoverAccountMail() {
  run("UPDATE account_mail SET state='pending' WHERE state='sending'");
}
export async function processAccountMail(
  sender = sendResend,
  now = Date.now(),
) {
  run("DELETE FROM account_tokens WHERE expires<=?", now);
  run(
    "UPDATE account_mail SET state='cancelled',payload=NULL WHERE state IN ('pending','sending') AND (expires<=? OR token_hash NOT IN (SELECT hash FROM account_tokens))",
    now,
  );
  run(
    "DELETE FROM account_mail WHERE state IN ('sent','failed','cancelled') AND created<?",
    now - 7 * 86400000,
  );
  if (!mailReady()) return;
  const item = one(
    "SELECT * FROM account_mail WHERE state='pending' AND next_run<=? ORDER BY created LIMIT 1",
    now,
  );
  if (!item) return;
  if (
    !run(
      "UPDATE account_mail SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'",
      item.id,
    ).changes
  )
    return;
  try {
    await sender(unseal(item.payload), item.id);
    run(
      "UPDATE account_mail SET state='sent',payload=NULL WHERE id=? AND state='sending'",
      item.id,
    );
  } catch {
    const failed = item.attempts + 1 >= 5;
    run(
      "UPDATE account_mail SET state=?,payload=CASE WHEN ? THEN NULL ELSE payload END,next_run=? WHERE id=? AND state='sending'",
      failed ? "failed" : "pending",
      Number(failed),
      now + Math.min(300000, 15000 * 2 ** item.attempts),
      item.id,
    );
  }
}

export async function publicAccount(req, res, url, h) {
  if (req.method !== "POST") return false;
  const route = url.pathname;
  if (
    ![
      "/api/auth/forgot-password",
      "/api/auth/reset-password",
      "/api/auth/verify-email",
    ].includes(route)
  )
    return false;
  if (!accountLimit("account-ip:" + req.socket.remoteAddress, 30, 900000))
    throw new InputError("Muitas tentativas. Aguarde 15 minutos.", 429);
  const input = await h.body(req);
  if (route.endsWith("forgot-password")) {
    const started = Date.now();
    const email = normalizeEmail(input.email);
    requireMail();
    const allowed = accountLimit("reset-email:" + email, 3, 900000);
    const user = one("SELECT id,email FROM users WHERE email=?", email);
    if (allowed && user) queueAccountEmail(user, "reset");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 200 - (Date.now() - started))),
    );
    h.json(res, 200, { message: genericResetMessage });
    return true;
  }
  if (route.endsWith("verify-email")) verifyEmail(input.token);
  else await resetPassword(input.token, input.password);
  logout(req, res);
  h.json(res, 200, {
    message: route.endsWith("verify-email")
      ? "E-mail confirmado. Entre novamente para continuar."
      : "Senha redefinida. Entre com sua nova senha.",
  });
  return true;
}
export async function privateAccount(req, res, url, user, h) {
  if (url.pathname !== "/api/auth/verification/resend" || req.method !== "POST")
    return false;
  if (isVerified(user.id)) {
    h.json(res, 200, { message: "Seu e-mail já está confirmado." });
    return true;
  }
  requireMail();
  if (!accountLimit("verify-user:" + user.id, 1, 60000))
    throw new InputError(
      "Aguarde um minuto antes de solicitar outro e-mail.",
      429,
    );
  queueAccountEmail(user, "verify");
  h.json(res, 200, {
    message:
      "Envio solicitado. Confira sua caixa de entrada e o spam. O novo link substitui o anterior.",
  });
  return true;
}
