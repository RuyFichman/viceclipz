import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
process.env.DATA_DIR = path.resolve(
  ".test-data-templates-unit-" + randomUUID(),
);
process.env.NODE_ENV = "test";
process.env.APP_ORIGIN = "https://studio.example.test";
process.env.RESEND_API_KEY = "";
process.env.EMAIL_FROM = "";
process.env.EMAIL_VERIFICATION_REQUIRED = "false";
// Billing on without a subscription: every account is on the free plan (10 exports).
process.env.BILLING_REQUIRED = "true";
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.ANTHROPIC_API_KEY = "";
process.env.PHRASE_AI_MONTHLY_LIMIT = "3";
// A database created by the previous release, before templates existed.
const legacyUser = randomUUID(),
  legacyAsset = randomUUID(),
  legacyProject = randomUUID(),
  legacyJob = randomUUID(),
  legacyData = {
    version: 1,
    name: "Projeto antigo",
    headline: "Headline",
    assetId: legacyAsset,
    template: "neon",
    format: "9:16",
    start: 0,
    end: 2,
    fontSize: 42,
    position: "bottom",
    fit: "cover",
    mute: false,
    date: "",
    variants: [],
  };
mkdirSync(process.env.DATA_DIR, { recursive: true });
const legacy = new DatabaseSync(
  path.join(process.env.DATA_DIR, "viceclipz.sqlite"),
);
legacy.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE assets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,size INTEGER NOT NULL,duration REAL NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,has_audio INTEGER NOT NULL,created INTEGER NOT NULL);
CREATE TABLE projects(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated INTEGER NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL,state TEXT NOT NULL,progress INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,size INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
PRAGMA user_version=1;`);
legacy
  .prepare("INSERT INTO users VALUES(?,?,?,?,?)")
  .run(legacyUser, "legacy@example.test", "Legado", "not-a-login-hash", 1);
legacy
  .prepare("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)")
  .run(legacyAsset, legacyUser, "antigo.mp4", 1000, 8, 640, 360, 1, 1);
legacy
  .prepare("INSERT INTO projects VALUES(?,?,?,?,?)")
  .run(legacyProject, legacyUser, JSON.stringify(legacyData), 3, 1);
legacy
  .prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(
    legacyJob,
    legacyUser,
    legacyProject,
    "f",
    JSON.stringify(legacyData),
    "done",
    100,
    1,
    null,
    500,
    1,
    2,
  );
legacy.close();
const { db, run, one, ASSET_SELECT } = await import("../lib/db.mjs");
const { api, json } = await import("../lib/api.mjs");
const { createSession } = await import("../lib/auth.mjs");
const ai = await import("../lib/phrase-ai.mjs");
const { variationArgs, renderOverlay } =
  await import("../lib/template-render.mjs");
const { buildVariations, validateTemplate } =
  await import("../lib/template-spec.mjs");
const core = await import("../dist/template-core.js");
const format = await import("../dist/format.js");
const Anthropic = (await import("@anthropic-ai/sdk")).default;
const server = createServer(async (req, res) => {
  try {
    await api(req, res, new URL(req.url, process.env.APP_ORIGIN), true);
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;
function account(name) {
  const id = randomUUID();
  run(
    "INSERT INTO users VALUES(?,?,?,?,?)",
    id,
    id + "@example.test",
    name,
    "not-a-login-hash",
    Date.now(),
  );
  let cookie;
  createSession({ setHeader: (k, v) => (cookie = v.split(";")[0]) }, id);
  return { id, cookie };
}
function asset(userId, kind, duration = 10) {
  const id = randomUUID();
  run(
    "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)",
    id,
    userId,
    kind === "image" ? "foto.png" : "clipe.mp4",
    1000,
    kind === "image" ? 0 : duration,
    kind === "image" ? 400 : 1280,
    kind === "image" ? 400 : 720,
    kind === "image" ? 0 : 1,
    Date.now(),
  );
  if (kind === "image")
    run("INSERT INTO asset_kinds VALUES(?,?,?)", id, "image", "image/png");
  return id;
}
async function call(who, route, { method = "GET", data, expected = 200 } = {}) {
  const response = await fetch(base + "/api" + route, {
    method,
    headers: {
      Cookie: who.cookie,
      "X-ViceClipz": "studio",
      Origin: process.env.APP_ORIGIN,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const value = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${route}: ${JSON.stringify(value)}`,
  );
  return value;
}
// Template with `videos` options in its only zone and `phrases` phrases, all selected.
function template(videos, phrases) {
  const t = core.defaultTemplate("post", "Teste");
  t.profile.handle = "teste";
  const slot = core.slotList(t)[0];
  t.media[slot.id] = videos.map((assetId, i) => ({
    id: "v" + i,
    assetId,
    start: 0,
    end: 2,
    zoom: 1,
    x: 50,
    y: 50,
  }));
  t.selection.media[slot.id] = t.media[slot.id].map((o) => o.id);
  t.phrases = Array.from({ length: phrases }, (_, i) => ({
    id: "p" + i,
    text: "Frase " + i,
    auto: false,
  }));
  t.selection.phrases = t.phrases.map((p) => p.id);
  return t;
}
await test("Templates: migração, validação, cotas de lote, presets salvos e frases automáticas", async (t) => {
  try {
    await t.test(
      "banco anterior recebe colunas novas sem perder dados",
      async () => {
        assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
        const columns = (table) =>
          db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((c) => c.name);
        for (const c of ["batch_id", "item_index", "reserve", "started", "crc"])
          assert(columns("jobs").includes(c));
        // `assets` keeps the previous release's columns so a rollback can still
        // insert positionally; kinds live in asset_kinds and default to video.
        assert.deepEqual(columns("assets").length, 9);
        assert.deepEqual(columns("asset_kinds"), ["asset_id", "kind", "mime"]);
        const rollbackInsert = randomUUID();
        run(
          "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)",
          rollbackInsert,
          legacyUser,
          "depois.mp4",
          1,
          1,
          2,
          2,
          0,
          Date.now(),
        );
        run("DELETE FROM assets WHERE id=?", rollbackInsert);
        const owner = { id: legacyUser, cookie: "" };
        createSession(
          { setHeader: (k, v) => (owner.cookie = v.split(";")[0]) },
          legacyUser,
        );
        const project = await call(owner, "/projects/" + legacyProject);
        assert.equal(project.name, "Projeto antigo");
        assert.equal(project.revision, 3);
        const updated = await call(owner, "/projects/" + legacyProject, {
          method: "PUT",
          data: { ...project, headline: "Editado depois da migração" },
        });
        assert.equal(updated.revision, 4);
        assert.equal((await call(owner, "/assets"))[0].kind, "video");
        const jobs = await call(owner, "/jobs");
        assert.equal(jobs[0].state, "done");
        assert.equal(jobs[0].batchId, null);
        await call(owner, "/projects/" + legacyProject, {
          method: "PUT",
          data: { ...updated, kind: "template" },
          expected: 409,
        });
      },
    );
    await t.test(
      "validação rejeita estrutura, tipos e textos fora dos limites",
      async () => {
        const user = account("Validação"),
          video = asset(user.id, "video"),
          image = asset(user.id, "image");
        const good = template([video], 1);
        await call(user, "/projects", {
          method: "POST",
          data: good,
          expected: 201,
        });
        const slot = core.slotList(good)[0];
        for (const bad of [
          { ...good, format: "1:1" },
          { ...good, zones: [] },
          { ...good, zones: Array.from({ length: 5 }, () => good.zones[0]) },
          { ...good, style: { ...good.style, font: "comic-sans" } },
          { ...good, style: { ...good.style, color: "red" } },
          { ...good, profile: { ...good.profile, handle: "com espaço" } },
          {
            ...good,
            phrases: [{ id: "p0", text: "x".repeat(281), auto: false }],
          },
          { ...good, media: { [slot.id]: [{ id: "a", assetId: image }] } },
          {
            ...good,
            media: {
              [slot.id]: [{ id: "a", assetId: video, start: 1, end: 30 }],
            },
          },
          {
            ...good,
            media: { [slot.id]: [{ id: "a", assetId: video, zoom: 4 }] },
          },
          {
            ...good,
            selection: { media: { [slot.id]: ["missing"] }, phrases: [] },
          },
        ])
          await call(user, "/projects", {
            method: "POST",
            data: bad,
            expected: 400,
          });
        const emojiFree = validateTemplate(
          {
            ...good,
            phrases: [
              {
                id: "p0",
                text: "  linha 1\r\n\r\n\r\nlinha\u0007 2  ",
                auto: false,
              },
            ],
          },
          (id) => one(ASSET_SELECT + " WHERE a.id=?", id),
        );
        assert.equal(emojiFree.phrases[0].text, "linha 1\n\nlinha 2");
        await call(user, "/templates/preview", {
          method: "POST",
          data: { ...good, phrase: "x".repeat(300) },
          expected: 400,
        });
      },
    );
    await t.test(
      "geometria e filtergraph usam vstack, hstack, blur e duração do vídeo principal",
      () => {
        let spec = core.applyPreset(
          core.defaultTemplate("viral", "A"),
          "video-images",
        );
        spec = { ...spec, background: "blur" };
        const slots = core.slotList(spec);
        const cells = {};
        for (const s of slots)
          cells[s.id] =
            s.type === "video"
              ? {
                  type: "video",
                  assetId: "a",
                  start: 1,
                  end: 3.5,
                  zoom: 1.2,
                  x: 10,
                  y: 90,
                }
              : { type: "image", assetId: "b", zoom: 1, x: 50, y: 50 };
        const variation = {
          ...spec,
          kind: "variation",
          primary: slots[0].id,
          cells,
          phrase: "Uma frase",
          duration: 2.5,
        };
        const { layout } = renderOverlay(variation, variation.phrase);
        const sources = Object.fromEntries(
          slots.map((s) => [
            s.id,
            {
              path: s.id + ".media",
              width: s.type === "video" ? 1920 : 800,
              height: s.type === "video" ? 1080 : 600,
            },
          ]),
        );
        const args = variationArgs({
            spec: variation,
            layout,
            sources,
            overlay: "o.png",
            output: "out.mp4",
          }),
          graph = args[args.indexOf("-filter_complex") + 1];
        assert.match(graph, /hstack=inputs=2/);
        assert.match(graph, /boxblur=4:2/);
        assert.match(graph, /tpad=stop_mode=clone/);
        assert.equal(args[args.indexOf("-t", args.indexOf("[v]")) + 1], "2.5");
        assert.deepEqual(
          args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4),
          ["-ss", "1", "-t", "2.500"],
        );
        for (const zone of layout.zones)
          for (const cell of zone.cells)
            assert.equal((cell.width % 2) + (cell.height % 2), 0);
        const stacked = core.applyPreset(
            core.defaultTemplate("post", "A"),
            "stacked",
          ),
          two = core.slotList(stacked),
          twoCells = Object.fromEntries(
            two.map((s, i) => [
              s.id,
              {
                type: "video",
                assetId: "a",
                start: 0,
                end: i ? 1 : 2,
                zoom: 1,
                x: 50,
                y: 50,
              },
            ]),
          );
        const v2 = {
            ...stacked,
            kind: "variation",
            primary: two[0].id,
            cells: twoCells,
            phrase: "x",
            duration: 2,
          },
          out2 = variationArgs({
            spec: v2,
            layout: renderOverlay(v2, "x").layout,
            sources: Object.fromEntries(
              two.map((s) => [s.id, { path: "f", width: 640, height: 360 }]),
            ),
            overlay: "o",
            output: "p",
          });
        assert.match(
          out2[out2.indexOf("-filter_complex") + 1],
          /vstack=inputs=2/,
        );
        // The secondary video is read for its own trim and then holds its last frame.
        assert.deepEqual(
          out2.slice(out2.lastIndexOf("-ss"), out2.lastIndexOf("-ss") + 4),
          ["-ss", "0", "-t", "1.000"],
        );
      },
    );
    await t.test(
      "placement do preview coincide com o recorte enviado ao FFmpeg",
      () => {
        const p = core.placement(1920, 1080, 720, 640, "cover", 2, 25, 75);
        assert(Math.abs(p.width - 1920 * p.scale) < 1e-9);
        assert(p.x <= 0 && p.y <= 0);
        assert(Math.abs(p.source.x * p.scale + p.x) < 1e-6);
        assert(Math.abs(p.source.width * p.scale - 720) < 1e-6);
        const contain = core.placement(
          1920,
          1080,
          720,
          1280,
          "contain",
          1,
          50,
          50,
        );
        assert.equal(contain.visible.width, 720);
        assert(Math.abs(contain.visible.y - (1280 - 405) / 2) < 1e-6);
      },
    );
    await t.test(
      "lote reserva uma exportação por item, respeita o plano e não conta retentativa duas vezes",
      async () => {
        const user = account("Cotas"),
          videos = [asset(user.id, "video"), asset(user.id, "video")];
        const big = await call(user, "/projects", {
          method: "POST",
          data: template(videos, 6),
          expected: 201,
        });
        const tooMany = await call(user, `/templates/${big.id}/batches`, {
          method: "POST",
          data: { requestKey: randomUUID(), revision: big.revision },
          expected: 403,
        });
        assert.match(tooMany.error, /12 exportações e restam 10/);
        const huge = await call(user, "/projects", {
          method: "POST",
          data: template(videos, 26),
          expected: 201,
        });
        await call(user, `/templates/${huge.id}/batches`, {
          method: "POST",
          data: { requestKey: randomUUID(), revision: huge.revision },
          expected: 400,
        });
        const small = await call(user, "/projects", {
          method: "POST",
          data: template(videos, 4),
          expected: 201,
        });
        await call(user, `/templates/${small.id}/batches`, {
          method: "POST",
          data: { requestKey: randomUUID(), revision: small.revision - 1 },
          expected: 409,
        });
        const batch = await call(user, `/templates/${small.id}/batches`, {
          method: "POST",
          data: { requestKey: randomUUID(), revision: small.revision },
          expected: 202,
        });
        assert.equal(batch.total, 8);
        assert.equal((await call(user, "/templates/limits")).renders.used, 8);
        assert.equal(
          one(
            "SELECT count(*) n FROM jobs WHERE batch_id=? AND reserve<104857600",
            batch.id,
          ).n,
          8,
        );
        const items = (await call(user, "/batches/" + batch.id)).items;
        assert.deepEqual(
          items.map((i) => i.index),
          [1, 2, 3, 4, 5, 6, 7, 8],
        );
        assert(items.every((i) => i.position >= 1 && i.eta === null));
        const second = await call(user, "/projects", {
          method: "POST",
          data: template([videos[0]], 3),
          expected: 201,
        });
        await call(user, `/templates/${second.id}/batches`, {
          method: "POST",
          data: { requestKey: randomUUID(), revision: second.revision },
          expected: 403,
        });
        await call(user, `/jobs/${items[0].id}/cancel`, { method: "POST" });
        assert.equal((await call(user, "/templates/limits")).renders.used, 7);
        await call(user, `/jobs/${items[0].id}/retry`, {
          method: "POST",
          expected: 202,
        });
        await call(user, `/jobs/${items[0].id}/retry`, {
          method: "POST",
          expected: 409,
        });
        assert.equal((await call(user, "/templates/limits")).renders.used, 8);
        await call(user, `/batches/${batch.id}/cancel`, { method: "POST" });
        assert.equal((await call(user, "/templates/limits")).renders.used, 0);
        const retried = await call(user, `/batches/${batch.id}/retry`, {
          method: "POST",
          expected: 202,
        });
        assert.equal(
          retried.items.filter((i) => i.state === "queued").length,
          8,
        );
        assert.equal((await call(user, "/templates/limits")).renders.used, 8);
        await call(user, `/batches/${batch.id}`, {
          method: "DELETE",
          expected: 409,
        });
        await call(user, `/projects/${small.id}`, {
          method: "DELETE",
          expected: 409,
        });
        await call(user, `/batches/${batch.id}/cancel`, { method: "POST" });
        await call(user, `/batches/${batch.id}/archive`, { expected: 409 });
        await call(user, `/projects/${small.id}`, { method: "DELETE" });
        assert.equal(
          one("SELECT count(*) n FROM batches WHERE id=?", batch.id).n,
          0,
        );
        const other = account("Intrusa");
        await call(other, `/templates/${big.id}/batches`, {
          method: "POST",
          data: { requestKey: randomUUID(), revision: big.revision },
          expected: 404,
        });
        await call(other, `/batches?projectId=${big.id}`, { expected: 404 });
      },
    );
    await t.test(
      "perfis e estilos salvos são privados, limitados e protegem o avatar",
      async () => {
        const user = account("Presets"),
          other = account("Outra"),
          avatar = asset(user.id, "image"),
          base = core.defaultTemplate("post", "Teste");
        const saved = await call(user, "/profiles", {
          method: "POST",
          data: {
            name: "Principal",
            data: { ...base.profile, avatarAssetId: avatar },
          },
          expected: 201,
        });
        assert.equal(saved.data.avatarAssetId, avatar);
        const again = await call(user, "/profiles", {
          method: "POST",
          data: { name: "Principal", data: { ...base.profile, nameSize: 40 } },
        });
        assert.equal(again.id, saved.id);
        assert.equal(again.data.nameSize, 40);
        await call(other, "/profiles", {
          method: "POST",
          data: {
            name: "Roubo",
            data: { ...base.profile, avatarAssetId: avatar },
          },
          expected: 404,
        });
        assert.equal((await call(other, "/profiles")).length, 0);
        await call(other, "/profiles/" + saved.id, {
          method: "DELETE",
          expected: 404,
        });
        await call(user, "/styles", {
          method: "POST",
          data: { name: "Bold", data: { ...base.style, font: "unknown" } },
          expected: 400,
        });
        for (let i = 0; i < 20; i++)
          await call(user, "/styles", {
            method: "POST",
            data: { name: "Estilo " + i, data: base.style },
            expected: 201,
          });
        await call(user, "/styles", {
          method: "POST",
          data: { name: "Excedente", data: base.style },
          expected: 409,
        });
        await call(user, "/profiles", {
          method: "POST",
          data: {
            name: "Com avatar",
            data: { ...base.profile, avatarAssetId: avatar },
          },
          expected: 201,
        });
        await call(user, "/assets/" + avatar, {
          method: "DELETE",
          expected: 409,
        });
      },
    );
    await t.test(
      "frases automáticas: indisponível sem configuração, saída validada e limite mensal",
      async () => {
        const user = account("Frases");
        const limits = await call(user, "/templates/limits");
        assert.equal(limits.ai.configured, false);
        assert.match(limits.ai.reason, /não está configurada/);
        await call(user, "/phrases/generate", {
          method: "POST",
          data: { description: "Bastidores do podcast", count: 3 },
          expected: 503,
        });
        let seen;
        ai.setPhraseProvider({
          async generate(input) {
            seen = input;
            return [
              "“POV: bastidores do podcast”",
              "POV: bastidores do podcast",
              "#tag #outra",
              "x".repeat(300),
              42,
              "Linha\ncom quebra",
              "Mais uma",
            ];
          },
        });
        await call(user, "/phrases/generate", {
          method: "POST",
          data: { description: "curta", count: 3 },
          expected: 400,
        });
        await call(user, "/phrases/generate", {
          method: "POST",
          data: { description: "Bastidores do podcast", count: 11 },
          expected: 400,
        });
        const result = await call(user, "/phrases/generate", {
          method: "POST",
          data: { description: "Bastidores do podcast de finanças", count: 3 },
        });
        assert.deepEqual(seen, {
          description: "Bastidores do podcast de finanças",
          count: 3,
        });
        assert.deepEqual(result.phrases, [
          "POV: bastidores do podcast",
          "Linha com quebra",
          "Mais uma",
        ]);
        assert.equal(result.remaining, 2);
        await call(user, "/phrases/generate", {
          method: "POST",
          data: { description: "Bastidores do podcast de finanças", count: 3 },
          expected: 429,
        });
        const capped = account("Limite");
        for (let i = 0; i < 3; i++)
          run(
            "INSERT INTO ai_requests VALUES(?,?,?,?)",
            randomUUID(),
            capped.id,
            new Date().toISOString().slice(0, 7),
            Date.now(),
          );
        const denied = await call(capped, "/phrases/generate", {
          method: "POST",
          data: { description: "Bastidores do podcast", count: 3 },
          expected: 429,
        });
        assert.match(denied.error, /3 gerações automáticas/);
        ai.setPhraseProvider({ generate: async () => ["", "   "] });
        const empty = account("Vazio");
        await call(empty, "/phrases/generate", {
          method: "POST",
          data: { description: "Bastidores do podcast", count: 3 },
          expected: 502,
        });
        assert.equal((await call(empty, "/templates/limits")).ai.remaining, 3);
        ai.setPhraseProvider(null);
      },
    );
    await t.test(
      "adaptador Anthropic: pedido estruturado, recusa e erros sem registrar conteúdo",
      async () => {
        const requests = [],
          logged = [],
          original = console.error;
        const fake = (response) => ({
          beta: {
            messages: {
              create: async (params) => {
                requests.push(params);
                if (response instanceof Error) throw response;
                return response;
              },
            },
          },
        });
        console.error = (...args) => logged.push(args.join(" "));
        try {
          const secret = "Ideia confidencial do criador 123";
          const phrases = await ai
            .anthropicProvider(
              fake({
                stop_reason: "end_turn",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ phrases: ["Uma", "Duas"] }),
                  },
                ],
              }),
            )
            .generate({ description: secret, count: 2 });
          assert.deepEqual(phrases, ["Uma", "Duas"]);
          const sent = requests[0];
          assert.equal(sent.model, "claude-opus-5-5");
          assert.equal(sent.fallbacks, "default");
          assert.deepEqual(sent.betas, ["server-side-fallback-2026-07-01"]);
          assert.equal(sent.output_config.format.type, "json_schema");
          assert.equal(sent.output_config.effort, "low");
          assert.match(sent.messages[0].content, /Ideia confidencial/);
          assert.match(sent.system, /Não invente fatos/);
          process.env.PHRASE_AI_MODEL = "claude-haiku-5-5";
          await ai
            .anthropicProvider(
              fake({
                stop_reason: "end_turn",
                content: [{ type: "text", text: "{}" }],
              }),
            )
            .generate({ description: secret, count: 2 });
          assert.equal(requests[1].fallbacks, undefined);
          delete process.env.PHRASE_AI_MODEL;
          await assert.rejects(
            ai
              .anthropicProvider(fake({ stop_reason: "refusal", content: [] }))
              .generate({ description: secret, count: 2 }),
            (e) => e.status === 422,
          );
          assert.deepEqual(
            await ai
              .anthropicProvider(
                fake({
                  stop_reason: "end_turn",
                  content: [{ type: "text", text: "não é json" }],
                }),
              )
              .generate({ description: secret, count: 2 }),
            [],
          );
          await assert.rejects(
            ai
              .anthropicProvider(
                fake(
                  new Anthropic.RateLimitError(
                    429,
                    { type: "error" },
                    "rate limited " + secret,
                    new Headers(),
                  ),
                ),
              )
              .generate({ description: secret, count: 2 }),
            (e) => e.status === 503,
          );
          await assert.rejects(
            ai
              .anthropicProvider(fake(new Error("socket hang up")))
              .generate({ description: secret, count: 2 }),
            (e) => e.status === 502,
          );
          assert.equal(logged.length, 2);
          assert(
            logged.every(
              (line) =>
                !line.includes(secret) && !line.includes("rate limited"),
            ),
          );
        } finally {
          console.error = original;
        }
      },
    );
    await t.test(
      "interface: IDs únicos, números em pt-BR e uso do plano na sessão",
      async () => {
        // The classic editor and the builder once shared trim-start/trim-end,
        // so the editor read and saved the builder's sliders.
        const ids = [
          ...readFileSync("dist/index.html", "utf8").matchAll(
            /\sid="([^"]+)"/g,
          ),
        ].map((m) => m[1]);
        const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
        assert.deepEqual(repeated, []);
        assert.equal(format.bytes(512), "512 B");
        assert.equal(format.bytes(20659), "20 KB");
        assert.equal(format.bytes(5.5 * 1024 ** 2), "5,5 MB");
        assert.equal(format.bytes(2 * 1024 ** 3), "2 GB");
        assert.equal(format.seconds(2.44), "2,4 s");
        assert.equal(format.seconds(6), "6 s");
        assert.equal(
          format.plural(1, "exportação", "exportações"),
          "1 exportação",
        );
        assert.equal(
          format.plural(10, "exportação", "exportações"),
          "10 exportações",
        );
        assert.equal(format.day("2026-10-27"), "27/10/2026");
        const who = account("Plano");
        const me = await call(who, "/auth/me");
        assert.deepEqual(me.plan, { key: "free", name: "Grátis", renders: 10 });
        assert.equal(me.rendersUsed, 0);
        assert.equal(me.storageLimit, 2 * 1024 ** 3);
      },
    );
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});
