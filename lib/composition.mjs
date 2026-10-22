import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { MAX_EXPORT } from "./config.mjs";
const font =
  process.env.FONT_PATH ||
  (process.platform === "win32"
    ? "C:/Windows/Fonts/arialbd.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf");
if (existsSync(font)) GlobalFonts.registerFromPath(font, "ViceClipz");
export const formats = {
  "9:16": [720, 1280],
  "1:1": [720, 720],
  "4:5": [720, 900],
};
export const themes = {
  neon: ["#d4fa83", "#18200f"],
  lilac: ["#c9c3e5", "#292536"],
  rose: ["#e5b7c7", "#39272e"],
};
export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function validateProject(raw, asset) {
  if (!raw || typeof raw !== "object")
    throw new InputError("Projeto inválido.");
  const name = String(raw.name || "").trim(),
    headline = String(raw.headline || "").trim();
  if (!name || name.length > 80 || headline.length > 100)
    throw new InputError(
      "Use um nome de até 80 caracteres e uma headline de até 100.",
    );
  if (
    !Object.hasOwn(formats, raw.format) ||
    !Object.hasOwn(themes, raw.template)
  )
    throw new InputError("Formato ou template inválido.");
  const start = Number(raw.start ?? 0),
    end = Number(raw.end ?? Math.min(asset?.duration || 10, MAX_EXPORT));
  const fontSize = Number(raw.fontSize ?? 42),
    position = raw.position || "bottom",
    fit = raw.fit || "cover";
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end - start < 0.25 ||
    end - start > MAX_EXPORT + 0.01 ||
    (asset && end > asset.duration + 0.05)
  )
    throw new InputError(
      `Escolha um corte válido entre 0,25 e ${MAX_EXPORT} segundos, dentro da duração do vídeo.`,
    );
  if (
    !["top", "center", "bottom"].includes(position) ||
    !["cover", "contain"].includes(fit) ||
    !Number.isInteger(fontSize) ||
    fontSize < 24 ||
    fontSize > 64
  )
    throw new InputError("Composição inválida.");
  const date = String(raw.date || "");
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date + "T12:00:00Z")) ||
      new Date(date + "T12:00:00Z").toISOString().slice(0, 10) !== date)
  )
    throw new InputError("Data inválida.");
  return {
    version: 1,
    name,
    headline,
    assetId: asset?.id || null,
    template: raw.template,
    format: raw.format,
    start,
    end,
    fontSize,
    position,
    fit,
    mute: raw.mute === true,
    date,
    variants: Array.isArray(raw.variants)
      ? raw.variants
          .filter((v) => typeof v === "string" && v.length <= 100)
          .slice(0, 3)
      : [],
  };
}
export function overlay(spec) {
  const [w, h] = formats[spec.format],
    canvas = createCanvas(w, h),
    ctx = canvas.getContext("2d");
  if (!spec.headline) return canvas.toBuffer("image/png");
  const maxWidth = w - 104;
  let lines = [],
    fontSize = spec.fontSize,
    lineHeight,
    height;
  do {
    ctx.font = `bold ${fontSize}px ViceClipz, Arial, sans-serif`;
    lines = [];
    let line = "";
    for (const word of spec.headline.split(/\s+/)) {
      const candidate = line ? line + " " + word : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const char of word) {
        if (ctx.measureText(line + char).width > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    if (line) lines.push(line);
    lineHeight = Math.ceil(fontSize * 1.2);
    height = lines.length * lineHeight + 40;
    if (height <= h - 112) break;
    fontSize -= 2;
  } while (fontSize >= 18);
  const y =
    spec.position === "top"
      ? 48
      : spec.position === "center"
        ? Math.round((h - height) / 2)
        : h - height - 64;
  const [bg, fg] = themes[spec.template];
  ctx.fillStyle = bg;
  ctx.fillRect(28, y, w - 56, height);
  ctx.fillStyle = fg;
  ctx.textBaseline = "top";
  lines.forEach((text, i) => ctx.fillText(text, 52, y + 20 + i * lineHeight));
  return canvas.toBuffer("image/png");
}
