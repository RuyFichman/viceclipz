import { request } from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import robotsParser from "robots-parser";
import { InputError } from "./composition.mjs";

export const agent = "ViceClipzBot/1.0";
const reject = (message) => {
  throw new InputError(message, 422);
};
export function publicURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    reject("Informe uma URL HTTPS válida.");
  }
  if (
    url.href.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hostname.includes(":")
  )
    reject(
      "Use HTTPS na porta padrão, sem credenciais. Endereços IPv6 literais não são suportados.",
    );
  if (
    !url.hostname.includes(".") ||
    /\.(localhost|local|internal|test|invalid)$/i.test(url.hostname)
  )
    reject("Endereço de rede privada não permitido.");
  if (ipaddr.isValid(url.hostname) && !publicIP(url.hostname))
    reject("Endereço de rede privada não permitido.");
  url.hash = "";
  return url;
}
export function publicIP(address) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export async function resolvePublic(hostname, resolver = lookup) {
  let timer;
  try {
    const records = await Promise.race([
      resolver(hostname, { all: true, verbatim: true }),
      new Promise((_, no) => {
        timer = setTimeout(
          () => no(new InputError("DNS indisponível.", 502)),
          5000,
        );
      }),
    ]);
    if (!records.length || records.some((r) => !publicIP(r.address)))
      reject("Destino privado ou reservado não permitido.");
    return records[0];
  } finally {
    clearTimeout(timer);
  }
}
export function transport(url, address, headers = {}) {
  return new Promise((resolve, rejectRequest) => {
    const req = request(
      url,
      {
        agent: false,
        headers: {
          "User-Agent": agent,
          Accept: "text/html, application/xml, application/json, text/plain",
          "Accept-Encoding": "identity",
          ...headers,
        },
        lookup: (_host, options, callback) =>
          callback(
            null,
            options.all ? [address] : address.address,
            address.family,
          ),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 ** 2)
            req.destroy(new InputError("Página excede 2 MB.", 413));
          else chunks.push(chunk);
        });
        res.on("error", rejectRequest);
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    const timer = setTimeout(
      () => req.destroy(new InputError("A fonte demorou a responder.", 504)),
      10000,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", rejectRequest);
    req.end();
  });
}
export function createReader({
  resolver = lookup,
  send = transport,
  beforeRequest = () => {},
} = {}) {
  async function raw(value, headers = {}) {
    const url = publicURL(value);
    const address = await resolvePublic(url.hostname, resolver);
    await beforeRequest(url.hostname);
    const result = await send(url, address, headers);
    if (
      result.headers["content-encoding"] &&
      result.headers["content-encoding"] !== "identity"
    )
      reject("Compressão de resposta não suportada pela coleta.");
    return { ...result, url: url.href };
  }
  async function robots(url) {
    // Redirected robots files fail closed instead of fetching an unchecked location.
    const r = await raw(new URL("/robots.txt", url).href);
    if (r.status === 404) return;
    if (
      r.status !== 200 ||
      robotsParser(r.url, r.text).isAllowed(url.href, agent) === false
    )
      reject("Esta fonte não permite a coleta pelo ViceClipz.");
  }
  return async (value, { official = false, headers = {} } = {}) => {
    let url = publicURL(value);
    for (let hop = 0; hop < 4; hop++) {
      if (!official) await robots(url);
      const response = await raw(url.href, headers);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        // Never forward a provider credential through redirects.
        if (official)
          reject(
            "O provedor redirecionou a consulta. Tente novamente mais tarde.",
          );
        url = publicURL(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.status !== 200)
        reject("Fonte indisponível, privada ou com acesso limitado.");
      return response;
    }
    reject("A fonte redirecionou muitas vezes.");
  };
}
