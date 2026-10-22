import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
process.env.DATA_DIR = path.resolve(".test-data-account-" + randomUUID());
process.env.NODE_ENV = "test";
process.env.APP_ORIGIN = "https://studio.example.test";
process.env.RESEND_API_KEY = "re_fake_test_only";
process.env.EMAIL_FROM = "ViceClipz <accounts@example.test>";
process.env.EMAIL_VERIFICATION_REQUIRED = "true";
process.env.BILLING_REQUIRED = "false";
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, one, run, all } = await import("../lib/db.mjs");
const { unseal } = await import("../lib/launch-store.mjs");
const account = await import("../lib/account.mjs");
const { api, json } = await import("../lib/api.mjs");
const { digest, passwordMatches } = await import("../lib/auth.mjs");
const server = createServer(async (req, res) => {
  try {
    await api(req, res, new URL(req.url, process.env.APP_ORIGIN), true);
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
async function request(
  route,
  {
    data,
    method = data ? "POST" : "GET",
    cookie = "",
    expected = 200,
    headers = {},
  } = {},
) {
  const response = await fetch(origin + "/api" + route, {
    method,
    headers: {
      Cookie: cookie,
      "X-ViceClipz": "studio",
      Origin: process.env.APP_ORIGIN,
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return { value, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function register() {
  const email = randomUUID() + "@example.test",
    password = "Test-Password-Only-123";
  const result = await request("/auth/register", {
    data: { name: "QA Account", email, password },
    expected: 201,
  });
  return { ...result, email, password, id: result.value.user.id };
}
function latest(id, kind) {
  const row = one(
    "SELECT m.* FROM account_mail m JOIN account_tokens t ON t.hash=m.token_hash WHERE m.user_id=? AND t.kind=? ORDER BY m.created DESC LIMIT 1",
    id,
    kind,
  );
  const payload = unseal(row.payload);
  const link = payload.text.match(/https:\/\/\S+/)[0];
  return {
    row,
    payload,
    link,
    token: new URLSearchParams(new URL(link).hash.split("?")[1]).get("token"),
  };
}
await test("Account security: verification, recovery and transactional email", async (t) => {
  try {
    await t.test(
      "registration queues encrypted email; unverified sessions cannot access studio",
      async () => {
        const u = await register(),
          mail = latest(u.id, "verify");
        assert.equal(mail.row.token_hash, digest(mail.token));
        assert(!mail.row.payload.includes(mail.token));
        assert(!JSON.stringify(u.value).includes(mail.token));
        assert.equal(
          one("SELECT hash FROM account_tokens WHERE user_id=?", u.id).hash,
          digest(mail.token),
        );
        assert(
          mail.link.startsWith(
            process.env.APP_ORIGIN + "/#verify-email?token=",
          ),
        );
        assert.equal(new URL(mail.link).search, "");
        assert.equal(
          (await request("/auth/me", { cookie: u.cookie })).value.verification
            .verified,
          false,
        );
        for (const route of [
          "/projects",
          "/assets",
          "/jobs",
          "/integrations",
          "/billing",
          "/schedules",
        ])
          await request(route, { cookie: u.cookie, expected: 403 });
      },
    );
    await t.test(
      "verification is explicit, single-use and invalidates existing sessions",
      async () => {
        const u = await register(),
          mail = latest(u.id, "verify");
        await request("/auth/verify-email", {
          method: "GET",
          cookie: u.cookie,
          expected: 403,
        });
        assert(!account.isVerified(u.id));
        await request("/auth/verify-email", { data: { token: mail.token } });
        assert(account.isVerified(u.id));
        await request("/auth/me", { cookie: u.cookie, expected: 401 });
        await request("/auth/verify-email", {
          data: { token: mail.token },
          expected: 400,
        });
        const login = await request("/auth/login", {
          data: { email: u.email, password: u.password },
        });
        await request("/projects", { cookie: login.cookie });
        assert.equal(
          one("SELECT payload FROM account_mail WHERE id=?", mail.row.id)
            .payload,
          null,
        );
      },
    );
    await t.test(
      "expired, wrong-purpose and malformed tokens do not change accounts",
      async () => {
        const u = await register(),
          mail = latest(u.id, "verify");
        await request("/auth/reset-password", {
          data: { token: mail.token, password: "Replacement-123" },
          expected: 400,
        });
        run(
          "UPDATE account_tokens SET expires=0 WHERE hash=?",
          mail.row.token_hash,
        );
        await request("/auth/verify-email", {
          data: { token: mail.token },
          expected: 400,
        });
        await request("/auth/verify-email", {
          data: { token: "invalid" },
          expected: 400,
        });
        assert(!account.isVerified(u.id));
        assert(
          await passwordMatches(
            u.password,
            one("SELECT password FROM users WHERE id=?", u.id).password,
          ),
        );
      },
    );
    await t.test(
      "resend replaces previous verification token and enforces cooldown",
      async () => {
        const u = await register(),
          old = latest(u.id, "verify");
        await request("/auth/verification/resend", {
          method: "POST",
          cookie: u.cookie,
        });
        const next = latest(u.id, "verify");
        assert.notEqual(old.token, next.token);
        await request("/auth/verify-email", {
          data: { token: old.token },
          expected: 400,
        });
        await request("/auth/verification/resend", {
          method: "POST",
          cookie: u.cookie,
          expected: 429,
        });
        assert.equal(
          one("SELECT state FROM account_mail WHERE id=?", old.row.id).state,
          "cancelled",
        );
      },
    );
    await t.test(
      "forgot-password does not disclose existence and throttles per email",
      async () => {
        const u = await register();
        const a = await request("/auth/forgot-password", {
            data: { email: u.email },
          }),
          b = await request("/auth/forgot-password", {
            data: { email: "missing@example.test" },
          });
        assert.deepEqual(a.value, b.value);
        for (let i = 0; i < 4; i++)
          assert.deepEqual(
            (
              await request("/auth/forgot-password", {
                data: { email: u.email },
              })
            ).value,
            a.value,
          );
        assert.equal(
          one(
            "SELECT count(*) n FROM account_mail WHERE user_id=? AND token_hash IN (SELECT hash FROM account_tokens WHERE kind='reset')",
            u.id,
          ).n,
          1,
        );
        assert.equal(
          one("SELECT count(*) n FROM account_mail WHERE user_id=?", u.id).n,
          4,
        );
        assert.equal(
          one("SELECT password FROM users WHERE id=?", u.id).password.includes(
            u.password,
          ),
          false,
        );
      },
    );
    await t.test(
      "reset changes password, verifies email and revokes every session and OAuth state",
      async () => {
        run("DELETE FROM account_rate_limits");
        const u = await register();
        const second = await request("/auth/login", {
          data: { email: u.email, password: u.password },
        });
        run(
          "INSERT INTO oauth_states VALUES(?,?,?,?,?,?)",
          "fixture",
          u.id,
          "youtube",
          "nonce",
          "encrypted-fixture",
          Date.now() + 10000,
        );
        await request("/auth/forgot-password", { data: { email: u.email } });
        const mail = latest(u.id, "reset");
        await request("/auth/reset-password", {
          data: { token: mail.token, password: "short" },
          expected: 400,
        });
        await request("/auth/reset-password", {
          data: { token: mail.token, password: "New-Test-Password-456" },
        });
        for (const cookie of [u.cookie, second.cookie])
          await request("/auth/me", { cookie, expected: 401 });
        assert.equal(
          one("SELECT count(*) n FROM oauth_states WHERE user_id=?", u.id).n,
          0,
        );
        assert.equal(
          one("SELECT count(*) n FROM account_tokens WHERE user_id=?", u.id).n,
          0,
        );
        await request("/auth/login", {
          data: { email: u.email, password: u.password },
          expected: 401,
        });
        const login = await request("/auth/login", {
          data: { email: u.email, password: "New-Test-Password-456" },
        });
        assert.equal(
          (await request("/auth/me", { cookie: login.cookie })).value
            .verification.verified,
          true,
        );
        await request("/auth/reset-password", {
          data: { token: mail.token, password: "Another-Test-Password" },
          expected: 400,
        });
      },
    );
    await t.test(
      "simultaneous resets consume a token exactly once",
      async () => {
        const u = await register();
        await request("/auth/forgot-password", { data: { email: u.email } });
        const { token } = latest(u.id, "reset");
        const results = await Promise.allSettled([
          account.resetPassword(token, "Race-Test-Password-A"),
          account.resetPassword(token, "Race-Test-Password-B"),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      },
    );
    await t.test(
      "legacy accounts are not silently grandfathered as verified",
      async () => {
        const id = randomUUID();
        run(
          "INSERT INTO users VALUES(?,?,?,?,?)",
          id,
          "legacy@example.test",
          "Legacy",
          "existing-hash",
          Date.now() - 86400000,
        );
        assert.deepEqual(account.accountStatus(id), {
          verified: false,
          required: true,
          emailConfigured: true,
        });
      },
    );
    await t.test(
      "mail worker retries with a stable idempotency key, recovers and clears sensitive payloads",
      async () => {
        run("UPDATE account_mail SET state='cancelled',payload=NULL");
        const u = await register(),
          mail = latest(u.id, "verify");
        let calls = [];
        const failed = async (payload, id) => {
          calls.push(id);
          assert(payload.text.includes(mail.token));
          throw Error("transient");
        };
        await account.processAccountMail(failed);
        assert.equal(
          one("SELECT state FROM account_mail WHERE id=?", mail.row.id).state,
          "pending",
        );
        const due = one(
          "SELECT next_run FROM account_mail WHERE id=?",
          mail.row.id,
        ).next_run;
        run("UPDATE account_mail SET state='sending' WHERE id=?", mail.row.id);
        account.recoverAccountMail();
        await account.processAccountMail(async (payload, id) => {
          calls.push(id);
        }, due);
        assert.deepEqual(calls, [mail.row.id, mail.row.id]);
        assert.equal(
          one("SELECT state FROM account_mail WHERE id=?", mail.row.id).state,
          "sent",
        );
        assert.equal(
          one("SELECT payload FROM account_mail WHERE id=?", mail.row.id)
            .payload,
          null,
        );
      },
    );
    await t.test(
      "provider failures stop after bounded retries and expired messages are not sent",
      async () => {
        run("UPDATE account_mail SET state='cancelled',payload=NULL");
        const u = await register(),
          mail = latest(u.id, "verify");
        for (let i = 0; i < 5; i++) {
          const due = one(
            "SELECT next_run FROM account_mail WHERE id=?",
            mail.row.id,
          ).next_run;
          await account.processAccountMail(async () => {
            throw Error("provider down");
          }, due);
        }
        assert.equal(
          one("SELECT state FROM account_mail WHERE id=?", mail.row.id).state,
          "failed",
        );
        assert.equal(
          one("SELECT payload FROM account_mail WHERE id=?", mail.row.id)
            .payload,
          null,
        );
        account.queueAccountEmail({ id: u.id, email: u.email }, "reset");
        let sent = false;
        await account.processAccountMail(async () => {
          sent = true;
        }, Date.now() + 1800001);
        assert.equal(sent, false);
      },
    );
    await t.test(
      "Resend adapter uses fixed HTTPS endpoint, timeout and idempotency without logging payload",
      async () => {
        const original = globalThis.fetch;
        try {
          globalThis.fetch = async (url, options) => {
            assert.equal(url, "https://api.resend.com/emails");
            assert.equal(options.headers["Idempotency-Key"], "account-fixture");
            assert.equal(options.redirect, "error");
            assert(options.signal);
            return Response.json({ id: "sent-fixture" });
          };
          await account.sendResend(
            { to: ["fixture@example.test"], text: "fixture" },
            "fixture",
          );
          globalThis.fetch = async () =>
            Response.json({ error: "no" }, { status: 429 });
          await assert.rejects(
            account.sendResend({}, "fixture"),
            /did not accept/,
          );
        } finally {
          globalThis.fetch = original;
        }
      },
    );
    await t.test(
      "CSRF and persistent IP throttling protect public account mutations",
      async () => {
        run("DELETE FROM account_rate_limits");
        await request("/auth/forgot-password", {
          data: { email: "missing@example.test" },
          headers: { Origin: "https://evil.test" },
          expected: 403,
        });
        assert.equal(one("SELECT count(*) n FROM account_rate_limits").n, 0);
        for (let i = 0; i < 30; i++)
          await request("/auth/forgot-password", {
            data: { email: "missing@example.test" },
          });
        await request("/auth/forgot-password", {
          data: { email: "missing@example.test" },
          expected: 429,
        });
        run("DELETE FROM account_rate_limits");
      },
    );
    await t.test(
      "missing mail configuration fails honestly and production cannot disable verification",
      async () => {
        const saved = process.env.RESEND_API_KEY;
        process.env.RESEND_API_KEY = "";
        try {
          await request("/auth/forgot-password", {
            data: { email: "missing@example.test" },
            expected: 503,
          });
          await request("/auth/register", {
            data: {
              name: "No mail",
              email: "nomail@example.test",
              password: "Test-Password-123",
            },
            expected: 503,
          });
          assert(
            !one("SELECT id FROM users WHERE email=?", "nomail@example.test"),
          );
          const child = spawnSync(
            process.execPath,
            ["--input-type=module", "-e", "await import('./lib/config.mjs')"],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                NODE_ENV: "production",
                BILLING_REQUIRED: "true",
                EMAIL_VERIFICATION_REQUIRED: "false",
              },
              encoding: "utf8",
              windowsHide: true,
            },
          );
          assert.notEqual(child.status, 0);
          assert.match(child.stderr, /RESEND_API_KEY/);
        } finally {
          process.env.RESEND_API_KEY = saved;
        }
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
