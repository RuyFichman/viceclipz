import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
process.env.DATA_DIR = path.resolve(".test-data-launch-" + randomUUID());
process.env.APP_ORIGIN = "https://studio.example.test";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "";
process.env.EMAIL_FROM = "";
process.env.EMAIL_VERIFICATION_REQUIRED = "false";
process.env.BILLING_REQUIRED = "false";
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.INSTAGRAM_CLIENT_ID = "test-client";
process.env.INSTAGRAM_CLIENT_SECRET = "test-secret";
process.env.META_API_VERSION = "v99.0";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fixture";
process.env.STRIPE_CREATOR_PRICE_ID = "price_creator";
process.env.STRIPE_STUDIO_PRICE_ID = "price_studio";
const { db, run, one } = await import("../lib/db.mjs");
const store = await import("../lib/launch-store.mjs");
const social = await import("../lib/social.mjs");
const billing = await import("../lib/billing.mjs");
const { processPost, recoverPosts } = await import("../lib/scheduler.mjs");
const { api, json } = await import("../lib/api.mjs");
const { createSession, passwordHash } = await import("../lib/auth.mjs");
const { assetPath, outputPath } = await import("../lib/config.mjs");
const { build, deploymentConfig } = await import("../build-vercel.mjs");
const { backup } = await import("../backup.mjs");
const user = randomUUID(),
  other = randomUUID(),
  project = randomUUID(),
  job = randomUUID(),
  connection = randomUUID();
const now = Date.now();
for (const id of [user, other])
  run(
    "INSERT INTO users VALUES(?,?,?,?,?)",
    id,
    id + "@example.test",
    "Tester",
    "not-a-login-hash",
    now,
  );
run("INSERT INTO projects VALUES(?,?,?,?,?)", project, user, "{}", 1, now);
run(
  "INSERT INTO jobs(id,user_id,project_id,fingerprint,snapshot,state,created,updated) VALUES(?,?,?,?,?,'done',?,?)",
  job,
  user,
  project,
  "fixture",
  JSON.stringify({ name: "Vídeo de teste", format: "9:16", start: 0, end: 8 }),
  now,
  now,
);
run(
  "INSERT INTO social_connections VALUES(?,?,?,?,?,?,?,'connected',?)",
  connection,
  user,
  "instagram",
  "remote-account",
  "Conta de teste",
  store.seal({ access_token: "fixture-token" }),
  now + 864000000,
  now,
);
const server = createServer(async (req, res) => {
  try {
    await api(req, res, new URL(req.url, process.env.APP_ORIGIN), true);
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;
function session(id) {
  let cookie;
  createSession(
    {
      setHeader: (k, v) => {
        cookie = v.split(";")[0];
      },
    },
    id,
  );
  return cookie;
}
const cookie = session(user),
  otherCookie = session(other);
async function call(
  route,
  { method = "GET", data, auth = cookie, headers = {}, expected = 200 } = {},
) {
  const response = await fetch(base + "/api" + route, {
    method,
    headers: {
      Cookie: auth,
      "X-ViceClipz": "studio",
      Origin: process.env.APP_ORIGIN,
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
function post(overrides = {}) {
  return {
    requestKey: randomUUID(),
    jobId: job,
    connectionId: connection,
    title: "Meu Reel",
    caption: "Legenda",
    due: new Date(Date.now() + 3600000).toISOString(),
    timezone: "America/Sao_Paulo",
    privacy: "public",
    madeForKids: false,
    ...overrides,
  };
}
function clearPosts() {
  run("DELETE FROM scheduled_posts");
}
await test("Etapa 3: integrações, fila, cobrança e deploy", async (t) => {
  try {
    await t.test(
      "tokens cifrados, autenticação e expiração dos links de mídia",
      () => {
        const sealed = store.seal({ secret: "sensitive" });
        assert(!sealed.includes("sensitive"));
        assert.deepEqual(store.unseal(sealed), { secret: "sensitive" });
        const bytes = Buffer.from(sealed, "base64url");
        bytes[30] ^= 1;
        assert.throws(() => store.unseal(bytes.toString("base64url")));
        const expiry = Date.now() + 60000,
          signature = store.mediaSignature("post", expiry);
        assert(store.validMediaSignature("post", expiry, signature));
        assert(!store.validMediaSignature("other", expiry, signature));
        assert(!store.validMediaSignature("post", Date.now() - 1, signature));
      },
    );
    await t.test(
      "OAuth inclui state, cookie vinculado e PKCE; callback forjado rejeitado",
      async () => {
        let cookieHeader;
        const output = social.startOAuth({ id: user }, "youtube", {
          setHeader: (k, v) => {
            cookieHeader = v;
          },
        });
        const url = new URL(output.url);
        assert.equal(url.hostname, "accounts.google.com");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.match(cookieHeader, /HttpOnly.*SameSite=Lax/);
        await assert.rejects(
          social.finishOAuth(
            { headers: { cookie: "viceclipz_oauth=wrong" } },
            new URL(
              process.env.APP_ORIGIN +
                "/api/social/callback/youtube?state=" +
                url.searchParams.get("state") +
                "&code=x",
            ),
            "youtube",
          ),
          /inválida/,
        );
      },
    );
    await t.test(
      "contas e agendamentos são privados, validados e idempotentes",
      async () => {
        const info = await call("/integrations");
        assert.equal(info.connections.length, 1);
        assert(!JSON.stringify(info).includes("fixture-token"));
        assert.deepEqual(
          (await call("/integrations", { auth: otherCookie })).connections,
          [],
        );
        await call("/schedules", {
          method: "POST",
          auth: otherCookie,
          data: post(),
          expected: 404,
        });
        await call("/schedules", {
          method: "POST",
          data: post({ due: new Date(0).toISOString() }),
          expected: 400,
        });
        await call("/schedules", {
          method: "POST",
          data: post({ timezone: "fake/zone" }),
          expected: 400,
        });
        await call("/schedules", {
          method: "POST",
          data: post(),
          headers: { Origin: "https://evil.test" },
          expected: 403,
        });
        const input = post(),
          a = await call("/schedules", {
            method: "POST",
            data: input,
            expected: 201,
          }),
          b = await call("/schedules", { method: "POST", data: input });
        assert.equal(a.id, b.id);
        assert.equal(one("SELECT count(*) n FROM scheduled_posts").n, 1);
        await call("/schedules/" + a.id + "/cancel", {
          method: "POST",
          auth: otherCookie,
          expected: 404,
        });
        await call("/jobs/" + job, { method: "DELETE", expected: 409 });
        await call("/schedules/" + a.id + "/cancel", { method: "POST" });
        assert.equal(
          one("SELECT status FROM scheduled_posts WHERE id=?", a.id).status,
          "cancelled",
        );
        await call("/schedules/" + a.id, { method: "DELETE" });
      },
    );
    await t.test(
      "fila respeita o horário e publica uma única vez",
      async () => {
        const item = await call("/schedules", {
          method: "POST",
          data: post(),
          expected: 201,
        });
        let prepared = 0,
          published = 0;
        const adapter = {
          prepare: async () => {
            prepared++;
            return { container: "fake" };
          },
          ready: async () => true,
          publish: async () => {
            published++;
            return "remote-post";
          },
        };
        await processPost(adapter);
        assert.equal(prepared, 0);
        const due = one(
          "SELECT due FROM scheduled_posts WHERE id=?",
          item.id,
        ).due;
        await processPost(adapter, due);
        assert.equal(prepared, 1);
        assert.equal(
          one("SELECT status FROM scheduled_posts WHERE id=?", item.id).status,
          "processing",
        );
        await processPost(adapter, due + 6000);
        await processPost(adapter, due + 10000);
        assert.equal(published, 1);
        assert.equal(
          one("SELECT remote_id FROM scheduled_posts WHERE id=?", item.id)
            .remote_id,
          "remote-post",
        );
        clearPosts();
      },
    );
    await t.test(
      "envio ambíguo e reinício não duplicam publicação",
      async () => {
        const item = await call("/schedules", {
            method: "POST",
            data: post(),
            expected: 201,
          }),
          due = one("SELECT due FROM scheduled_posts WHERE id=?", item.id).due;
        let attempts = 0;
        const adapter = {
          prepare: async () => ({ container: "fake" }),
          ready: async () => true,
          publish: async () => {
            attempts++;
            throw Error("Connection closed after sending");
          },
        };
        await processPost(adapter, due);
        await processPost(adapter, due + 6000);
        await processPost(adapter, due + 10000);
        assert.equal(attempts, 1);
        assert.equal(
          one("SELECT status FROM scheduled_posts WHERE id=?", item.id).status,
          "needs_review",
        );
        run(
          "UPDATE scheduled_posts SET status='publishing' WHERE id=?",
          item.id,
        );
        recoverPosts();
        assert.equal(
          one("SELECT status FROM scheduled_posts WHERE id=?", item.id).status,
          "needs_review",
        );
        await call("/schedules/" + item.id + "/resolve", {
          method: "POST",
          data: { result: "published" },
        });
        clearPosts();
      },
    );
    await t.test(
      "cancelamento durante processamento impede envio",
      async () => {
        const item = await call("/schedules", {
            method: "POST",
            data: post(),
            expected: 201,
          }),
          due = one("SELECT due FROM scheduled_posts WHERE id=?", item.id).due;
        let sent = 0;
        const adapter = {
          prepare: async () => ({ id: "x" }),
          ready: async () => true,
          publish: async () => {
            sent++;
            return "x";
          },
        };
        await processPost(adapter, due);
        await call("/schedules/" + item.id + "/cancel", { method: "POST" });
        await processPost(adapter, due + 10000);
        assert.equal(sent, 0);
        clearPosts();
      },
    );
    await t.test(
      "preparação tem limite de tentativas e atraso excessivo não publica",
      async () => {
        let item = await call("/schedules", {
            method: "POST",
            data: post(),
            expected: 201,
          }),
          due = one("SELECT due FROM scheduled_posts WHERE id=?", item.id).due;
        const adapter = {
          prepare: async () => {
            throw Error("provider offline");
          },
        };
        for (const offset of [0, 60001, 180002])
          await processPost(adapter, due + offset);
        assert.equal(
          one("SELECT status FROM scheduled_posts WHERE id=?", item.id).status,
          "failed",
        );
        clearPosts();
        item = await call("/schedules", {
          method: "POST",
          data: post(),
          expected: 201,
        });
        due = one("SELECT due FROM scheduled_posts WHERE id=?", item.id).due;
        await processPost(adapter, due + 25 * 3600000);
        assert.equal(
          one("SELECT status FROM scheduled_posts WHERE id=?", item.id).status,
          "failed",
        );
        clearPosts();
      },
    );
    await t.test(
      "webhook exige assinatura, persiste e deduplica evento",
      async () => {
        const event = {
            id: "evt_fixture",
            type: "customer.subscription.updated",
            livemode: false,
            data: { object: { id: "sub_fixture" } },
          },
          raw = JSON.stringify(event),
          signature = billing.stripe().webhooks.generateTestHeaderString({
            payload: raw,
            secret: process.env.STRIPE_WEBHOOK_SECRET,
          });
        assert.throws(
          () => billing.acceptWebhook(Buffer.from(raw), "invalid"),
          /inválida/,
        );
        billing.acceptWebhook(Buffer.from(raw), signature);
        billing.acceptWebhook(Buffer.from(raw), signature);
        assert.equal(one("SELECT count(*) n FROM billing_events").n, 1);
        const response = await fetch(base + "/api/billing/webhook", {
          method: "POST",
          headers: { "stripe-signature": signature },
          body: raw,
        });
        assert.equal(response.status, 200);
      },
    );
    await t.test(
      "cobrança reconcilia estado atual; cancelamento e preços desconhecidos não dão acesso",
      async () => {
        run("INSERT INTO billing_customers VALUES(?,?)", user, "cus_fixture");
        process.env.BILLING_REQUIRED = "true";
        let status = "active",
          price = "price_creator";
        const client = {
          subscriptions: {
            retrieve: async () => ({
              id: "sub_fixture",
              customer: "cus_fixture",
              status,
              cancel_at_period_end: false,
              items: {
                data: [
                  {
                    price: { id: price },
                    current_period_end: Math.floor(Date.now() / 1000) + 3600,
                  },
                ],
              },
            }),
          },
        };
        await billing.applyEvent(
          {
            type: "customer.subscription.updated",
            data: { object: { id: "sub_fixture", status: "canceled" } },
          },
          client,
        );
        assert.equal(store.planFor(user).key, "creator");
        status = "canceled";
        await billing.applyEvent(
          {
            type: "customer.subscription.updated",
            data: { object: { id: "sub_fixture", status: "active" } },
          },
          client,
        );
        assert.equal(store.planFor(user).key, "free");
        status = "active";
        price = "price_unknown";
        await billing.applyEvent(
          {
            type: "customer.subscription.updated",
            data: { object: { id: "sub_fixture" } },
          },
          client,
        );
        assert.equal(store.planFor(user).key, "free");
        for (let i = 0; i < 10; i++) store.reserveRender("quota-" + i, user);
        assert(!store.canRender(user));
        store.releaseRender("quota-0");
        assert(store.canRender(user));
        run("UPDATE usage_events SET state='completed' WHERE job_id='quota-1'");
        store.releaseRender("quota-1");
        assert.equal(
          one("SELECT state FROM usage_events WHERE job_id='quota-1'").state,
          "completed",
        );
        process.env.BILLING_REQUIRED = "false";
      },
    );
    await t.test(
      "adaptador Instagram envia o MP4 assinado e usa container para publicar",
      async () => {
        const original = globalThis.fetch,
          calls = [];
        globalThis.fetch = async (url, options) => {
          calls.push({ url: String(url), options });
          return Response.json(
            calls.length === 1
              ? { id: "container" }
              : calls.length === 2
                ? { status_code: "FINISHED" }
                : { id: "published" },
          );
        };
        try {
          const p = { id: randomUUID(), caption: "Meu texto" },
            c = one("SELECT * FROM social_connections WHERE id=?", connection);
          const checkpoint = await social.productionAdapter.prepare(p, c);
          assert.equal(checkpoint.container, "container");
          assert.match(calls[0].options.body.get("video_url"), /signature=/);
          assert.equal(calls[0].options.body.get("media_type"), "REELS");
          assert(await social.productionAdapter.ready(p, c, checkpoint));
          assert.equal(
            await social.productionAdapter.publish(p, c, checkpoint),
            "published",
          );
          assert.equal(calls[2].options.body.get("creation_id"), "container");
        } finally {
          globalThis.fetch = original;
        }
      },
    );
    await t.test(
      "build Vercel contém apenas arquivos públicos e proxy HTTPS",
      async () => {
        assert.throws(() => deploymentConfig("http://localhost:4173"));
        assert.throws(() =>
          deploymentConfig("https://name:secret@example.com"),
        );
        const output = await mkdtemp(path.join(process.env.DATA_DIR, "build-"));
        await build(output, "https://backend.example.test");
        const config = JSON.parse(
          await readFile(path.join(output, "config.json"), "utf8"),
        );
        assert.equal(
          config.routes[1].dest,
          "https://backend.example.test/api/$1",
        );
        const files = await readdir(path.join(output, "static"));
        assert(files.includes("launch.js"));
        assert(files.includes("format.js"));
        for (const page of ["termos", "privacidade", "retencao", "suporte"]) {
          assert(files.includes(page + ".html"));
          assert(
            config.routes.some(
              (r) => r.src === "/" + page && r.dest === "/" + page + ".html",
            ),
          );
        }
        assert(!files.some((f) => /env|sqlite|server|worker/.test(f)));
      },
    );
    await t.test(
      "checkout é idempotente e portal usa somente o cliente do titular",
      async () => {
        let created = 0,
          customerCount = 0,
          hasSubscription = false;
        const client = {
          customers: {
            create: async () => {
              customerCount++;
              return { id: "cus_other" };
            },
          },
          subscriptions: {
            list: async () => ({
              data: hasSubscription ? [{ status: "active" }] : [],
            }),
          },
          prices: {
            retrieve: async () => ({
              active: true,
              type: "recurring",
              recurring: { interval: "month", interval_count: 1 },
            }),
          },
          checkout: {
            sessions: {
              create: async (params) => {
                created++;
                assert.equal(params.customer, "cus_other");
                return { url: "https://checkout.stripe.com/fixture" };
              },
            },
          },
          billingPortal: {
            sessions: {
              create: async (params) => {
                assert.equal(params.customer, "cus_other");
                return { url: "https://billing.stripe.com/fixture" };
              },
            },
          },
        };
        const owner = {
          id: other,
          email: "fixture@example.test",
          name: "Fixture",
        };
        assert.equal(
          (await billing.checkout(owner, "creator", client)).url,
          "https://checkout.stripe.com/fixture",
        );
        await billing.checkout(owner, "creator", client);
        assert.equal(created, 1);
        assert.equal(customerCount, 1);
        await assert.rejects(
          billing.checkout(owner, "studio", client),
          /checkout em aberto/,
        );
        assert.equal(
          (await billing.portal(owner, client)).url,
          "https://billing.stripe.com/fixture",
        );
        hasSubscription = true;
        await assert.rejects(
          billing.checkout(owner, "creator", client),
          /assinatura existente/,
        );
      },
    );
    await t.test(
      "refresh de token atualiza segredo cifrado e revogação exige reconexão",
      async () => {
        const original = globalThis.fetch,
          c = one("SELECT * FROM social_connections WHERE id=?", connection);
        c.expires = 0;
        try {
          globalThis.fetch = async () =>
            Response.json({
              access_token: "renewed-fixture",
              expires_in: 5000000,
            });
          assert.equal(await social.accessToken(c), "renewed-fixture");
          assert.equal(
            store.unseal(
              one(
                "SELECT secret FROM social_connections WHERE id=?",
                connection,
              ).secret,
            ).access_token,
            "renewed-fixture",
          );
          globalThis.fetch = async () =>
            Response.json({ error: "revoked" }, { status: 401 });
          await assert.rejects(social.accessToken(c), /Reconecte/);
          assert.equal(
            one("SELECT state FROM social_connections WHERE id=?", connection)
              .state,
            "reconnect",
          );
        } finally {
          globalThis.fetch = original;
        }
      },
    );
    await t.test(
      "planos mostram o preço mensal configurado no Stripe",
      async () => {
        let calls = 0;
        const client = {
          prices: {
            retrieve: async (id) => {
              calls++;
              return {
                active: id === "price_creator",
                type: "recurring",
                recurring: { interval: "month", interval_count: 1 },
                unit_amount: 4900,
                currency: "brl",
              };
            },
          },
        };
        const info = await billing.billingInfo(other, client),
          byKey = Object.fromEntries(info.plans.map((p) => [p.key, p]));
        assert.equal(byKey.free.price, null);
        assert.deepEqual(byKey.creator.price, {
          amount: 4900,
          currency: "BRL",
          interval: "month",
        });
        assert.equal(byKey.studio.price, null, "inactive price is hidden");
        assert.equal(byKey.studio.storage, 5 * 1024 ** 3);
        const failing = {
          prices: {
            retrieve: async () => {
              throw Error("offline");
            },
          },
        };
        assert.deepEqual(
          (await billing.billingInfo(other, failing)).plans[1].price,
          byKey.creator.price,
          "cached price survives a provider outage",
        );
        assert.equal(calls, 2);
      },
    );
    await t.test(
      "exclusão de conta exige senha, respeita assinatura e envios e apaga tudo do titular",
      async () => {
        const id = randomUUID(),
          password = "senha-de-teste-123",
          customer = "cus_deleted_" + id.slice(0, 8);
        run(
          "INSERT INTO users VALUES(?,?,?,?,?)",
          id,
          id + "@example.test",
          "Removível",
          await passwordHash(password),
          now,
        );
        const auth = session(id),
          [asset, proj, doneJob, runningJob, queuedJob, conn, postId] =
            Array.from({ length: 7 }, () => randomUUID());
        run(
          "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)",
          asset,
          id,
          "Imagem",
          10,
          0,
          10,
          10,
          0,
          now,
        );
        run(
          "INSERT INTO asset_kinds VALUES(?,?,?)",
          asset,
          "image",
          "image/png",
        );
        run("INSERT INTO projects VALUES(?,?,?,?,?)", proj, id, "{}", 1, now);
        for (const [jobId, state] of [
          [doneJob, "done"],
          [runningJob, "running"],
          [queuedJob, "queued"],
        ]) {
          run(
            "INSERT INTO jobs(id,user_id,project_id,fingerprint,snapshot,state,created,updated) VALUES(?,?,?,?,?,?,?,?)",
            jobId,
            id,
            proj,
            jobId,
            "{}",
            state,
            now,
            now,
          );
          run(
            "INSERT INTO usage_events VALUES(?,?,?,?,?)",
            jobId,
            id,
            store.month(),
            state === "done" ? "completed" : "reserved",
            now,
          );
        }
        await writeFile(assetPath(asset), "image");
        await writeFile(outputPath(doneJob), "mp4");
        run(
          "INSERT INTO social_connections VALUES(?,?,?,?,?,?,?,'connected',?)",
          conn,
          id,
          "instagram",
          "remote-removable",
          "removivel",
          store.seal({ access_token: "removable-token" }),
          now + 86400000,
          now,
        );
        run(
          "INSERT INTO scheduled_posts(id,user_id,job_id,connection_id,request_key,due,timezone,title,caption,privacy,made_for_kids,status,next_run,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,'publishing',?,?,?)",
          postId,
          id,
          doneJob,
          conn,
          randomUUID(),
          now + 3600000,
          "America/Sao_Paulo",
          "Título",
          "Legenda",
          "public",
          0,
          now,
          now,
          now,
        );
        run("INSERT INTO billing_customers VALUES(?,?)", id, customer);
        run(
          "INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?)",
          "sub_" + id,
          id,
          customer,
          "price_creator",
          "active",
          now + 86400000,
          0,
          now,
        );
        run(
          "INSERT INTO billing_events(id,type,payload,next_run,created) VALUES(?,?,?,?,?)",
          "evt_" + id,
          "invoice.paid",
          JSON.stringify({ data: { object: { customer } } }),
          now,
          now,
        );
        run(
          "INSERT INTO discovery_items VALUES(?,?,?,?,?,?,?,?)",
          randomUUID(),
          id,
          "https://example.test/" + id,
          "site",
          "Título",
          "Descrição",
          "Autor",
          now,
        );
        run(
          "INSERT INTO saved_profiles VALUES(?,?,?,?,?)",
          randomUUID(),
          id,
          "Perfil",
          "{}",
          now,
        );
        run(
          "INSERT INTO ai_requests VALUES(?,?,?,?)",
          randomUUID(),
          id,
          store.month(),
          now,
        );
        run("INSERT INTO verified_accounts VALUES(?,?)", id, now);
        const remove = (data, expected) =>
          call("/auth/delete-account", {
            method: "POST",
            auth,
            data,
            expected,
          });
        await remove({ password, confirm: "excluir" }, 400);
        await remove({ password: "senha-errada-000", confirm: "EXCLUIR" }, 403);
        await call("/auth/delete-account", {
          method: "POST",
          auth,
          data: { password, confirm: "EXCLUIR" },
          headers: { "X-ViceClipz": "" },
          expected: 403,
        });
        assert.match(
          (await remove({ password, confirm: "EXCLUIR" }, 409)).error,
          /Cancele sua assinatura/,
        );
        run("UPDATE subscriptions SET cancel_at_end=1 WHERE user_id=?", id);
        assert.match(
          (await remove({ password, confirm: "EXCLUIR" }, 409)).error,
          /sendo enviada/,
        );
        run("UPDATE scheduled_posts SET status='queued' WHERE id=?", postId);
        assert.match(
          (await remove({ password, confirm: "EXCLUIR" }, 409)).error,
          /Interrompemos/,
        );
        assert.equal(
          one("SELECT state FROM jobs WHERE id=?", runningJob).state,
          "cancelling",
        );
        assert.equal(
          one("SELECT state FROM jobs WHERE id=?", queuedJob).state,
          "cancelled",
        );
        assert.equal(
          one("SELECT state FROM usage_events WHERE job_id=?", queuedJob).state,
          "released",
        );
        assert(
          one("SELECT id FROM users WHERE id=?", id),
          "nothing removed yet",
        );
        // The worker acknowledges the cancellation.
        run("UPDATE jobs SET state='cancelled' WHERE id=?", runningJob);
        const response = await fetch(base + "/api/auth/delete-account", {
          method: "POST",
          headers: {
            Cookie: auth,
            "X-ViceClipz": "studio",
            Origin: process.env.APP_ORIGIN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ password, confirm: "EXCLUIR" }),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
        const owned = db
          .prepare(
            "SELECT m.name FROM sqlite_master m WHERE m.type='table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name='user_id')",
          )
          .all()
          .map((t) => t.name);
        assert(owned.length >= 19);
        for (const table of owned)
          assert.equal(
            one(`SELECT count(*) n FROM ${table} WHERE user_id=?`, id).n,
            0,
            table,
          );
        assert.equal(one("SELECT count(*) n FROM users WHERE id=?", id).n, 0);
        assert.equal(
          one("SELECT count(*) n FROM asset_kinds WHERE asset_id=?", asset).n,
          0,
        );
        assert.equal(
          one("SELECT count(*) n FROM billing_events WHERE id=?", "evt_" + id)
            .n,
          0,
        );
        await assert.rejects(stat(assetPath(asset)), { code: "ENOENT" });
        await assert.rejects(stat(outputPath(doneJob)), { code: "ENOENT" });
        await call("/auth/me", { auth, expected: 401 });
        assert(
          one("SELECT id FROM users WHERE id=?", user),
          "others untouched",
        );
        assert(one("SELECT id FROM jobs WHERE id=?", job));
        // Later Stripe events for the removed customer are accepted without a retry loop.
        await billing.applyEvent(
          {
            type: "customer.subscription.deleted",
            data: { object: { id: "sub_" + id } },
          },
          {
            subscriptions: {
              retrieve: async () => ({
                id: "sub_" + id,
                customer,
                metadata: { viceclipz_user_id: id },
                status: "canceled",
                items: { data: [] },
              }),
            },
          },
        );
        assert.equal(
          one("SELECT count(*) n FROM subscriptions WHERE user_id=?", id).n,
          0,
        );
      },
    );
    await t.test(
      "backup restaura SQLite e arquivos e rejeita corrupção e sobrescrita",
      async () => {
        const source = await mkdtemp(
            path.join(process.env.DATA_DIR, "offline-"),
          ),
          destination = source + "-backup",
          restored = source + "-restore";
        const fixture = new DatabaseSync(path.join(source, "viceclipz.sqlite"));
        fixture.exec(
          "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('preserved')",
        );
        fixture.close();
        await writeFile(path.join(source, "video.mp4"), "fixture-video");
        await backup(source, destination);
        await backup(destination, restored, true);
        assert.equal(
          await readFile(path.join(restored, "video.mp4"), "utf8"),
          "fixture-video",
        );
        const copy = new DatabaseSync(path.join(restored, "viceclipz.sqlite"), {
          readOnly: true,
        });
        assert.equal(
          copy.prepare("SELECT value FROM fixture").get().value,
          "preserved",
        );
        copy.close();
        await assert.rejects(backup(source, destination), /novo/);
        await writeFile(path.join(destination, "video.mp4"), "tampered");
        await assert.rejects(
          backup(destination, restored + "-invalid", true),
          /Checksum/,
        );
      },
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});
