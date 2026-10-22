import { load } from "cheerio";
import { randomUUID } from "node:crypto";
import { db, all, one, run, usage } from "./db.mjs";
import { InputError, validateProject } from "./composition.mjs";
import { createReader, publicURL } from "./discovery-fetch.mjs";

db.exec(`CREATE TABLE IF NOT EXISTS discovery_items(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),url TEXT NOT NULL,provider TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,author TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(user_id,url));
CREATE TABLE IF NOT EXISTS discovery_limits(key TEXT PRIMARY KEY,updated INTEGER NOT NULL);`);
const trim = (value, max = 300) =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
function cleanLink(value, base) {
  try {
    return publicURL(new URL(value, base).href).href;
  } catch {
    return null;
  }
}
export function parsePage(text, url, type) {
  if (
    !/text\/html|application\/(xhtml\+xml|rss\+xml|atom\+xml|xml)|text\/xml/i.test(
      type || "",
    )
  )
    throw new InputError("Use uma página HTML ou feed RSS/Atom.", 415);
  const xml = !/html/i.test(type),
    $ = load(text, { xmlMode: xml });
  if (xml) {
    return $("item, entry")
      .slice(0, 20)
      .toArray()
      .map((node) => {
        const el = $(node),
          link =
            el.find("link[rel='alternate']").attr("href") ||
            el.find("link").first().attr("href") ||
            el.find("link").first().text();
        return {
          url: cleanLink(link, url),
          provider: "site",
          title: trim(el.find("title").first().text(), 160),
          description: trim(
            load(el.find("description, summary").first().text()).text(),
          ),
          author: trim(el.find("author, creator").first().text(), 100),
        };
      })
      .filter((item) => item.url && item.title);
  }
  const meta = (name) =>
    $(`meta[property='${name}'], meta[name='${name}']`).first().attr("content");
  return [
    {
      url,
      provider: "site",
      title: trim(
        meta("og:title") || $("title").text() || new URL(url).hostname,
        160,
      ),
      description: trim(meta("og:description") || meta("description")),
      author: trim(meta("author"), 100),
    },
  ];
}
export async function collect(value, read) {
  const url = publicURL(value),
    host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "instagram.com" || host === "tiktok.com") {
    const instagram = host === "instagram.com";
    if (
      !(
        instagram
          ? /^\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?$/
          : /^\/@[\w.-]+\/video\/\d+\/?$/
      ).test(url.pathname)
    )
      throw new InputError(
        "Cole o link completo de uma publicação pública, não um perfil ou link curto.",
        422,
      );
    url.search = "";
    const version = process.env.META_API_VERSION;
    if (instagram && !/^v\d+\.\d+$/.test(version || ""))
      throw new InputError(
        "Instagram: configure META_API_VERSION no servidor para habilitar a consulta oficial.",
        503,
      );
    const endpoint = new URL(
      instagram
        ? `https://graph.facebook.com/${version}/instagram_oembed`
        : "https://www.tiktok.com/oembed",
    );
    endpoint.searchParams.set("url", url.href);
    const headers =
      instagram && process.env.META_OEMBED_ACCESS_TOKEN
        ? { Authorization: "Bearer " + process.env.META_OEMBED_ACCESS_TOKEN }
        : {};
    const response = await read(endpoint.href, { official: true, headers });
    let data;
    try {
      data = JSON.parse(response.text);
    } catch {
      throw new InputError("Resposta inválida do provedor.", 502);
    }
    if (data.error || (!data.author_name && !data.title))
      throw new InputError(
        "O provedor não disponibilizou os metadados desta publicação.",
        422,
      );
    return [
      {
        url: url.href,
        provider: instagram ? "instagram" : "tiktok",
        title: trim(data.title || `Publicação de ${data.author_name}`, 160),
        description: trim(data.title),
        author: trim(data.author_name, 100),
      },
    ];
  }
  if (/(^|\.)(instagram|tiktok)\.com$/.test(host))
    throw new InputError(
      "Use o link completo da publicação em www.instagram.com ou www.tiktok.com.",
      422,
    );
  const response = await read(url.href);
  return parsePage(
    response.text,
    response.url,
    response.headers["content-type"],
  );
}
const active = new Set();
function limit(key, interval) {
  const now = Date.now();
  if (
    (one("SELECT updated FROM discovery_limits WHERE key=?", key)?.updated ||
      0) >
    now - interval
  )
    throw new InputError(
      "Aguarde alguns segundos antes de consultar esta fonte novamente.",
      429,
    );
  run("DELETE FROM discovery_limits WHERE updated<?", now - 3600000);
  run(
    "INSERT INTO discovery_limits VALUES(?,?) ON CONFLICT(key) DO UPDATE SET updated=excluded.updated",
    key,
    now,
  );
}
const read = createReader({
  beforeRequest: async (host) => {
    // Short delay between robots and document requests. Persistent claim is atomic.
    const last =
      one("SELECT updated FROM discovery_limits WHERE key=?", "host:" + host)
        ?.updated || 0;
    const delay = 1000 - (Date.now() - last);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    limit("host:" + host, 900);
  },
});
export function metrics(user) {
  return {
    projects: one("SELECT count(*) n FROM projects WHERE user_id=?", user.id).n,
    assets: one("SELECT count(*) n FROM assets WHERE user_id=?", user.id).n,
    storageBytes: usage(user.id),
    references: one(
      "SELECT count(*) n FROM discovery_items WHERE user_id=?",
      user.id,
    ).n,
    exports: all(
      "SELECT state,count(*) count FROM jobs WHERE user_id=? GROUP BY state",
      user.id,
    ),
    publications: all(
      "SELECT status state,count(*) count FROM scheduled_posts WHERE user_id=? GROUP BY status",
      user.id,
    ),
    averageExportSeconds: one(
      "SELECT avg(updated-created)/1000.0 n FROM jobs WHERE user_id=? AND state='done'",
      user.id,
    ).n,
    daily: all(
      "SELECT date(created/1000,'unixepoch') day,count(*) count FROM usage_events WHERE user_id=? AND state='completed' AND created>=? GROUP BY day ORDER BY day",
      user.id,
      Date.now() - 30 * 86400000,
    ),
    generatedAt: new Date().toISOString(),
  };
}
export async function discoveryAPI(
  req,
  res,
  url,
  user,
  { body, json, fail },
  collector = collect,
) {
  const route = url.pathname,
    method = req.method;
  if (route === "/api/metrics" && method === "GET") {
    json(res, 200, metrics(user));
    return true;
  }
  if (route === "/api/discovery" && method === "GET") {
    json(
      res,
      200,
      all(
        "SELECT id,url,provider,title,description,author,created FROM discovery_items WHERE user_id=? ORDER BY created DESC",
        user.id,
      ),
    );
    return true;
  }
  if (route === "/api/discovery" && method === "POST") {
    const input = await body(req);
    publicURL(input.url);
    if (active.has(user.id) || active.size >= 4)
      fail("Uma coleta está em andamento. Tente em instantes.", 429);
    limit("user:" + user.id, 5000);
    active.add(user.id);
    try {
      const items = await collector(input.url, read);
      if (!items.length)
        fail("Nenhuma referência encontrada nessa fonte.", 422);
      const count = one(
        "SELECT count(*) n FROM discovery_items WHERE user_id=?",
        user.id,
      ).n;
      const fresh = new Map(items.map((item) => [item.url, item]));
      const added = [...fresh.keys()].filter(
        (link) =>
          !one(
            "SELECT id FROM discovery_items WHERE user_id=? AND url=?",
            user.id,
            link,
          ),
      ).length;
      if (count + added > 200)
        fail(
          "Limite de 200 referências. Remova algumas antes de coletar mais.",
          409,
        );
      for (const item of fresh.values())
        run(
          "INSERT INTO discovery_items VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,url) DO UPDATE SET title=excluded.title,description=excluded.description,author=excluded.author",
          randomUUID(),
          user.id,
          item.url,
          item.provider,
          item.title,
          item.description,
          item.author,
          Date.now(),
        );
      json(res, 200, { collected: fresh.size, added });
    } catch (e) {
      if (e instanceof InputError) throw e;
      fail(
        "Não foi possível consultar esta fonte. Tente novamente mais tarde.",
        502,
      );
    } finally {
      active.delete(user.id);
    }
    return true;
  }
  const match = route.match(/^\/api\/discovery\/([a-f0-9-]{36})(\/project)?$/);
  if (
    match &&
    ((method === "DELETE" && !match[2]) || (method === "POST" && match[2]))
  ) {
    const item = one(
      "SELECT * FROM discovery_items WHERE id=? AND user_id=?",
      match[1],
      user.id,
    );
    if (!item) fail("Referência não encontrada.", 404);
    if (method === "DELETE") {
      run(
        "DELETE FROM discovery_items WHERE id=? AND user_id=?",
        item.id,
        user.id,
      );
      json(res, 200, { ok: true });
    } else {
      const id = randomUUID(),
        data = validateProject({
          name: item.title.slice(0, 80),
          headline: "",
          format: "9:16",
          template: "neon",
        });
      // The reference library retains attribution; exports start without third-party media or text.
      run(
        "INSERT INTO projects(id,user_id,data,revision,updated) VALUES(?,?,?,1,?)",
        id,
        user.id,
        JSON.stringify(data),
        Date.now(),
      );
      json(res, 201, { id });
    }
    return true;
  }
  return false;
}
