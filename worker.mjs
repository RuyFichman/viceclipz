import { spawn } from "node:child_process";
import { writeFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { one, run, all } from "./lib/db.mjs";
import { DATA, assetPath, outputPath, EXPORT_RESERVE } from "./lib/config.mjs";
import { overlay, formats } from "./lib/composition.mjs";
import { FFMPEG, probe, probeImage } from "./lib/media.mjs";
import { releaseRender } from "./lib/launch-store.mjs";
import {
  renderOverlay,
  variationArgs,
  loadAvatar,
} from "./lib/template-render.mjs";
import { CANVAS } from "./dist/template-core.js";
import { nextJob } from "./lib/queue.mjs";
import { fileCrc } from "./lib/archive.mjs";
let busy = false,
  child = null,
  stopping = false;
run(
  "UPDATE jobs SET state='failed',error='Processamento interrompido. Tente novamente.',updated=? WHERE state='running'",
  Date.now(),
);
run(
  "UPDATE jobs SET state='cancelled',updated=? WHERE state='cancelling'",
  Date.now(),
);
run(
  "UPDATE usage_events SET state='released' WHERE state='reserved' AND job_id IN (SELECT id FROM jobs WHERE state IN ('failed','cancelled'))",
);
run(
  "UPDATE usage_events SET state='completed' WHERE job_id IN (SELECT id FROM jobs WHERE state='done')",
);
for (const job of all(
  "SELECT id FROM jobs WHERE state IN ('failed','cancelled','queued')",
))
  await unlink(outputPath(job.id)).catch(() => {});
async function legacyCommand(spec, image, output) {
  const [w, h] = formats[spec.format],
    duration = spec.end - spec.start;
  await writeFile(image, overlay(spec));
  const sizing =
    spec.fit === "cover"
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
      : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-protocol_whitelist",
    "file,pipe",
    "-ss",
    String(spec.start),
    "-i",
    assetPath(spec.assetId),
    "-loop",
    "1",
    "-i",
    image,
    "-filter_complex",
    `[0:v:0]${sizing},setsar=1,fps=30[base];[base][1:v:0]overlay=0:0:shortest=1,format=yuv420p[v]`,
    "-map",
    "[v]",
  ];
  if (!spec.mute)
    args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-af", "apad");
  else args.push("-an");
  args.push(
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-maxrate",
    "4M",
    "-bufsize",
    "8M",
    "-threads",
    "2",
    "-filter_complex_threads",
    "1",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    output,
  );
  return { args, duration, width: w, height: h, timeout: duration * 12000 };
}
// Template variations: sizes are probed again because stored metadata of older uploads
// may predate rotation handling, and the crop math needs the upright size.
async function variationCommand(spec, image, output) {
  const sources = {};
  for (const [slotId, cell] of Object.entries(spec.cells)) {
    const file = assetPath(cell.assetId),
      info = cell.type === "video" ? await probe(file) : await probeImage(file);
    sources[slotId] = { path: file, width: info.width, height: info.height };
  }
  const avatar = spec.profile.avatar
      ? await loadAvatar(spec.profile.avatarAssetId)
      : null,
    { image: png, layout } = renderOverlay(spec, spec.phrase, avatar);
  await writeFile(image, png);
  return {
    args: variationArgs({ spec, layout, sources, overlay: image, output }),
    duration: spec.duration,
    width: CANVAS.width,
    height: CANVAS.height,
    timeout: spec.duration * 15000,
  };
}
async function renderJob(job) {
  const spec = JSON.parse(job.snapshot),
    image = path.join(DATA, "temp", job.id + ".png"),
    output = outputPath(job.id);
  let timeout = false,
    cancelled = false,
    stderr = "";
  try {
    const command =
        spec.kind === "variation"
          ? await variationCommand(spec, image, output)
          : await legacyCommand(spec, image, output),
      { duration, width: w, height: h } = command;
    await new Promise((resolve, reject) => {
      child = spawn(FFMPEG, command.args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let partial = "";
      const timer = setTimeout(
        () => {
          timeout = true;
          child?.kill();
        },
        Math.max(90000, command.timeout),
      );
      const check = setInterval(() => {
        if (
          one("SELECT state FROM jobs WHERE id=?", job.id)?.state ===
          "cancelling"
        ) {
          cancelled = true;
          child?.kill();
        }
      }, 200);
      child.stdout.on("data", (b) => {
        partial += b;
        const lines = partial.split("\n");
        partial = lines.pop();
        for (const line of lines) {
          const m = line.match(/^out_time_us=(\d+)/);
          if (m)
            run(
              "UPDATE jobs SET progress=?,updated=? WHERE id=? AND state='running'",
              Math.min(99, Math.round((Number(m[1]) / 1e6 / duration) * 100)),
              Date.now(),
              job.id,
            );
        }
      });
      child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-4000)));
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(check);
        child = null;
        error ? reject(error) : resolve();
      };
      child.once("error", finish);
      child.once("close", (code) =>
        finish(
          code === 0 ? null : new Error(stderr || "Renderização interrompida."),
        ),
      );
    });
    if (
      one("SELECT state FROM jobs WHERE id=?", job.id)?.state === "cancelling"
    )
      cancelled = true;
    if (cancelled || stopping) throw new Error("Cancelado.");
    const result = await probe(output),
      size = (await stat(output)).size;
    if (
      Math.abs(result.duration - duration) > 0.3 ||
      result.width !== w ||
      result.height !== h ||
      result.codec !== "h264" ||
      size > (job.reserve ?? EXPORT_RESERVE)
    )
      throw new Error("A validação do MP4 falhou.");
    const changed = run(
      "UPDATE jobs SET state='done',progress=100,size=?,crc=?,error=NULL,updated=? WHERE id=? AND state='running'",
      size,
      await fileCrc(output),
      Date.now(),
      job.id,
    ).changes;
    if (!changed) await unlink(output).catch(() => {});
    else
      run("UPDATE usage_events SET state='completed' WHERE job_id=?", job.id);
  } catch (error) {
    await unlink(output).catch(() => {});
    if (!cancelled)
      run(
        "UPDATE jobs SET state='failed',error=?,updated=? WHERE id=? AND state='running'",
        timeout
          ? "O processamento excedeu o tempo limite. Tente um corte menor."
          : "Não foi possível gerar o MP4. Tente novamente ou use outro vídeo.",
        Date.now(),
        job.id,
      );
    if (!cancelled && !stopping)
      console.error("Render failed", job.id, error.message.slice(-1000));
  } finally {
    await unlink(image).catch(() => {});
    if (one("SELECT state FROM jobs WHERE id=?", job.id)?.state !== "done")
      releaseRender(job.id);
    run(
      "UPDATE jobs SET state='cancelled',updated=? WHERE id=? AND state='cancelling'",
      Date.now(),
      job.id,
    );
  }
}
async function tick() {
  if (busy || stopping) return;
  const job = nextJob();
  if (!job) return;
  const now = Date.now(),
    claimed = run(
      "UPDATE jobs SET state='running',progress=0,attempts=attempts+1,started=?,updated=? WHERE id=? AND state='queued'",
      now,
      now,
      job.id,
    );
  if (!claimed.changes) return;
  busy = true;
  try {
    await renderJob(job);
  } finally {
    busy = false;
  }
}
const timer = setInterval(
  () => tick().catch((e) => console.error("Worker error", e.message)),
  350,
);
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  child?.kill();
  const wait = setInterval(() => {
    if (!busy) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 100);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", (m) => {
  if (m === "stop") stop();
});
process.on("disconnect", stop);
process.send?.("ready");
