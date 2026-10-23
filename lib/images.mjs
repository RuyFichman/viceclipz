import { open, readFile } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { probeImage, IMAGE_CODECS } from "./media.mjs";
import { InputError } from "./composition.mjs";
// Enough for a 720-pixel-wide cell at the maximum 3× zoom.
export const IMAGE_EDGE = 2160;
export async function imageSignature(file) {
  const handle = await open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(12), 0, 12, 0);
    if (bytesRead < 12) return null;
    if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
      return "png";
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
      return "jpeg";
    if (
      buffer.toString("latin1", 0, 4) === "RIFF" &&
      buffer.toString("latin1", 8, 12) === "WEBP"
    )
      return "webp";
    return null;
  } finally {
    await handle.close();
  }
}
// One decode at a time bounds memory: a 50-megapixel source needs ~200 MB of pixels.
let pending = Promise.resolve();
export function normalizeImage(file, signature) {
  const task = pending.then(() => normalize(file, signature));
  pending = task.catch(() => {});
  return task;
}
// Re-encoding from decoded pixels applies the EXIF orientation and drops every
// metadata block (location, camera, comments, ICC profiles).
async function normalize(file, signature) {
  const info = await probeImage(file);
  if (info.codec !== IMAGE_CODECS[signature])
    throw new InputError(
      "O conteúdo do arquivo não corresponde a uma imagem válida.",
    );
  let image;
  try {
    image = await loadImage(await readFile(file));
  } catch {
    throw new InputError("Não foi possível decodificar esta imagem.");
  }
  const upright =
    (image.width === info.width && image.height === info.height) ||
    (image.width === info.height && image.height === info.width);
  if (!upright)
    throw new InputError("Não foi possível decodificar esta imagem.");
  const scale = Math.min(1, IMAGE_EDGE / Math.max(image.width, image.height)),
    width = Math.max(1, Math.round(image.width * scale)),
    height = Math.max(1, Math.round(image.height * scale)),
    canvas = createCanvas(width, height),
    ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, width, height);
  let transparent = false;
  if (signature !== "jpeg") {
    const pixels = ctx.getImageData(0, 0, width, height).data;
    for (let i = 3; i < pixels.length; i += 4)
      if (pixels[i] < 255) {
        transparent = true;
        break;
      }
  }
  return transparent
    ? { buffer: canvas.toBuffer("image/png"), mime: "image/png", width, height }
    : {
        buffer: canvas.toBuffer("image/jpeg", 90),
        mime: "image/jpeg",
        width,
        height,
      };
}
