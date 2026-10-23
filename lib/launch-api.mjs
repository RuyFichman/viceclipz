import { randomUUID } from "node:crypto";
import { one, all, run } from "./db.mjs";
import { ORIGIN, outputPath } from "./config.mjs";
import {
  providers,
  providerReady,
  startOAuth,
  finishOAuth,
} from "./social.mjs";
import { billingInfo, checkout, portal, acceptWebhook } from "./billing.mjs";
import { validMediaSignature, planFor } from "./launch-store.mjs";

export async function publicLaunch(req, res, url, h) {
  const route = url.pathname;
  if (route === "/api/billing/webhook" && req.method === "POST") {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1048576) h.fail("Evento muito grande.", 413);
      chunks.push(chunk);
    }
    h.json(
      res,
      200,
      acceptWebhook(Buffer.concat(chunks), req.headers["stripe-signature"]),
    );
    return true;
  }
  const callback = route.match(
    /^\/api\/social\/callback\/(instagram|youtube)$/,
  );
  if (callback && req.method === "GET") {
    let success = false;
    try {
      await finishOAuth(req, url, callback[1]);
      success = true;
    } catch {}
    res.writeHead(303, {
      Location:
        ORIGIN +
        "/?connection=" +
        (success ? "success" : "error") +
        "#integrations",
      "Set-Cookie":
        "viceclipz_oauth=; HttpOnly; SameSite=Lax; Path=/api/social/callback; Max-Age=0; Secure",
    });
    res.end();
    return true;
  }
  const media = route.match(/^\/api\/social\/media\/([a-f0-9-]{36})$/);
  if (media && ["GET", "HEAD"].includes(req.method)) {
    if (
      !validMediaSignature(
        media[1],
        Number(url.searchParams.get("expires")),
        url.searchParams.get("signature"),
      )
    )
      h.fail("Link expirado.", 403);
    const post = one(
      "SELECT p.job_id FROM scheduled_posts p JOIN jobs j ON j.id=p.job_id AND j.user_id=p.user_id WHERE p.id=? AND p.status IN ('preparing','processing','publishing') AND j.state='done'",
      media[1],
    );
    if (!post) h.fail("Arquivo indisponível.", 404);
    await h.mediaResponse(req, res, outputPath(post.job_id), "video/mp4");
    return true;
  }
  return false;
}
export async function privateLaunch(req, res, url, user, h) {
  const route = url.pathname,
    method = req.method;
  if (route === "/api/integrations" && method === "GET") {
    h.json(res, 200, {
      providers: providers.map((provider) => ({
        provider,
        configured: providerReady(provider),
      })),
      connections: all(
        "SELECT id,provider,label,state,expires FROM social_connections WHERE user_id=?",
        user.id,
      ),
      enabled: planFor(user.id).social,
    });
    return true;
  }
  const connect = route.match(
    /^\/api\/integrations\/(instagram|youtube)\/connect$/,
  );
  if (connect && method === "POST") {
    if (!planFor(user.id).social)
      h.fail("Assine um plano com publicação social.", 403);
    h.json(res, 200, startOAuth(user, connect[1], res));
    return true;
  }
  const connection = route.match(/^\/api\/connections\/([^/]+)$/);
  if (connection && method === "DELETE") {
    const c = h.owned("social_connections", connection[1], user);
    if (
      one(
        "SELECT id FROM scheduled_posts WHERE connection_id=? AND status IN ('preparing','publishing','needs_review')",
        c.id,
      )
    )
      h.fail("Aguarde ou confira as publicações antes de desconectar.", 409);
    run(
      "UPDATE scheduled_posts SET status='cancelled',checkpoint=NULL,updated=? WHERE connection_id=? AND status IN ('queued','processing')",
      Date.now(),
      c.id,
    );
    run(
      "UPDATE social_connections SET secret='',state='disconnected',updated=? WHERE id=?",
      Date.now(),
      c.id,
    );
    h.json(res, 200, { ok: true });
    return true;
  }
  if (route === "/api/schedules" && method === "GET") {
    h.json(
      res,
      200,
      all(
        "SELECT p.id,p.job_id,p.due,p.timezone,p.title,p.caption,p.privacy,p.status,p.remote_id,p.error,c.provider,c.label FROM scheduled_posts p JOIN social_connections c ON c.id=p.connection_id WHERE p.user_id=? ORDER BY p.due DESC LIMIT 200",
        user.id,
      ),
    );
    return true;
  }
  if (route === "/api/schedules" && method === "POST") {
    if (!planFor(user.id).social)
      h.fail("Assine um plano com publicação social.", 403);
    const input = await h.body(req);
    if (!/^[a-f0-9-]{36}$/.test(input.requestKey || ""))
      h.fail("Identificador de agendamento inválido.");
    const previous = one(
      "SELECT id FROM scheduled_posts WHERE user_id=? AND request_key=?",
      user.id,
      input.requestKey,
    );
    if (previous) {
      h.json(res, 200, previous);
      return true;
    }
    const job = h.owned("jobs", input.jobId || "", user),
      c = h.owned("social_connections", input.connectionId || "", user);
    if (job.state !== "done") h.fail("Exporte o MP4 antes de agendar.", 409);
    if (c.state !== "connected" || !providerReady(c.provider))
      h.fail("Conecte e configure a rede antes de agendar.", 409);
    const due = Date.parse(input.due),
      now = Date.now();
    if (!Number.isFinite(due) || due < now + 60000 || due > now + 90 * 86400000)
      h.fail("Escolha entre um minuto e 90 dias no futuro.");
    try {
      if (typeof input.timezone !== "string" || input.timezone.length > 80)
        throw Error();
      new Intl.DateTimeFormat("pt-BR", { timeZone: input.timezone }).format(
        due,
      );
    } catch {
      h.fail("Fuso horário inválido.");
    }
    const title = String(input.title || "").trim(),
      caption = String(input.caption || "");
    if (
      !title ||
      title.length > 100 ||
      caption.length > (c.provider === "instagram" ? 2200 : 5000)
    )
      h.fail("Confira o título (até 100 caracteres) e a legenda.");
    if (
      !["private", "unlisted", "public"].includes(input.privacy) ||
      typeof input.madeForKids !== "boolean"
    )
      h.fail("Informe a visibilidade e o público infantil.");
    const spec = JSON.parse(job.snapshot);
    if (
      c.provider === "instagram" &&
      (spec.format !== "9:16" || (spec.duration ?? spec.end - spec.start) < 3)
    )
      h.fail("Para Reels, exporte em 9:16 com pelo menos 3 segundos.");
    if (
      Number(
        one(
          "SELECT count(*) n FROM scheduled_posts WHERE user_id=? AND status IN ('queued','preparing','processing','publishing')",
          user.id,
        ).n,
      ) >= 100
    )
      h.fail("Você já tem 100 publicações pendentes.", 409);
    const id = randomUUID();
    run(
      "INSERT INTO scheduled_posts(id,user_id,job_id,connection_id,request_key,due,timezone,title,caption,privacy,made_for_kids,status,next_run,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)",
      id,
      user.id,
      job.id,
      c.id,
      input.requestKey,
      due,
      input.timezone,
      title,
      caption,
      c.provider === "instagram" ? "public" : input.privacy,
      Number(input.madeForKids),
      due,
      now,
      now,
    );
    h.json(res, 201, { id });
    return true;
  }
  const postMatch = route.match(
    /^\/api\/schedules\/([^/]+)(?:\/(cancel|resolve))?$/,
  );
  if (postMatch) {
    const post = h.owned("scheduled_posts", postMatch[1], user);
    if (method === "POST" && postMatch[2] === "cancel") {
      const changed = run(
        "UPDATE scheduled_posts SET status='cancelled',checkpoint=NULL,updated=? WHERE id=? AND status IN ('queued','processing','failed')",
        Date.now(),
        post.id,
      ).changes;
      if (!changed)
        h.fail(
          "A publicação já foi enviada ou precisa ser conferida na rede.",
          409,
        );
      h.json(res, 200, { ok: true });
      return true;
    }
    if (method === "POST" && postMatch[2] === "resolve") {
      const input = await h.body(req);
      if (
        post.status !== "needs_review" ||
        !["published", "cancelled"].includes(input.result)
      )
        h.fail("Resultado inválido.", 409);
      run(
        "UPDATE scheduled_posts SET status=?,checkpoint=NULL,error=?,updated=? WHERE id=?",
        input.result,
        "Conferido manualmente pelo titular.",
        Date.now(),
        post.id,
      );
      h.json(res, 200, { ok: true });
      return true;
    }
    if (method === "DELETE" && !postMatch[2]) {
      if (!["published", "cancelled", "failed"].includes(post.status))
        h.fail("Cancele ou confira a publicação antes de remover.", 409);
      run("DELETE FROM scheduled_posts WHERE id=?", post.id);
      h.json(res, 200, { ok: true });
      return true;
    }
  }
  if (route === "/api/billing" && method === "GET") {
    h.json(res, 200, await billingInfo(user.id));
    return true;
  }
  if (route === "/api/billing/checkout" && method === "POST") {
    h.json(res, 200, await checkout(user, (await h.body(req)).plan));
    return true;
  }
  if (route === "/api/billing/portal" && method === "POST") {
    h.json(res, 200, await portal(user));
    return true;
  }
  return false;
}
