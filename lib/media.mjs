import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { InputError } from "./composition.mjs";
import { MAX_DURATION } from "./config.mjs";
export const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic;
export const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path;
export function capture(command, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Tempo de processamento excedido."));
    }, timeout);
    child.stdout.on("data", (b) => {
      out += b;
      if (out.length > 2e6) child.kill();
    });
    child.stderr.on("data", (b) => (err = (err + b).slice(-4000)));
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(out)
        : reject(new Error(err || "Falha ao processar mídia."));
    });
  });
}
export async function probe(file) {
  let metadata;
  try {
    metadata = JSON.parse(
      await capture(FFPROBE, [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        file,
      ]),
    );
  } catch {
    throw new InputError(
      "Não foi possível ler este vídeo. Use um arquivo MP4, MOV ou WebM válido.",
    );
  }
  const video = metadata.streams?.find(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  const duration = Number(metadata.format?.duration || video?.duration);
  if (
    !video ||
    !Number.isFinite(duration) ||
    duration < 0.25 ||
    duration > MAX_DURATION ||
    !video.width ||
    !video.height ||
    video.width > 4096 ||
    video.height > 4096
  )
    throw new InputError(
      "Envie um vídeo de até 10 minutos e resolução máxima de 4096 × 4096.",
    );
  const container = metadata.format?.format_name || "";
  if (!/(mov|mp4|matroska|webm)/.test(container))
    throw new InputError("Container não suportado. Use MP4, MOV ou WebM.");
  // FFmpeg and browsers apply the display matrix, so report the upright size.
  const rotation = Number(
    video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
      video.tags?.rotate ??
      0,
  );
  const turned = Math.abs(rotation) % 180 === 90;
  return {
    duration,
    width: turned ? video.height : video.width,
    height: turned ? video.width : video.height,
    hasAudio: metadata.streams.some((s) => s.codec_type === "audio"),
    codec: video.codec_name,
  };
}
export const IMAGE_CODECS = { png: "png", jpeg: "mjpeg", webp: "webp" };
export async function probeImage(file) {
  let metadata;
  try {
    metadata = JSON.parse(
      await capture(FFPROBE, [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_streams",
        "-of",
        "json",
        file,
      ]),
    );
  } catch {
    throw new InputError(
      "Não foi possível ler esta imagem. Use um arquivo PNG, JPEG ou WebP válido.",
    );
  }
  const image = metadata.streams?.[0];
  if (
    metadata.streams?.length !== 1 ||
    !Object.values(IMAGE_CODECS).includes(image.codec_name)
  )
    throw new InputError(
      "Formato de imagem não suportado. Use PNG, JPEG ou WebP.",
    );
  if (
    !image.width ||
    !image.height ||
    image.width > 8192 ||
    image.height > 8192 ||
    image.width * image.height > 50e6
  )
    throw new InputError(
      "Envie uma imagem estática de até 8192 × 8192 pixels e 50 megapixels.",
    );
  return { width: image.width, height: image.height, codec: image.codec_name };
}
