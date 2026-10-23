import { createReadStream } from "node:fs";
import { open, rename, unlink, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DATA,
  ORIGIN,
  MAX_UPLOAD,
  STORAGE_LIMIT,
  EXPORT_RESERVE,
  MAX_EXPORT,
  assetPath,
  outputPath,
} from "./config.mjs";
import { one, all, run, usage, transaction, ASSET_SELECT } from "./db.mjs";
import {
  getUser,
  passwordHash,
  passwordMatches,
  createSession,
  logout,
  authAllowed,
  digest,
} from "./auth.mjs";
import { InputError, validateProject, overlay } from "./composition.mjs";
import { probe } from "./media.mjs";
import { imageSignature, normalizeImage } from "./images.mjs";
import { validateTemplate, referencedAssets } from "./template-spec.mjs";
import { templateAPI, MAX_ACTIVE } from "./template-api.mjs";
import { phraseAPI } from "./phrase-ai.mjs";
import { activeOperations, batchActive, reservedBytes } from "./queue.mjs";
import { publicLaunch, privateLaunch } from "./launch-api.mjs";
import { discoveryAPI } from "./discovery.mjs";
import {
  publicAccount,
  privateAccount,
  accountStatus,
  verificationRequired,
  isVerified,
  requireMail,
  queueAccountEmail,
} from "./account.mjs";
import {
  planFor,
  canRender,
  reserveRender,
  releaseRender,
} from "./launch-store.mjs";
export const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};
export const fail = (message, status = 400) => {
  throw new InputError(message, status);
};
async function body(req, limit = 16384) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    fail("Use JSON.", 415);
  let bytes = 0;
  const parts = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) fail("Requisição muito grande.", 413);
    parts.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch {
    fail("JSON inválido.");
  }
}
const owned = (table, id, user) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail("Não encontrado.", 404);
  const value = one(
    `SELECT * FROM ${table} WHERE id=? AND user_id=?`,
    id,
    user.id,
  );
  if (!value) fail("Não encontrado.", 404);
  return value;
};
// Owned asset including its media kind, for checks that depend on the type.
const ownedAsset = (id, user) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail("Não encontrado.", 404);
  const value = one(
    ASSET_SELECT + " WHERE a.id=? AND a.user_id=?",
    id,
    user.id,
  );
  if (!value) fail("Não encontrado.", 404);
  return value;
};
const projectJSON = (p) => ({
  ...JSON.parse(p.data),
  id: p.id,
  revision: p.revision,
  updatedAt: new Date(p.updated).toISOString(),
});
const jobJSON = (j) => ({
  id: j.id,
  projectId: j.project_id,
  batchId: j.batch_id || null,
  index: j.item_index ?? null,
  name: JSON.parse(j.snapshot).name,
  format: JSON.parse(j.snapshot).format,
  state: j.state,
  progress: j.progress,
  attempts: j.attempts,
  error: j.error,
  size: j.size,
  created: j.created,
});
const assetJSON = (a) => ({
  id: a.id,
  kind: a.kind,
  name: a.name,
  size: a.size,
  duration: a.duration,
  width: a.width,
  height: a.height,
  hasAudio: Boolean(a.has_audio),
});
const uploading = new Set(),
  dummyHash = await passwordHash("dummy-not-a-user-password");
// Projects, templates, saved profiles and unfinished renders keep their media.
function assetInUse(userId, assetId) {
  return (
    all("SELECT data FROM projects WHERE user_id=?", userId).some((p) =>
      referencedAssets(JSON.parse(p.data)).has(assetId),
    ) ||
    all(
      "SELECT snapshot FROM jobs WHERE user_id=? AND state IN ('queued','running','cancelling')",
      userId,
    ).some((j) => referencedAssets(JSON.parse(j.snapshot)).has(assetId)) ||
    all("SELECT data FROM saved_profiles WHERE user_id=?", userId).some(
      (p) => JSON.parse(p.data).avatarAssetId === assetId,
    )
  );
}
function available(user, extra = 0) {
  if (
    usage(user.id) + reservedBytes(user.id) + extra >
    planFor(user.id).storage
  )
    fail(
      "Limite de armazenamento atingido. Remova vídeos ou exportações para liberar espaço.",
      409,
    );
}
async function mediaResponse(req, res, file, type, download) {
  const info = await stat(file).catch(() => null);
  if (!info) fail("Arquivo indisponível.", 404);
  let start = 0,
    end = info.size - 1,
    status = 200;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      res.end();
      return;
    }
    start = m[1] ? Number(m[1]) : Math.max(0, info.size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), end) : end;
    if (start > end || start >= info.size) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      res.end();
      return;
    }
    status = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
  }
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", end - start + 1);
  if (download)
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="viceclipz-${download}.mp4"`,
    );
  res.writeHead(status);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
export async function api(req, res, url, workerReady) {
  const route = url.pathname,
    method = req.method;
  const helpers = {
    body,
    owned,
    asset: ownedAsset,
    json,
    fail,
    mediaResponse,
    available,
  };
  if (await publicLaunch(req, res, url, helpers)) return;
  if (
    !["GET", "HEAD"].includes(method) &&
    (req.headers["x-viceclipz"] !== "studio" ||
      (req.headers.origin && req.headers.origin !== ORIGIN) ||
      req.headers["sec-fetch-site"] === "cross-site")
  )
    fail("Origem da requisição não autorizada.", 403);
  if (await publicAccount(req, res, url, helpers)) return;
  if (route === "/api/health" && method === "GET")
    return json(res, 200, {
      ok: true,
      worker: workerReady,
      automation:
        Date.now() -
          (one("SELECT updated FROM service_heartbeats WHERE name='automation'")
            ?.updated || 0) <
        360000,
    });
  if (
    ["/api/auth/register", "/api/auth/login"].includes(route) &&
    method === "POST"
  ) {
    if (!authAllowed(req.socket.remoteAddress))
      fail("Muitas tentativas. Aguarde 15 minutos.", 429);
    const input = await body(req),
      email = String(input.email || "")
        .trim()
        .toLowerCase(),
      password = input.password;
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      typeof password !== "string" ||
      password.length < 10 ||
      password.length > 128
    )
      fail("Informe um e-mail válido e uma senha entre 10 e 128 caracteres.");
    if (route.endsWith("register")) {
      if (verificationRequired()) requireMail();
      if (
        process.env.NODE_ENV === "production" &&
        !(process.env.BETA_EMAILS || "")
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .includes(email)
      )
        fail(
          "O ViceClipz está em beta por convite. Seu e-mail ainda não foi liberado.",
          403,
        );
      const name = String(input.name || "").trim();
      if (!name || name.length > 60)
        fail("Informe seu nome (até 60 caracteres).");
      const hash = await passwordHash(password),
        id = randomUUID();
      try {
        run(
          "INSERT INTO users VALUES(?,?,?,?,?)",
          id,
          email,
          name,
          hash,
          Date.now(),
        );
      } catch (e) {
        if (e.code?.includes("CONSTRAINT") || e.message.includes("UNIQUE"))
          fail("Este e-mail já possui uma conta. Entre para continuar.", 409);
        throw e;
      }
      if (verificationRequired()) queueAccountEmail({ id, email }, "verify");
      createSession(res, id);
      return json(res, 201, { user: { id, email, name } });
    }
    const user = one("SELECT * FROM users WHERE email=?", email),
      correct = await passwordMatches(password, user?.password || dummyHash);
    if (!user || !correct) fail("E-mail ou senha incorretos.", 401);
    if (
      one("SELECT password FROM users WHERE id=?", user.id)?.password !==
      user.password
    )
      fail("E-mail ou senha incorretos.", 401);
    createSession(res, user.id);
    return json(res, 200, {
      user: { id: user.id, email: user.email, name: user.name },
    });
  }
  const user = getUser(req);
  if (!user) fail("Entre na sua conta para continuar.", 401);
  if (await privateAccount(req, res, url, user, helpers)) return;
  if (route === "/api/auth/me" && method === "GET")
    return json(res, 200, {
      user,
      verification: accountStatus(user.id),
      usage: usage(user.id),
      storageLimit: planFor(user.id).storage,
      maxUpload: MAX_UPLOAD,
      maxExport: MAX_EXPORT,
    });
  if (route === "/api/auth/logout" && method === "POST") {
    logout(req, res);
    return json(res, 200, { ok: true });
  }
  if (verificationRequired() && !isVerified(user.id))
    fail("Confirme seu e-mail antes de acessar o estúdio.", 403);
  if (await discoveryAPI(req, res, url, user, helpers)) return;
  if (await privateLaunch(req, res, url, user, helpers)) return;
  if (
    await templateAPI(req, res, url, user, {
      ...helpers,
      workerReady,
      uploading,
    })
  )
    return;
  if (await phraseAPI(req, res, url, user, helpers)) return;
  if (route === "/api/overlay" && method === "POST") {
    const spec = validateProject(await body(req));
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(overlay(spec));
    return;
  }
  if (route === "/api/assets" && method === "GET")
    return json(
      res,
      200,
      all(
        ASSET_SELECT + " WHERE a.user_id=? ORDER BY a.created DESC",
        user.id,
      ).map(assetJSON),
    );
  if (route === "/api/assets" && method === "POST") {
    const length = Number(req.headers["content-length"]);
    if (!Number.isInteger(length) || length <= 0)
      fail("Informe o tamanho do arquivo.", 411);
    if (length > MAX_UPLOAD) fail("O arquivo deve ter até 100 MB.", 413);
    if (uploading.has(user.id)) fail("Aguarde o upload em andamento.", 409);
    available(user, length);
    uploading.add(user.id);
    const id = randomUUID(),
      temp = path.join(DATA, "temp", id + ".upload");
    let handle;
    try {
      handle = await open(temp, "wx");
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_UPLOAD || total > length)
          fail("Arquivo muito grande.", 413);
        await handle.writeFile(chunk);
      }
      await handle.close();
      handle = null;
      if (total !== length) fail("Upload incompleto.");
      // Images are recognized by content, then decoded and re-encoded without metadata.
      const signature = await imageSignature(temp);
      let m, size, kind, mime;
      if (signature) {
        const image = await normalizeImage(temp, signature);
        available(user, image.buffer.length);
        await writeFile(assetPath(id), image.buffer, { flag: "wx" });
        await unlink(temp);
        m = { duration: 0, width: image.width, height: image.height };
        [size, kind, mime] = [image.buffer.length, "image", image.mime];
      } else {
        m = await probe(temp);
        available(user, total);
        await rename(temp, assetPath(id));
        [size, kind, mime] = [total, "video", null];
      }
      transaction(() => {
        run(
          "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)",
          id,
          user.id,
          url.searchParams.get("name")?.slice(0, 200) ||
            (kind === "image" ? "Imagem" : "Vídeo"),
          size,
          m.duration,
          m.width,
          m.height,
          Number(Boolean(m.hasAudio)),
          Date.now(),
        );
        if (kind === "image")
          run("INSERT INTO asset_kinds VALUES(?,?,?)", id, kind, mime);
      });
      return json(res, 201, assetJSON(one(ASSET_SELECT + " WHERE a.id=?", id)));
    } catch (e) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      await unlink(assetPath(id)).catch(() => {});
      throw e;
    } finally {
      uploading.delete(user.id);
    }
  }
  const am = route.match(/^\/api\/assets\/([^/]+)(\/content)?$/);
  if (am) {
    const asset = ownedAsset(am[1], user);
    if (am[2] && ["GET", "HEAD"].includes(method))
      return mediaResponse(
        req,
        res,
        assetPath(asset.id),
        asset.kind === "image"
          ? asset.mime
          : /\.webm$/i.test(asset.name)
            ? "video/webm"
            : /\.mov$/i.test(asset.name)
              ? "video/quicktime"
              : "video/mp4",
      );
    if (!am[2] && method === "DELETE") {
      if (assetInUse(user.id, asset.id))
        fail(
          "Este arquivo está em uso. Remova-o dos projetos, templates, perfis salvos ou exportações em andamento.",
          409,
        );
      await unlink(assetPath(asset.id)).catch(() => {});
      run("DELETE FROM assets WHERE id=?", asset.id);
      return json(res, 200, { ok: true });
    }
  }
  if (route === "/api/projects" && method === "GET")
    return json(
      res,
      200,
      all(
        "SELECT * FROM projects WHERE user_id=? ORDER BY updated DESC",
        user.id,
      ).map(projectJSON),
    );
  const pm = route.match(/^\/api\/projects\/([^/]+)$/);
  if (
    (route === "/api/projects" && method === "POST") ||
    (pm && method === "PUT")
  ) {
    const existing = pm ? owned("projects", pm[1], user) : null,
      raw = await body(req, 262144);
    if (existing && raw.revision !== existing.revision)
      fail("O projeto mudou em outra aba. Reabra antes de salvar.", 409);
    const template = raw.kind === "template";
    if (
      existing &&
      (JSON.parse(existing.data).kind === "template") !== template
    )
      fail("O tipo do projeto não pode ser alterado.", 409);
    const spec = template
        ? validateTemplate(raw, (assetId) => ownedAsset(assetId, user))
        : validateProject(
            raw,
            raw.assetId ? ownedAsset(raw.assetId, user) : null,
          ),
      id = existing?.id || randomUUID(),
      now = Date.now();
    if (existing)
      run(
        "UPDATE projects SET data=?,revision=revision+1,updated=? WHERE id=?",
        JSON.stringify(spec),
        now,
        id,
      );
    else
      run(
        "INSERT INTO projects VALUES(?,?,?,?,?)",
        id,
        user.id,
        JSON.stringify(spec),
        1,
        now,
      );
    return json(
      res,
      existing ? 200 : 201,
      projectJSON(one("SELECT * FROM projects WHERE id=?", id)),
    );
  }
  if (pm) {
    const p = owned("projects", pm[1], user);
    if (method === "GET") return json(res, 200, projectJSON(p));
    if (method === "DELETE") {
      if (
        one(
          "SELECT s.id FROM scheduled_posts s JOIN jobs j ON j.id=s.job_id WHERE j.project_id=?",
          p.id,
        )
      )
        fail(
          "Remova os registros de publicação antes de remover este projeto.",
          409,
        );
      if (
        one(
          "SELECT id FROM jobs WHERE project_id=? AND state IN ('queued','running','cancelling')",
          p.id,
        )
      )
        fail("Cancele a renderização antes de remover o projeto.", 409);
      for (const j of all("SELECT id FROM jobs WHERE project_id=?", p.id))
        await unlink(outputPath(j.id)).catch(() => {});
      transaction(() => {
        run("DELETE FROM jobs WHERE project_id=?", p.id);
        run("DELETE FROM batches WHERE project_id=?", p.id);
        run("DELETE FROM projects WHERE id=?", p.id);
      });
      return json(res, 200, { ok: true });
    }
  }
  if (route === "/api/jobs" && method === "GET")
    return json(
      res,
      200,
      all(
        "SELECT * FROM jobs WHERE user_id=? ORDER BY created DESC",
        user.id,
      ).map(jobJSON),
    );
  if (route === "/api/jobs" && method === "POST") {
    if (!workerReady)
      fail("O processador está reiniciando. Tente em alguns segundos.", 503);
    const input = await body(req),
      p = owned("projects", String(input.projectId || ""), user),
      snapshot = JSON.parse(p.data);
    if (snapshot.kind === "template")
      fail("Templates são exportados em lotes. Use Gerar variações.", 409);
    if (!snapshot.assetId)
      fail("Adicione um vídeo ao projeto antes de exportar.");
    owned("assets", snapshot.assetId, user);
    const fingerprint = digest(JSON.stringify(snapshot)),
      existing = one(
        "SELECT * FROM jobs WHERE project_id=? AND fingerprint=? AND state IN ('queued','running','done') ORDER BY created DESC LIMIT 1",
        p.id,
        fingerprint,
      );
    if (existing) return json(res, 200, jobJSON(existing));
    if (activeOperations(user.id) >= MAX_ACTIVE)
      fail("Você já tem duas exportações ou lotes em andamento.", 409);
    if (uploading.has(user.id))
      fail("Conclua o upload antes de exportar.", 409);
    available(user, EXPORT_RESERVE);
    if (!canRender(user.id))
      fail("Limite mensal de exportações atingido. Consulte seu plano.", 403);
    const id = randomUUID(),
      now = Date.now();
    run(
      "INSERT INTO jobs(id,user_id,project_id,fingerprint,snapshot,state,created,updated) VALUES(?,?,?,?,?,'queued',?,?)",
      id,
      user.id,
      p.id,
      fingerprint,
      JSON.stringify(snapshot),
      now,
      now,
    );
    reserveRender(id, user.id);
    return json(res, 202, jobJSON(one("SELECT * FROM jobs WHERE id=?", id)));
  }
  const jm = route.match(
    /^\/api\/jobs\/([^/]+)(?:\/(download|cancel|retry))?$/,
  );
  if (jm) {
    const j = owned("jobs", jm[1], user),
      action = jm[2];
    if (action === "download" && ["GET", "HEAD"].includes(method)) {
      if (j.state !== "done") fail("A exportação ainda não está pronta.", 409);
      // ?inline=1 lets the batch grid preview the MP4 without forcing a download.
      return mediaResponse(
        req,
        res,
        outputPath(j.id),
        "video/mp4",
        url.searchParams.has("inline") ? null : j.id,
      );
    }
    if (action === "cancel" && method === "POST") {
      run(
        "UPDATE jobs SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'cancelling' END,updated=? WHERE id=? AND state IN ('queued','running')",
        Date.now(),
        j.id,
      );
      if (j.state === "queued") releaseRender(j.id);
      return json(
        res,
        200,
        jobJSON(one("SELECT * FROM jobs WHERE id=?", j.id)),
      );
    }
    if (action === "retry" && method === "POST") {
      if (!["failed", "cancelled"].includes(j.state) || j.attempts >= 3)
        fail(
          "Este processamento não pode ser repetido. Crie uma nova exportação.",
          409,
        );
      if (
        (!(j.batch_id && batchActive(j.batch_id)) &&
          activeOperations(user.id) >= MAX_ACTIVE) ||
        uploading.has(user.id)
      )
        fail("Aguarde os processos em andamento.", 409);
      for (const assetId of referencedAssets(JSON.parse(j.snapshot)))
        owned("assets", assetId, user);
      available(user, j.reserve ?? EXPORT_RESERVE);
      if (!canRender(user.id))
        fail("Limite mensal de exportações atingido.", 403);
      run(
        "UPDATE jobs SET state='queued',progress=0,error=NULL,updated=? WHERE id=?",
        Date.now(),
        j.id,
      );
      reserveRender(j.id, user.id);
      return json(
        res,
        202,
        jobJSON(one("SELECT * FROM jobs WHERE id=?", j.id)),
      );
    }
    if (!action && method === "GET") return json(res, 200, jobJSON(j));
    if (!action && method === "DELETE") {
      if (one("SELECT id FROM scheduled_posts WHERE job_id=?", j.id))
        fail(
          "Remova os registros de publicação antes de remover este MP4.",
          409,
        );
      if (["running", "queued", "cancelling"].includes(j.state))
        fail("Cancele antes de remover.", 409);
      await unlink(outputPath(j.id)).catch(() => {});
      run("DELETE FROM jobs WHERE id=?", j.id);
      return json(res, 200, { ok: true });
    }
  }
  fail("Rota não encontrada.", 404);
}
