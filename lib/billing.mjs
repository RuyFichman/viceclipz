import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { one, run } from "./db.mjs";
import { ORIGIN } from "./config.mjs";
import { plans, planFor, renderUsage } from "./launch-store.mjs";
import { InputError } from "./composition.mjs";
let instance;
export const stripe = () =>
  (instance ??= new Stripe(process.env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    timeout: 15000,
  }));
export const billingReady = () =>
  Boolean(
    process.env.STRIPE_SECRET_KEY &&
    process.env.STRIPE_WEBHOOK_SECRET &&
    process.env.STRIPE_CREATOR_PRICE_ID &&
    process.env.STRIPE_STUDIO_PRICE_ID,
  );
export async function billingInfo(userId) {
  return {
    configured: billingReady(),
    mode: process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")
      ? "live"
      : "test",
    plan: planFor(userId),
    used: renderUsage(userId),
    subscription:
      one(
        "SELECT status,period_end,cancel_at_end FROM subscriptions WHERE user_id=? ORDER BY updated DESC LIMIT 1",
        userId,
      ) || null,
    plans: Object.entries(plans()).map(([key, p]) => ({
      key,
      name: p.name,
      renders: p.renders,
      storage: p.storage,
      social: p.social,
    })),
  };
}
const checkoutLocks = new Set();
export async function checkout(user, plan, client) {
  if (!billingReady())
    throw new InputError("Cobrança ainda não configurada.", 503);
  client ??= stripe();
  if (!["creator", "studio"].includes(plan))
    throw new InputError("Plano inválido.");
  if (checkoutLocks.has(user.id))
    throw new InputError("Aguarde a abertura do checkout.", 409);
  checkoutLocks.add(user.id);
  try {
    let customer = one(
      "SELECT customer_id FROM billing_customers WHERE user_id=?",
      user.id,
    )?.customer_id;
    if (!customer) {
      const created = await client.customers.create(
        {
          email: user.email,
          name: user.name,
          metadata: { viceclipz_user_id: user.id },
        },
        { idempotencyKey: "customer-" + user.id },
      );
      customer = created.id;
      run(
        "INSERT OR IGNORE INTO billing_customers VALUES(?,?)",
        user.id,
        customer,
      );
    }
    const subscriptions = await client.subscriptions.list({
      customer,
      status: "all",
      limit: 100,
    });
    if (
      subscriptions.data.some(
        (s) => !["canceled", "incomplete_expired"].includes(s.status),
      )
    )
      throw new InputError("Gerencie sua assinatura existente no portal.", 409);
    const priceId = plans()[plan].price,
      price = await client.prices.retrieve(priceId);
    if (
      !price.active ||
      price.type !== "recurring" ||
      price.recurring?.interval !== "month" ||
      price.recurring?.interval_count !== 1
    )
      throw new InputError(
        "O preço precisa ser uma assinatura mensal ativa.",
        503,
      );
    let pending = one(
      "SELECT * FROM checkout_requests WHERE user_id=?",
      user.id,
    );
    if (pending && pending.expires > Date.now()) {
      if (pending.price_id !== priceId)
        throw new InputError(
          "Já existe um checkout em aberto para outro plano. Aguarde uma hora ou conclua-o antes de trocar.",
          409,
        );
      if (pending.url) return { url: pending.url };
    } else {
      pending = { request_id: randomUUID(), expires: Date.now() + 3600000 };
      run(
        "INSERT INTO checkout_requests VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET price_id=excluded.price_id,request_id=excluded.request_id,url=NULL,expires=excluded.expires",
        user.id,
        priceId,
        pending.request_id,
        null,
        pending.expires,
      );
    }
    const session = await client.checkout.sessions.create(
      {
        mode: "subscription",
        customer,
        client_reference_id: user.id,
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: { metadata: { viceclipz_user_id: user.id } },
        success_url: ORIGIN + "/#billing",
        cancel_url: ORIGIN + "/#billing",
        expires_at: Math.floor(pending.expires / 1000),
      },
      { idempotencyKey: "checkout-" + pending.request_id },
    );
    run(
      "UPDATE checkout_requests SET url=? WHERE user_id=?",
      session.url,
      user.id,
    );
    return { url: session.url };
  } finally {
    checkoutLocks.delete(user.id);
  }
}
export async function portal(user, client) {
  if (!billingReady())
    throw new InputError("Cobrança ainda não configurada.", 503);
  client ??= stripe();
  const customer = one(
    "SELECT customer_id FROM billing_customers WHERE user_id=?",
    user.id,
  )?.customer_id;
  if (!customer)
    throw new InputError("Esta conta ainda não possui assinatura.", 409);
  return {
    url: (
      await client.billingPortal.sessions.create({
        customer,
        return_url: ORIGIN + "/#billing",
      })
    ).url,
  };
}
export function acceptWebhook(raw, signature) {
  if (!billingReady()) throw new InputError("Webhook não configurado.", 503);
  let event;
  try {
    event = stripe().webhooks.constructEvent(
      raw,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    throw new InputError("Assinatura do webhook inválida.", 400);
  }
  const live = process.env.STRIPE_SECRET_KEY.startsWith("sk_live_");
  if (Boolean(event.livemode) !== live)
    throw new InputError("Modo do evento incompatível.", 400);
  run(
    "INSERT OR IGNORE INTO billing_events(id,type,payload,next_run,created) VALUES(?,?,?,?,?)",
    event.id,
    event.type,
    JSON.stringify(event),
    Date.now(),
    Date.now(),
  );
  return { received: true };
}
export async function applyEvent(event, client = stripe()) {
  const object = event.data.object;
  let subscriptionId;
  if (event.type.startsWith("customer.subscription."))
    subscriptionId = object.id;
  else if (event.type.startsWith("invoice."))
    subscriptionId =
      object.subscription || object.parent?.subscription_details?.subscription;
  else if (event.type === "checkout.session.completed")
    subscriptionId = object.subscription;
  if (!subscriptionId) return;
  // Fetch current state instead of trusting webhook order or granting access from a browser redirect.
  const sub = await client.subscriptions.retrieve(subscriptionId),
    customer =
      typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const owner = one(
    "SELECT user_id FROM billing_customers WHERE customer_id=?",
    customer,
  );
  if (!owner) throw new Error("Cliente ainda não reconciliado.");
  const item = sub.items?.data?.[0],
    priceId = item?.price?.id || "";
  const end = (item?.current_period_end || sub.current_period_end || 0) * 1000;
  run(
    "INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET price_id=excluded.price_id,status=excluded.status,period_end=excluded.period_end,cancel_at_end=excluded.cancel_at_end,updated=excluded.updated",
    sub.id,
    owner.user_id,
    customer,
    priceId,
    sub.status,
    end,
    Number(sub.cancel_at_period_end),
    Date.now(),
  );
  run("DELETE FROM checkout_requests WHERE user_id=?", owner.user_id);
}
export async function processBilling() {
  if (!billingReady()) return;
  const event = one(
    "SELECT * FROM billing_events WHERE state='pending' AND next_run<=? ORDER BY created LIMIT 1",
    Date.now(),
  );
  if (!event) return;
  try {
    await applyEvent(JSON.parse(event.payload));
    run(
      "UPDATE billing_events SET state='done',error=NULL WHERE id=?",
      event.id,
    );
  } catch {
    const attempts = event.attempts + 1;
    run(
      "UPDATE billing_events SET attempts=?,error='Falha na reconciliação com Stripe.',next_run=?,state=? WHERE id=?",
      attempts,
      Date.now() + Math.min(3600000, 10000 * 2 ** Math.min(attempts, 8)),
      attempts >= 20 ? "failed" : "pending",
      event.id,
    );
  }
}
