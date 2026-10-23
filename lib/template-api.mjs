import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { one, all, run, transaction } from "./db.mjs";
import { outputPath } from "./config.mjs";
import { LIMITS } from "../dist/template-core.js";
import {
  validateTemplate,
  validatePreview,
  validateProfile,
  validateStyle,
  buildVariations,
  referencedAssets,
  cleanText,
} from "./template-spec.mjs";
import { renderOverlay, loadAvatar } from "./template-render.mjs";
import {
  activeOperations,
  batchActive,
  batchReserve,
  queueEstimates,
} from "./queue.mjs";
import { planFor, renderUsage, reserveRender } from "./launch-store.mjs";
import { InputError } from "./composition.mjs";
import { digest } from "./auth.mjs";
import { streamArchive } from "./archive.mjs";
import { aiStatus } from "./phrase-ai.mjs";
export const MAX_ACTIVE = 2;
// Fixed table allowlist for saved presets; request input never selects a table.
const SAVED = {
  profiles: { table: "saved_profiles", validate: validateProfile },
  styles: { table: "saved_styles", validate: (raw) => validateStyle(raw) },
};
const savedJSON = (row) => ({
  id: row.id,
  name: row.name,
  data: JSON.parse(row.data),
  updated: row.updated,
});
function itemJSON(job, estimates) {
  const spec = JSON.parse(job.snapshot),
    estimate = estimates?.get(job.id);
  return {
    id: job.id,
    index: job.item_index,
    phrase: spec.phrase,
    duration: spec.duration,
    state: job.state,
    progress: job.progress,
    attempts: job.attempts,
    error: job.error,
    size: job.size,
    position: estimate?.position ?? null,
    eta: estimate?.eta ?? null,
  };
}
function batchJSON(batch, withItems = false) {
  const jobs = all(
      "SELECT * FROM jobs WHERE batch_id=? ORDER BY item_index",
      batch.id,
    ),
    counts = {};
  for (const j of jobs) counts[j.state] = (counts[j.state] || 0) + 1;
  const estimates = withItems ? queueEstimates() : null;
  return {
    id: batch.id,
    projectId: batch.project_id,
    name: batch.name,
    revision: batch.revision,
    total: batch.total,
    created: batch.created,
    counts,
    active: jobs.some((j) =>
      ["queued", "running", "cancelling"].includes(j.state),
    ),
    ...(withItems ? { items: jobs.map((j) => itemJSON(j, estimates)) } : {}),
  };
}
function checkAssets(snapshot, owned, user) {
  for (const id of referencedAssets(snapshot)) owned("assets", id, user);
}
function quota(userId, needed) {
  const plan = planFor(userId),
    left = Math.max(0, plan.renders - renderUsage(userId));
  if (needed > left)
    throw new InputError(
      `Esta ação precisa de ${needed} ${needed === 1 ? "exportação" : "exportações"} e restam ${left} no seu plano este mês.`,
      403,
    );
}
const archiving = new Set();
export async function templateAPI(req, res, url, user, h) {
  const route = url.pathname,
    method = req.method;
  if (route === "/api/templates/preview" && method === "POST") {
    const spec = validatePreview(await h.body(req, 65536), (id) =>
      h.asset(id, user),
    );
    const { image, layout } = renderOverlay(
      spec,
      spec.phrase,
      spec.profile.avatar ? await loadAvatar(spec.profile.avatarAssetId) : null,
    );
    h.json(res, 200, {
      layout,
      image: "data:image/png;base64," + image.toString("base64"),
    });
    return true;
  }
  if (route === "/api/templates/limits" && method === "GET") {
    const plan = planFor(user.id);
    h.json(res, 200, {
      batch: LIMITS.batch,
      renders: { used: renderUsage(user.id), limit: plan.renders },
      active: activeOperations(user.id),
      maxActive: MAX_ACTIVE,
      ai: aiStatus(user.id),
    });
    return true;
  }
  const saved = route.match(/^\/api\/(profiles|styles)(?:\/([^/]+))?$/);
  if (saved) {
    const { table, validate } = SAVED[saved[1]];
    if (!saved[2] && method === "GET") {
      h.json(
        res,
        200,
        all(
          `SELECT * FROM ${table} WHERE user_id=? ORDER BY name`,
          user.id,
        ).map(savedJSON),
      );
      return true;
    }
    if (!saved[2] && method === "POST") {
      const input = await h.body(req),
        name = cleanText(input.name, LIMITS.savedName);
      if (!name) h.fail(`Dê um nome de até ${LIMITS.savedName} caracteres.`);
      const data = validate(input.data, (id) => h.asset(id, user)),
        existing = one(
          `SELECT id FROM ${table} WHERE user_id=? AND name=?`,
          user.id,
          name,
        );
      if (
        !existing &&
        one(`SELECT count(*) n FROM ${table} WHERE user_id=?`, user.id).n >=
          LIMITS.saved
      )
        h.fail(
          `Você pode salvar até ${LIMITS.saved} itens. Remova um antes de salvar outro.`,
          409,
        );
      const id = existing?.id || randomUUID();
      run(
        `INSERT INTO ${table} VALUES(?,?,?,?,?) ON CONFLICT(user_id,name) DO UPDATE SET data=excluded.data,updated=excluded.updated`,
        id,
        user.id,
        name,
        JSON.stringify(data),
        Date.now(),
      );
      h.json(
        res,
        existing ? 200 : 201,
        savedJSON(one(`SELECT * FROM ${table} WHERE id=?`, id)),
      );
      return true;
    }
    if (saved[2] && method === "DELETE") {
      const row = h.owned(table, saved[2], user);
      run(`DELETE FROM ${table} WHERE id=?`, row.id);
      h.json(res, 200, { ok: true });
      return true;
    }
  }
  const create = route.match(/^\/api\/templates\/([^/]+)\/batches$/);
  if (create && method === "POST") {
    const project = h.owned("projects", create[1], user),
      input = await h.body(req);
    if (!/^[a-f0-9-]{36}$/.test(input.requestKey || ""))
      h.fail("Identificador do lote inválido.");
    const previous = one(
      "SELECT * FROM batches WHERE user_id=? AND request_key=?",
      user.id,
      input.requestKey,
    );
    if (previous) {
      h.json(res, 200, batchJSON(previous));
      return true;
    }
    const data = JSON.parse(project.data);
    if (data.kind !== "template")
      h.fail("Este projeto não é um template.", 409);
    if (input.revision !== project.revision)
      h.fail("O template mudou em outra aba. Reabra antes de gerar.", 409);
    if (!h.workerReady)
      h.fail("O processador está reiniciando. Tente em alguns segundos.", 503);
    if (h.uploading.has(user.id))
      h.fail("Conclua o upload antes de gerar variações.", 409);
    // Revalidates ownership and asset types now; the snapshots are then frozen.
    const template = validateTemplate(data, (id) => h.asset(id, user)),
      variations = buildVariations(template);
    if (activeOperations(user.id) >= MAX_ACTIVE)
      h.fail(
        "Você já tem duas exportações ou lotes em andamento. Aguarde ou cancele um deles.",
        409,
      );
    quota(user.id, variations.length);
    const reserves = variations.map((v) => batchReserve(v.duration));
    h.available(
      user,
      reserves.reduce((n, r) => n + r, 0),
    );
    const id = randomUUID(),
      now = Date.now();
    transaction(() => {
      run(
        "INSERT INTO batches VALUES(?,?,?,?,?,?,?,?)",
        id,
        user.id,
        project.id,
        input.requestKey,
        project.revision,
        template.name,
        variations.length,
        now,
      );
      variations.forEach((spec, i) => {
        const jobId = randomUUID(),
          snapshot = JSON.stringify(spec);
        run(
          "INSERT INTO jobs(id,user_id,project_id,fingerprint,snapshot,state,created,updated,batch_id,item_index,reserve) VALUES(?,?,?,?,?,'queued',?,?,?,?,?)",
          jobId,
          user.id,
          project.id,
          digest(snapshot),
          snapshot,
          now,
          now,
          id,
          spec.index,
          reserves[i],
        );
        reserveRender(jobId, user.id);
      });
    });
    h.json(res, 202, batchJSON(one("SELECT * FROM batches WHERE id=?", id)));
    return true;
  }
  if (route === "/api/batches" && method === "GET") {
    const projectId = url.searchParams.get("projectId");
    if (projectId) h.owned("projects", projectId, user);
    h.json(
      res,
      200,
      all(
        `SELECT * FROM batches WHERE user_id=?${projectId ? " AND project_id=?" : ""} ORDER BY created DESC LIMIT 20`,
        user.id,
        ...(projectId ? [projectId] : []),
      ).map((b) => batchJSON(b)),
    );
    return true;
  }
  const bm = route.match(
    /^\/api\/batches\/([^/]+)(?:\/(cancel|retry|archive))?$/,
  );
  if (!bm) return false;
  const batch = h.owned("batches", bm[1], user),
    action = bm[2];
  if (!action && method === "GET") {
    h.json(res, 200, batchJSON(batch, true));
    return true;
  }
  if (action === "cancel" && method === "POST") {
    const now = Date.now();
    transaction(() => {
      run(
        "UPDATE jobs SET state='cancelled',updated=? WHERE batch_id=? AND state='queued'",
        now,
        batch.id,
      );
      run(
        "UPDATE usage_events SET state='released' WHERE state='reserved' AND job_id IN (SELECT id FROM jobs WHERE batch_id=? AND state='cancelled')",
        batch.id,
      );
      run(
        "UPDATE jobs SET state='cancelling',updated=? WHERE batch_id=? AND state='running'",
        now,
        batch.id,
      );
    });
    h.json(res, 200, batchJSON(batch, true));
    return true;
  }
  if (action === "retry" && method === "POST") {
    const items = all(
      "SELECT * FROM jobs WHERE batch_id=? AND state IN ('failed','cancelled') AND attempts<3 ORDER BY item_index",
      batch.id,
    );
    if (!items.length) h.fail("Não há variações para tentar novamente.", 409);
    if (!h.workerReady)
      h.fail("O processador está reiniciando. Tente em alguns segundos.", 503);
    if (h.uploading.has(user.id))
      h.fail("Conclua o upload antes de continuar.", 409);
    if (!batchActive(batch.id) && activeOperations(user.id) >= MAX_ACTIVE)
      h.fail("Aguarde as exportações e lotes em andamento.", 409);
    for (const item of items)
      checkAssets(JSON.parse(item.snapshot), h.owned, user);
    quota(user.id, items.length);
    h.available(
      user,
      items.reduce((n, item) => n + item.reserve, 0),
    );
    transaction(() => {
      for (const item of items)
        if (
          run(
            "UPDATE jobs SET state='queued',progress=0,error=NULL,updated=? WHERE id=? AND state IN ('failed','cancelled')",
            Date.now(),
            item.id,
          ).changes
        )
          reserveRender(item.id, user.id);
    });
    h.json(res, 202, batchJSON(batch, true));
    return true;
  }
  if (action === "archive" && ["GET", "HEAD"].includes(method)) {
    const items = all(
      "SELECT * FROM jobs WHERE batch_id=? AND state='done' ORDER BY item_index",
      batch.id,
    );
    if (!items.length) h.fail("Nenhuma variação pronta para baixar.", 409);
    if (archiving.has(user.id))
      h.fail("Aguarde o download em andamento terminar.", 409);
    archiving.add(user.id);
    try {
      await streamArchive(
        req,
        res,
        items.map((j) => ({
          name: `variacao-${String(j.item_index).padStart(2, "0")}.mp4`,
          file: outputPath(j.id),
          size: j.size,
          crc: j.crc,
          time: j.updated,
        })),
        "viceclipz-lote-" + batch.id.slice(0, 8) + ".zip",
      );
    } finally {
      archiving.delete(user.id);
    }
    return true;
  }
  if (!action && method === "DELETE") {
    if (batchActive(batch.id))
      h.fail("Cancele as variações em andamento antes de remover o lote.", 409);
    if (
      one(
        "SELECT s.id FROM scheduled_posts s JOIN jobs j ON j.id=s.job_id WHERE j.batch_id=?",
        batch.id,
      )
    )
      h.fail(
        "Remova os registros de publicação das variações antes de remover o lote.",
        409,
      );
    for (const j of all("SELECT id FROM jobs WHERE batch_id=?", batch.id))
      await unlink(outputPath(j.id)).catch(() => {});
    transaction(() => {
      run("DELETE FROM jobs WHERE batch_id=?", batch.id);
      run("DELETE FROM batches WHERE id=?", batch.id);
    });
    h.json(res, 200, { ok: true });
    return true;
  }
  return false;
}
