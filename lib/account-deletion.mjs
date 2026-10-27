import { unlink } from "node:fs/promises";
import { one, all, run, transaction } from "./db.mjs";
import { assetPath, outputPath } from "./config.mjs";
import { passwordMatches, logout } from "./auth.mjs";
import { accountLimit } from "./account.mjs";
import { InputError } from "./composition.mjs";

export const DELETE_CONFIRMATION = "EXCLUIR";
// Every table holding a user_id, in foreign-key order. Fixed list, never request input.
// asset_kinds rows follow their assets through ON DELETE CASCADE.
const OWNED_TABLES = [
  "scheduled_posts",
  "social_connections",
  "oauth_states",
  "usage_events",
  "jobs",
  "batches",
  "projects",
  "assets",
  "saved_profiles",
  "saved_styles",
  "ai_requests",
  "discovery_items",
  "account_mail",
  "account_tokens",
  "verified_accounts",
  "checkout_requests",
  "subscriptions",
  "billing_customers",
  "sessions",
];
// Subscriptions Stripe may still charge. One set to cancel at period end will not renew.
const CHARGEABLE =
  "'active','trialing','past_due','unpaid','paused','incomplete'";

export async function deleteAccount(req, res, user, input, { uploading }) {
  if (input.confirm !== DELETE_CONFIRMATION)
    throw new InputError(
      `Digite ${DELETE_CONFIRMATION} para confirmar a exclusão.`,
    );
  // Bounds password guesses from a stolen session; retries after a 409 also count.
  if (!accountLimit("delete-user:" + user.id, 10, 900000))
    throw new InputError("Muitas tentativas. Aguarde 15 minutos.", 429);
  const stored = one("SELECT password FROM users WHERE id=?", user.id);
  if (
    typeof input.password !== "string" ||
    input.password.length > 128 ||
    !stored ||
    !(await passwordMatches(input.password, stored.password))
  )
    throw new InputError("Senha incorreta.", 403);
  if (uploading.has(user.id))
    throw new InputError("Aguarde o upload em andamento terminar.", 409);
  const result = transaction(() => {
    if (
      one(
        `SELECT id FROM subscriptions WHERE user_id=? AND status IN (${CHARGEABLE}) AND cancel_at_end=0`,
        user.id,
      )
    )
      throw new InputError(
        "Cancele sua assinatura em Seu plano → Gerenciar assinatura antes de excluir a conta.",
        409,
      );
    // Media of a post being sent must stay available to the provider until it finishes.
    if (
      one(
        "SELECT id FROM scheduled_posts WHERE user_id=? AND status IN ('preparing','publishing')",
        user.id,
      )
    )
      throw new InputError(
        "Uma publicação está sendo enviada agora. Aguarde alguns minutos e tente novamente.",
        409,
      );
    // Stop renders first; the worker must not keep reading files we are about to remove.
    run(
      "UPDATE jobs SET state='cancelled',updated=? WHERE user_id=? AND state='queued'",
      Date.now(),
      user.id,
    );
    run(
      "UPDATE usage_events SET state='released' WHERE user_id=? AND state='reserved' AND job_id IN (SELECT id FROM jobs WHERE user_id=? AND state='cancelled')",
      user.id,
      user.id,
    );
    run(
      "UPDATE jobs SET state='cancelling',updated=? WHERE user_id=? AND state='running'",
      Date.now(),
      user.id,
    );
    if (
      one(
        "SELECT id FROM jobs WHERE user_id=? AND state IN ('running','cancelling')",
        user.id,
      )
    )
      return null;
    const assets = all("SELECT id FROM assets WHERE user_id=?", user.id),
      jobs = all("SELECT id FROM jobs WHERE user_id=?", user.id),
      customer = one(
        "SELECT customer_id FROM billing_customers WHERE user_id=?",
        user.id,
      )?.customer_id;
    // Stored webhook payloads carry the customer's billing details.
    if (customer)
      run(
        "DELETE FROM billing_events WHERE instr(payload,?)>0",
        JSON.stringify(customer),
      );
    for (const table of OWNED_TABLES)
      run(`DELETE FROM ${table} WHERE user_id=?`, user.id);
    run("DELETE FROM users WHERE id=?", user.id);
    return [
      ...assets.map((a) => assetPath(a.id)),
      ...jobs.map((j) => outputPath(j.id)),
    ];
  });
  if (!result)
    throw new InputError(
      "Interrompemos suas exportações em andamento. Tente excluir novamente em alguns segundos.",
      409,
    );
  let left = 0;
  for (const file of result)
    await unlink(file).catch((e) => {
      if (e.code !== "ENOENT") left++;
    });
  if (left) console.error("Account deletion left files to remove:", left);
  logout(req, res);
}
