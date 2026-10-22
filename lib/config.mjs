import path from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const DATA = path.resolve(
  process.env.DATA_DIR || path.join(ROOT, "data"),
);
export const PORT = Number(process.env.PORT || 4173);
export const HOST = process.env.HOST || "127.0.0.1";
export const ORIGIN = process.env.APP_ORIGIN || `http://127.0.0.1:${PORT}`;
if (process.env.NODE_ENV === "production") {
  const url = new URL(ORIGIN);
  if (url.protocol !== "https:" || url.origin !== ORIGIN)
    throw Error("Produção exige APP_ORIGIN HTTPS sem caminho.");
  if (!/^[a-fA-F0-9]{64}$/.test(process.env.TOKEN_ENCRYPTION_KEY || ""))
    throw Error(
      "Produção exige TOKEN_ENCRYPTION_KEY de 32 bytes em hexadecimal.",
    );
  if (process.env.BILLING_REQUIRED !== "true")
    throw Error("Produção exige BILLING_REQUIRED=true.");
  if (!process.env.RESEND_API_KEY?.trim() || !process.env.EMAIL_FROM?.trim())
    throw Error(
      "Produção exige RESEND_API_KEY e EMAIL_FROM para verificação e recuperação de contas.",
    );
}
export const MAX_UPLOAD = 100 * 1024 * 1024;
export const STORAGE_LIMIT = 2 * 1024 * 1024 * 1024;
export const EXPORT_RESERVE = 100 * 1024 * 1024;
export const MAX_DURATION = 600;
export const MAX_EXPORT = 120;
export const assetPath = (id) => path.join(DATA, "assets", id + ".media");
export const outputPath = (id) => path.join(DATA, "exports", id + ".mp4");
