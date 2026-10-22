import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createServer } from "node:http";
process.env.DATA_DIR = path.resolve(".test-data-discovery-" + randomUUID());
process.env.NODE_ENV = "test";
process.env.APP_ORIGIN = "https://studio.example.test";
process.env.BILLING_REQUIRED = "false";
delete process.env.RESEND_API_KEY;
process.env.EMAIL_VERIFICATION_REQUIRED = "false";
const { publicURL, publicIP, resolvePublic, createReader } =
  await import("../lib/discovery-fetch.mjs");
const { collect, parsePage, discoveryAPI, metrics } =
  await import("../lib/discovery.mjs");
const { api, json, fail } = await import("../lib/api.mjs");
const { run, one, db } = await import("../lib/db.mjs");
const { createSession } = await import("../lib/auth.mjs");
const user = { id: randomUUID() },
  other = { id: randomUUID() };
for (const u of [user, other])
  run(
    "INSERT INTO users VALUES(?,?,?,?,?)",
    u.id,
    u.id + "@example.test",
    "QA",
    "unused",
    Date.now(),
  );
const fixture = {
  url: "https://example.com/story",
  provider: "site",
  title: "Título ".repeat(20),
  description: "Descrição",
  author: "Autora",
};
const helpers = {
  body: async (req) => req.data,
  json: (_res, status, data) => ({ status, data }),
  fail,
};
async function call(
  route,
  method = "GET",
  data,
  who = user,
  collector = async () => [fixture],
) {
  let result;
  const used = await discoveryAPI(
    { method, data },
    {},
    new URL("https://studio.example.test/api" + route),
    who,
    {
      ...helpers,
      json: (_res, status, value) => {
        result = { status, value };
      },
    },
    collector,
  );
  assert(used);
  return result;
}
test("URLs and DNS reject local, encoded, reserved and mixed destinations", async () => {
  for (const url of [
    "http://example.com",
    "https://localhost",
    "https://127.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://user:pass@example.com",
    "https://example.com:444",
    "https://[::1]",
    "file:///a",
  ])
    assert.throws(() => publicURL(url));
  for (const ip of [
    "127.0.0.1",
    "10.1.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    assert.equal(publicIP(ip), false, ip);
  assert.equal(publicIP("8.8.8.8"), true);
  await assert.rejects(
    resolvePublic("example.com", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]),
  );
});
test("reader pins resolved address, respects robots and checks redirects before connecting", async () => {
  const calls = [];
  const resolver = async () => [{ address: "8.8.8.8", family: 4 }];
  let mode = "ok";
  const read = createReader({
    resolver,
    send: async (url, address) => {
      calls.push(url.href);
      assert.equal(address.address, "8.8.8.8");
      if (url.pathname === "/robots.txt")
        return {
          status: 200,
          headers: {},
          text:
            mode === "deny"
              ? "User-agent: ViceClipzBot\nDisallow: /"
              : "User-agent: *\nAllow: /",
        };
      return mode === "redirect"
        ? {
            status: 302,
            headers: { location: "https://127.0.0.1/private" },
            text: "",
          }
        : {
            status: 200,
            headers: { "content-type": "text/html" },
            text: "<title>OK</title>",
          };
    },
  });
  assert.match((await read("https://example.com/page")).text, /OK/);
  mode = "deny";
  await assert.rejects(read("https://example.com/page"), /não permite/);
  mode = "redirect";
  await assert.rejects(read("https://example.com/page"), /privada/);
  assert(!calls.some((url) => url.includes("127.0.0.1")));
  await assert.rejects(
    read("https://example.com/page", {
      official: true,
      headers: { Authorization: "Bearer test" },
    }),
    /redirecionou/,
  );
});
test("robots errors fail closed and unsupported content is rejected", async () => {
  const read = createReader({
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    send: async () => ({ status: 503, headers: {}, text: "" }),
  });
  await assert.rejects(read("https://example.com"), /não permite/);
  assert.throws(() => parsePage("binary", "https://example.com", "video/mp4"));
});
test("HTML and feeds extract bounded text without scripts or unsafe links", () => {
  const [page] = parsePage(
    '<title>Fallback</title><meta property="og:title" content="A &amp; B"><meta name="description" content="' +
      "a".repeat(900) +
      '"><script>alert(1)</script>',
    "https://example.com/",
    "text/html",
  );
  assert.equal(page.title, "A & B");
  assert.equal(page.description.length, 300);
  assert(!JSON.stringify(page).includes("alert"));
  const rows = parsePage(
    "<rss><channel><item><title>Story</title><link>https://example.com/item</link><description>&lt;b&gt;Summary&lt;/b&gt;</description></item><item><title>Bad</title><link>javascript:alert(1)</link></item></channel></rss>",
    "https://example.com/feed",
    "application/rss+xml",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, "Summary");
  const atom = parsePage(
    '<feed><entry><title>Atom</title><link rel="alternate" href="/story"/></entry></feed>',
    "https://example.com/feed",
    "application/atom+xml",
  );
  assert.equal(atom[0].url, "https://example.com/story");
});
test("Instagram then TikTok use official endpoints and never retain embed HTML", async () => {
  process.env.META_API_VERSION = "v25.0";
  process.env.META_OEMBED_ACCESS_TOKEN = "fake-only";
  const calls = [];
  const reader = async (url, options) => {
    calls.push({ url, options });
    return {
      text: JSON.stringify({
        author_name: "Creator",
        title: "Public post",
        html: "<script>evil</script>",
      }),
    };
  };
  const ig = await collect(
    "https://www.instagram.com/reel/ABC/?utm_source=x",
    reader,
  );
  const tt = await collect(
    "https://www.tiktok.com/@creator/video/123456",
    reader,
  );
  assert(
    calls[0].url.startsWith(
      "https://graph.facebook.com/v25.0/instagram_oembed?",
    ),
  );
  assert(!calls[0].url.includes("fake-only"));
  assert.equal(calls[0].options.headers.Authorization, "Bearer fake-only");
  assert.deepEqual(calls[1].options.headers, {});
  assert.equal(ig[0].provider, "instagram");
  assert.equal(tt[0].provider, "tiktok");
  assert(!JSON.stringify([ig, tt]).includes("<script>"));
  await assert.rejects(collect("https://www.instagram.com/creator/", reader));
  await assert.rejects(collect("https://vm.tiktok.com/abc", reader));
  delete process.env.META_API_VERSION;
  await assert.rejects(
    collect("https://www.instagram.com/p/ABC/", reader),
    (e) => e.status === 503,
  );
  delete process.env.META_OEMBED_ACCESS_TOKEN;
});
test("reference collection persists, deduplicates, isolates owners and creates editable drafts", async () => {
  assert.equal(
    (await call("/discovery", "POST", { url: fixture.url })).value.added,
    1,
  );
  await assert.rejects(
    call("/discovery", "POST", { url: fixture.url }),
    (e) => e.status === 429,
  );
  run("DELETE FROM discovery_limits");
  assert.equal(
    (await call("/discovery", "POST", { url: fixture.url })).value.added,
    0,
  );
  const row = (await call("/discovery")).value[0];
  assert.equal(
    (await call("/discovery", "GET", undefined, other)).value.length,
    0,
  );
  await assert.rejects(
    call("/discovery/" + row.id, "DELETE", undefined, other),
    (e) => e.status === 404,
  );
  await assert.rejects(
    call("/discovery/" + row.id + "/project", "POST", {}, other),
    (e) => e.status === 404,
  );
  const draft = await call("/discovery/" + row.id + "/project", "POST", {});
  assert.equal(draft.status, 201);
  const project = JSON.parse(
    one("SELECT data FROM projects WHERE id=?", draft.value.id).data,
  );
  assert.equal(project.assetId, null);
  assert.equal(project.headline, "");
  assert(project.name.length <= 80);
  await call("/discovery/" + row.id, "DELETE");
  assert.equal((await call("/discovery")).value.length, 0);
});
test("failed collection releases concurrency and quotas remain bounded", async () => {
  run("DELETE FROM discovery_limits");
  await assert.rejects(
    call("/discovery", "POST", { url: fixture.url }, user, async () => {
      throw Error("secret provider failure");
    }),
    (e) => e.status === 502 && !e.message.includes("secret"),
  );
  run("DELETE FROM discovery_limits");
  for (let i = 0; i < 200; i++)
    run(
      "INSERT INTO discovery_items VALUES(?,?,?,?,?,?,?,?)",
      randomUUID(),
      user.id,
      fixture.url + "/" + i,
      "site",
      "test",
      "",
      "",
      Date.now(),
    );
  await assert.rejects(
    call("/discovery", "POST", { url: fixture.url }),
    (e) => e.status === 409,
  );
  run("DELETE FROM discovery_items WHERE user_id=?", user.id);
});
test("metrics are scoped and historical completions survive deleted exports", () => {
  run(
    "INSERT INTO usage_events VALUES(?,?,?,'completed',?)",
    randomUUID(),
    user.id,
    "2026-10",
    Date.now(),
  );
  run(
    "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)",
    randomUUID(),
    other.id,
    "private",
    5000,
    10,
    720,
    1280,
    1,
    Date.now(),
  );
  const result = metrics(user);
  assert.equal(result.assets, 0);
  assert.equal(result.storageBytes, 0);
  assert.equal(
    result.daily.reduce((n, row) => n + row.count, 0),
    1,
  );
  assert.equal(result.averageExportSeconds, null);
  assert.equal(metrics(other).daily.length, 0);
});
test("HTTP boundaries enforce sessions, CSRF and email verification for new endpoints", async () => {
  const server = createServer(async (req, res) => {
    try {
      await api(req, res, new URL(req.url, process.env.APP_ORIGIN), true);
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  let cookie;
  createSession(
    {
      setHeader: (_key, value) => {
        cookie = value.split(";")[0];
      },
    },
    user.id,
  );
  try {
    for (const route of ["discovery", "metrics"])
      assert.equal((await fetch(origin + "/api/" + route)).status, 401);
    assert.equal(
      (await fetch(origin + "/api/metrics", { headers: { Cookie: cookie } }))
        .status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + "/api/discovery", {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ url: fixture.url }),
        })
      ).status,
      403,
    );
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    assert.equal(
      (await fetch(origin + "/api/discovery", { headers: { Cookie: cookie } }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(origin + "/api/metrics", { headers: { Cookie: cookie } }))
        .status,
      403,
    );
  } finally {
    process.env.EMAIL_VERIFICATION_REQUIRED = "false";
    await new Promise((resolve) => server.close(resolve));
  }
});
test.after(() => db.close());
