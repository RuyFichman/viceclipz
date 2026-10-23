import { mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function deploymentConfig(value) {
  let backend;
  try {
    backend = new URL(value);
  } catch {
    throw Error(
      "Configure BACKEND_ORIGIN com a URL HTTPS do servidor persistente.",
    );
  }
  if (
    backend.protocol !== "https:" ||
    backend.username ||
    backend.password ||
    backend.pathname !== "/" ||
    backend.search ||
    backend.hash ||
    backend.hostname === "localhost"
  )
    throw Error(
      "BACKEND_ORIGIN deve ser uma origem HTTPS, sem caminho, senha ou parâmetros.",
    );
  return {
    version: 3,
    routes: [
      {
        src: "/(.*)",
        headers: {
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "same-origin",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        },
        continue: true,
      },
      { src: "/api/(.*)", dest: backend.origin + "/api/$1" },
      { src: "/sobre", dest: "/landing.html" },
      { handle: "filesystem" },
      { src: "/(.*)", status: 404, dest: "/404.html" },
    ],
  };
}
export async function build(destination, backend) {
  const config = deploymentConfig(backend),
    root = path.dirname(fileURLToPath(import.meta.url));
  await mkdir(path.join(destination, "static"), { recursive: true });
  for (const file of [
    "index.html",
    "studio.js",
    "account.js",
    "launch.js",
    "styles.css",
    "mvp.css",
    "launch.css",
    "discovery.js",
    "growth.css",
    "landing.html",
    "templates.js",
    "template-core.js",
    "templates.css",
  ])
    await copyFile(
      path.join(root, "dist", file),
      path.join(destination, "static", file),
    );
  await writeFile(
    path.join(destination, "static", "404.html"),
    '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>ViceClipz</title><h1>Página não encontrada</h1><a href="/">Voltar ao estúdio</a></html>',
  );
  await writeFile(
    path.join(destination, "config.json"),
    JSON.stringify(config, null, 2),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await build(path.resolve(".vercel/output"), process.env.BACKEND_ORIGIN);
  console.log("Interface e proxy de API preparados em .vercel/output.");
}
