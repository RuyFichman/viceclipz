import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { one, run } from "./db.mjs";
import { ORIGIN, outputPath } from "./config.mjs";
import { seal, unseal, secretReady, mediaLink } from "./launch-store.mjs";
import { InputError } from "./composition.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
export const providers = ["instagram", "youtube"];
export function providerReady(provider) {
  return (
    secretReady() &&
    ORIGIN.startsWith("https://") &&
    (provider === "instagram"
      ? Boolean(
          process.env.INSTAGRAM_CLIENT_ID &&
          process.env.INSTAGRAM_CLIENT_SECRET &&
          /^v\d+\.\d+$/.test(process.env.META_API_VERSION || ""),
        )
      : provider === "youtube"
        ? Boolean(
            process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
          )
        : false)
  );
}
const callback = (p) => ORIGIN + "/api/social/callback/" + p;
const graph = () =>
  `https://graph.instagram.com/${process.env.META_API_VERSION}`;
async function data(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok || result.error)
    throw new Error(
      "O provedor recusou a operação. Verifique as permissões e reconecte a conta.",
    );
  return result;
}
const form = (params) => ({
  method: "POST",
  body: new URLSearchParams(params),
});
export function startOAuth(user, provider, res) {
  if (!providerReady(provider))
    throw new InputError(
      "Integração indisponível: configure domínio HTTPS e credenciais do provedor.",
      503,
    );
  const state = randomBytes(32).toString("hex"),
    nonce = randomBytes(32).toString("hex"),
    verifier = randomBytes(32).toString("base64url");
  run("DELETE FROM oauth_states WHERE expires<?", Date.now());
  run(
    "INSERT INTO oauth_states VALUES(?,?,?,?,?,?)",
    hash(state),
    user.id,
    provider,
    hash(nonce),
    seal(verifier),
    Date.now() + 600000,
  );
  res.setHeader(
    "Set-Cookie",
    `viceclipz_oauth=${nonce}; HttpOnly; SameSite=Lax; Path=/api/social/callback; Max-Age=600; Secure`,
  );
  const params =
    provider === "instagram"
      ? {
          client_id: process.env.INSTAGRAM_CLIENT_ID,
          redirect_uri: callback(provider),
          response_type: "code",
          scope: "instagram_business_basic,instagram_business_content_publish",
          state,
          enable_fb_login: "0",
          force_authentication: "1",
        }
      : {
          client_id: process.env.GOOGLE_CLIENT_ID,
          redirect_uri: callback(provider),
          response_type: "code",
          scope:
            "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
          access_type: "offline",
          prompt: "consent",
          state,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        };
  return {
    url:
      (provider === "instagram"
        ? "https://www.instagram.com/oauth/authorize"
        : "https://accounts.google.com/o/oauth2/v2/auth") +
      "?" +
      new URLSearchParams(params),
  };
}
export async function finishOAuth(req, url, provider) {
  const state = url.searchParams.get("state") || "",
    nonce =
      (req.headers.cookie || "")
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("viceclipz_oauth="))
        ?.slice(15) || "";
  const stored = one(
    "SELECT * FROM oauth_states WHERE hash=? AND provider=? AND expires>?",
    hash(state),
    provider,
    Date.now(),
  );
  if (!stored || stored.nonce_hash !== hash(nonce))
    throw new InputError(
      "Autorização inválida ou expirada. Inicie a conexão novamente.",
      400,
    );
  run("DELETE FROM oauth_states WHERE hash=?", hash(state));
  if (url.searchParams.has("error"))
    throw new InputError("Você não autorizou a conexão.");
  const code = url.searchParams.get("code");
  if (!code) throw new InputError("Código de autorização ausente.");
  let token, remoteId, label;
  if (provider === "instagram") {
    const short = await data(
      "https://api.instagram.com/oauth/access_token",
      form({
        client_id: process.env.INSTAGRAM_CLIENT_ID,
        client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
        grant_type: "authorization_code",
        redirect_uri: callback(provider),
        code,
      }),
    );
    const access = (short.data?.[0] || short).access_token;
    if (!access) throw new Error("Token Instagram ausente.");
    token = await data(
      "https://graph.instagram.com/access_token?" +
        new URLSearchParams({
          grant_type: "ig_exchange_token",
          client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
          access_token: access,
        }),
    );
    const profile = await data(graph() + "/me?fields=user_id,username", {
      headers: { Authorization: "Bearer " + token.access_token },
    });
    remoteId = String(profile.user_id || profile.id || "");
    label = profile.username;
  } else {
    token = await data(
      "https://oauth2.googleapis.com/token",
      form({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: "authorization_code",
        redirect_uri: callback(provider),
        code,
        code_verifier: unseal(stored.verifier),
      }),
    );
    const profile = await data(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: "Bearer " + token.access_token } },
    );
    remoteId = profile.items?.[0]?.id;
    label = profile.items?.[0]?.snippet?.title;
    if (!token.refresh_token)
      throw new InputError(
        "Autorize o acesso offline novamente para permitir agendamento.",
      );
  }
  if (!token.access_token || !remoteId || !label)
    throw new InputError(
      "Nenhuma conta profissional ou canal compatível foi encontrado.",
    );
  const existing = one(
    "SELECT id FROM social_connections WHERE user_id=? AND provider=?",
    stored.user_id,
    provider,
  );
  if (
    existing &&
    one(
      "SELECT id FROM scheduled_posts WHERE connection_id=? AND status IN ('preparing','processing','publishing','needs_review')",
      existing.id,
    )
  )
    throw new InputError(
      "Resolva as publicações pendentes antes de reconectar esta conta.",
      409,
    );
  if (existing)
    run(
      "UPDATE scheduled_posts SET status='cancelled',error='Conta reconectada; reagende o conteúdo.',updated=? WHERE connection_id=? AND status='queued'",
      Date.now(),
      existing.id,
    );
  run(
    "INSERT INTO social_connections(id,user_id,provider,remote_id,label,secret,expires,state,updated) VALUES(?,?,?,?,?,?,?,'connected',?) ON CONFLICT(user_id,provider) DO UPDATE SET remote_id=excluded.remote_id,label=excluded.label,secret=excluded.secret,expires=excluded.expires,state='connected',updated=excluded.updated",
    existing?.id || randomUUID(),
    stored.user_id,
    provider,
    remoteId,
    String(label).slice(0, 200),
    seal(token),
    Date.now() + (token.expires_in || 3600) * 1000,
    Date.now(),
  );
}
export async function accessToken(connection) {
  let token = unseal(connection.secret);
  const refreshWindow =
    connection.provider === "instagram" ? 7 * 86400000 : 60000;
  if (connection.expires > Date.now() + refreshWindow)
    return token.access_token;
  try {
    const next =
      connection.provider === "youtube"
        ? await data(
            "https://oauth2.googleapis.com/token",
            form({
              client_id: process.env.GOOGLE_CLIENT_ID,
              client_secret: process.env.GOOGLE_CLIENT_SECRET,
              grant_type: "refresh_token",
              refresh_token: token.refresh_token,
            }),
          )
        : await data(
            "https://graph.instagram.com/refresh_access_token?" +
              new URLSearchParams({
                grant_type: "ig_refresh_token",
                access_token: token.access_token,
              }),
          );
    if (!next.access_token) throw Error();
    token = { ...token, ...next };
    run(
      "UPDATE social_connections SET secret=?,expires=?,updated=? WHERE id=?",
      seal(token),
      Date.now() + (next.expires_in || 3600) * 1000,
      Date.now(),
      connection.id,
    );
    return token.access_token;
  } catch {
    run(
      "UPDATE social_connections SET state='reconnect' WHERE id=?",
      connection.id,
    );
    throw new Error("A conexão expirou ou foi revogada. Reconecte a conta.");
  }
}
export const productionAdapter = {
  async prepare(post, connection) {
    const token = await accessToken(connection);
    if (connection.provider === "instagram") {
      const result = await data(
        graph() + "/" + encodeURIComponent(connection.remote_id) + "/media",
        {
          ...form({
            media_type: "REELS",
            video_url: mediaLink(post.id),
            caption: post.caption,
            share_to_feed: "true",
          }),
          headers: { Authorization: "Bearer " + token },
        },
      );
      if (!result.id) throw Error("Container ausente.");
      return { container: result.id };
    }
    const file = await stat(outputPath(post.job_id));
    const res = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "X-Upload-Content-Length": String(file.size),
          "X-Upload-Content-Type": "video/mp4",
        },
        body: JSON.stringify({
          snippet: {
            title: post.title,
            description: post.caption,
            categoryId: "22",
          },
          status: {
            privacyStatus: post.privacy,
            selfDeclaredMadeForKids: Boolean(post.made_for_kids),
          },
        }),
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      },
    );
    const location = res.headers.get("location");
    if (!res.ok || !location)
      throw Error("Não foi possível iniciar o upload no YouTube.");
    const target = new URL(location);
    if (
      target.protocol !== "https:" ||
      target.hostname !== "www.googleapis.com"
    )
      throw Error("Destino de upload inválido.");
    return { session: location };
  },
  async ready(post, connection, checkpoint) {
    if (connection.provider === "youtube") return true;
    const token = await accessToken(connection);
    const status = await data(
      graph() +
        "/" +
        encodeURIComponent(checkpoint.container) +
        "?fields=status_code",
      { headers: { Authorization: "Bearer " + token } },
    );
    if (["ERROR", "EXPIRED"].includes(status.status_code))
      throw Error("Instagram recusou ou expirou o vídeo.");
    return status.status_code === "FINISHED";
  },
  async publish(post, connection, checkpoint) {
    const token = await accessToken(connection);
    if (connection.provider === "instagram") {
      const result = await data(
        graph() +
          "/" +
          encodeURIComponent(connection.remote_id) +
          "/media_publish",
        {
          ...form({ creation_id: checkpoint.container }),
          headers: { Authorization: "Bearer " + token },
        },
      );
      if (!result.id) throw Error("Resultado sem confirmação.");
      return String(result.id);
    }
    const target = new URL(checkpoint.session);
    if (
      target.protocol !== "https:" ||
      target.hostname !== "www.googleapis.com"
    )
      throw Error("Destino de upload inválido.");
    const file = outputPath(post.job_id),
      size = (await stat(file)).size;
    const res = await fetch(target, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "video/mp4",
        "Content-Length": String(size),
      },
      body: createReadStream(file),
      duplex: "half",
      signal: AbortSignal.timeout(300000),
      redirect: "error",
    });
    const value = await res.json().catch(() => ({}));
    if (!res.ok || !value.id)
      throw Error("Resultado do upload não confirmado.");
    return String(value.id);
  },
};
