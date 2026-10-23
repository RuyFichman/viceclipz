import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  defaultTemplate,
  applyPreset,
  slotList,
  PRESETS,
} from "../dist/template-core.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Port 4187 belongs to tests/integration.test.mjs.
const port = 4188,
  origin = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  data = path.join(root, ".test-data-templates-" + runId),
  results = path.join(root, "test-results", "templates-" + runId);
let server,
  logs = "";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function processRun(exe, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true });
    let out = "",
      err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.once("error", reject);
    p.once("exit", (c) => (c === 0 ? resolve(out) : reject(new Error(err))));
  });
}
const lavfi = (args, file) =>
  processRun(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
    file,
  ]);
async function start() {
  server = fork(path.join(root, "server.mjs"), [], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
      EMAIL_VERIFICATION_REQUIRED: "false",
      BILLING_REQUIRED: "false",
      ANTHROPIC_API_KEY: "",
      PORT: String(port),
      APP_ORIGIN: origin,
      DATA_DIR: data,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  server.stdout.on("data", (b) => (logs += b));
  server.stderr.on("data", (b) => (logs += b));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await (await fetch(origin + "/api/health")).json()).worker) return;
    } catch {}
    await delay(100);
  }
  throw Error("Server failed: " + logs);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const p = server;
  await new Promise((resolve) => {
    p.once("exit", resolve);
    p.send("stop");
  });
}
function client() {
  let cookie = "";
  return async (
    route,
    {
      method = "GET",
      data,
      bytes,
      headers = {},
      expected = 200,
      binary = false,
    } = {},
  ) => {
    const res = await fetch(origin + "/api" + route, {
      method,
      headers: {
        "X-ViceClipz": "studio",
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: bytes ?? (data !== undefined ? JSON.stringify(data) : undefined),
    });
    if (res.headers.has("set-cookie"))
      cookie = res.headers.get("set-cookie").split(";")[0];
    const value = binary
      ? Buffer.from(await res.arrayBuffer())
      : await res.json();
    assert.equal(
      res.status,
      expected,
      `${method} ${route}: ${binary ? res.status : JSON.stringify(value).slice(0, 500)}`,
    );
    return { value, headers: res.headers };
  };
}
async function waitBatch(c, id) {
  for (let i = 0; i < 1200; i++) {
    const { value } = await c("/batches/" + id);
    if (!value.active) return value;
    await delay(150);
  }
  throw Error("Batch timeout: " + logs);
}
async function metadata(file) {
  return JSON.parse(
    await processRun(ffprobe.path, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]),
  );
}
async function frame(file, at, out) {
  await processRun(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-ss",
    String(at),
    "-i",
    file,
    "-frames:v",
    "1",
    out,
  ]);
  const image = await loadImage(await readFile(out)),
    canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return (x, y) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
}
const near = (pixel, target, tolerance = 40) =>
  pixel.every((v, i) => Math.abs(v - target[i]) <= tolerance);
// Minimal ZIP reader for the archive test: walks the central directory.
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10),
    entries = [];
  let at = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const nameLength = buffer.readUInt16LE(at + 28),
      name = buffer.toString("utf8", at + 46, at + 46 + nameLength),
      crc = buffer.readUInt32LE(at + 16),
      size = buffer.readUInt32LE(at + 24),
      offset = buffer.readUInt32LE(at + 42),
      local = offset + 30 + buffer.readUInt16LE(offset + 26);
    entries.push({
      name,
      crc,
      size,
      data: buffer.subarray(local, local + size),
    });
    at += 46 + nameLength;
  }
  return entries;
}
function withMedia(template, picks, phrases) {
  const media = {},
    selected = {};
  for (const slot of slotList(template)) {
    const options = picks[slot.type].shift();
    media[slot.id] = options.map((o) => ({
      id: randomUUID().slice(0, 8).replace(/-/g, "0"),
      ...o,
    }));
    selected[slot.id] = media[slot.id].map((o) => o.id);
  }
  const list = phrases.map((text, i) => ({ id: "p" + i, text, auto: false }));
  return {
    ...template,
    media,
    phrases: list,
    selection: { media: selected, phrases: list.map((p) => p.id) },
  };
}
await test("Templates: imagens, presets renderizados, lotes, cotas e ZIP", async (t) => {
  await mkdir(results, { recursive: true });
  const file = (name) => path.join(results, name);
  await lavfi(
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
    ],
    file("landscape.mp4"),
  );
  await lavfi(
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=360x640:rate=30",
      "-t",
      "1.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    ],
    file("portrait.mp4"),
  );
  await lavfi(
    ["-display_rotation", "90", "-i", file("landscape.mp4"), "-c", "copy"],
    file("rotated.mp4"),
  );
  // JPEG with EXIF orientation 6 and a comment that must not survive normalization.
  const photo = createCanvas(400, 300),
    pctx = photo.getContext("2d");
  pctx.fillStyle = "#e0306f";
  pctx.fillRect(0, 0, 200, 300);
  pctx.fillStyle = "#2f6fe0";
  pctx.fillRect(200, 0, 200, 300);
  const jpeg = photo.toBuffer("image/jpeg", 92),
    tiff = Buffer.from([
      0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6,
      0, 0, 0, 0, 0, 0,
    ]),
    exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]),
    comment = Buffer.from("SECRET-METADATA-GPS", "latin1"),
    segment = (marker, payload) => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(payload.length + 2);
      return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
    };
  await writeFile(
    file("photo.jpg"),
    Buffer.concat([
      jpeg.subarray(0, 2),
      segment(0xe1, exif),
      segment(0xfe, comment),
      jpeg.subarray(2),
    ]),
  );
  const alpha = createCanvas(300, 300),
    actx = alpha.getContext("2d");
  actx.fillStyle = "#ffa94d";
  actx.beginPath();
  actx.arc(150, 150, 120, 0, Math.PI * 2);
  actx.fill();
  await writeFile(file("alpha.png"), alpha.toBuffer("image/png"));
  const opaque = createCanvas(320, 240),
    octx = opaque.getContext("2d");
  octx.fillStyle = "#3ac47d";
  octx.fillRect(0, 0, 320, 240);
  await writeFile(file("opaque.webp"), opaque.toBuffer("image/webp", 90));
  await writeFile(
    file("huge.png"),
    createCanvas(9000, 10).toBuffer("image/png"),
  );
  const a = client(),
    b = client(),
    password = "Templates-" + randomUUID();
  const assets = {};
  try {
    await start();
    await a("/auth/register", {
      method: "POST",
      data: {
        name: "Template QA",
        email: "tpl-a-" + runId + "@example.test",
        password,
      },
      expected: 201,
    });
    await b("/auth/register", {
      method: "POST",
      data: {
        name: "Outra conta",
        email: "tpl-b-" + runId + "@example.test",
        password,
      },
      expected: 201,
    });
    await t.test(
      "imagens são validadas pelo conteúdo e regravadas sem metadados",
      async () => {
        for (const [name, bytes] of [
          [
            "fake.png",
            Buffer.concat([
              Buffer.from("89504e470d0a1a0a", "hex"),
              Buffer.from("not really a png"),
            ]),
          ],
          [
            "image.svg",
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          ],
          ["huge.png", await readFile(file("huge.png"))],
        ])
          await a("/assets?name=" + name, {
            method: "POST",
            bytes,
            expected: 400,
          });
        for (const name of [
          "landscape.mp4",
          "portrait.mp4",
          "rotated.mp4",
          "photo.jpg",
          "alpha.png",
          "opaque.webp",
        ])
          assets[name] = (
            await a("/assets?name=" + name, {
              method: "POST",
              bytes: await readFile(file(name)),
              expected: 201,
            })
          ).value;
        assert.equal(assets["photo.jpg"].kind, "image");
        assert.deepEqual(
          [assets["photo.jpg"].width, assets["photo.jpg"].height],
          [300, 400],
        );
        assert.deepEqual(
          [assets["rotated.mp4"].width, assets["rotated.mp4"].height],
          [360, 640],
        );
        const stored = await a(
          "/assets/" + assets["photo.jpg"].id + "/content",
          { binary: true },
        );
        assert.equal(stored.headers.get("content-type"), "image/jpeg");
        assert(!stored.value.includes(Buffer.from("SECRET-METADATA")));
        assert(!stored.value.includes(Buffer.from("Exif\0\0", "latin1")));
        const png = await a("/assets/" + assets["alpha.png"].id + "/content", {
          binary: true,
        });
        assert.equal(png.headers.get("content-type"), "image/png");
        const webp = await a(
          "/assets/" + assets["opaque.webp"].id + "/content",
          {
            headers: { Range: "bytes=0-1" },
            binary: true,
            expected: 206,
          },
        );
        assert.equal(webp.value.toString("hex"), "ffd8");
        await b("/assets/" + assets["alpha.png"].id + "/content", {
          binary: true,
          expected: 404,
        });
      },
    );
    let template;
    await t.test(
      "templates validam propriedade, tipo de mídia e revisão",
      async () => {
        const draft = defaultTemplate("post", "Template QA");
        draft.profile.handle = "viceclipz";
        template = (
          await a("/projects", { method: "POST", data: draft, expected: 201 })
        ).value;
        assert.equal(template.kind, "template");
        await b("/projects/" + template.id, { expected: 404 });
        const video = slotList(template).find((s) => s.type === "video");
        await a("/projects/" + template.id, {
          method: "PUT",
          data: {
            ...template,
            media: {
              [video.id]: [{ id: "opt1", assetId: assets["alpha.png"].id }],
            },
          },
          expected: 400,
        });
        await b("/projects", {
          method: "POST",
          data: {
            ...draft,
            media: {
              [video.id]: [{ id: "opt1", assetId: assets["landscape.mp4"].id }],
            },
          },
          expected: 404,
        });
        await a("/projects", {
          method: "POST",
          data: {
            name: "Clássico",
            headline: "",
            assetId: assets["alpha.png"].id,
            template: "neon",
            format: "9:16",
            start: 0,
            end: 1,
          },
          expected: 400,
        });
        await a("/projects/" + template.id, {
          method: "PUT",
          data: { ...template, layout: "carousel" },
          expected: 400,
        });
        const saved = (
          await a("/projects/" + template.id, {
            method: "PUT",
            data: { ...template, name: "Renomeado" },
          })
        ).value;
        await a("/projects/" + template.id, {
          method: "PUT",
          data: template,
          expected: 409,
        });
        template = saved;
        await a("/jobs", {
          method: "POST",
          data: { projectId: template.id },
          expected: 409,
        });
      },
    );
    await t.test("prévia devolve PNG e geometria consistente", async () => {
      const { value } = await a("/templates/preview", {
        method: "POST",
        data: {
          ...template,
          phrase: "POV: a prévia e o MP4 usam a mesma geometria",
        },
      });
      assert.match(value.image, /^data:image\/png;base64,/);
      const bands = value.layout.bands.reduce((n, band) => n + band.height, 0),
        zones = value.layout.zones.reduce((n, zone) => n + zone.height, 0);
      assert.equal(bands + zones, 1280);
      await b("/templates/preview", {
        method: "POST",
        data: {
          ...template,
          phrase: "x",
          profile: {
            ...template.profile,
            avatar: true,
            avatarAssetId: assets["alpha.png"].id,
          },
        },
        expected: 404,
      });
    });
    const id = () => assets;
    const cases = [
      {
        preset: "single",
        layout: "post",
        picks: {
          video: [
            [
              {
                assetId: id()["landscape.mp4"].id,
                start: 0.5,
                end: 2.5,
                zoom: 1.4,
                x: 30,
                y: 60,
              },
            ],
          ],
          image: [],
        },
        duration: 2,
        audio: true,
        check: (pixel, layout) => {
          const card = layout.bands[0];
          assert(
            near(pixel(10, card.y + 6), [255, 255, 255]),
            "post card is white",
          );
        },
      },
      {
        preset: "blur",
        layout: "meme",
        picks: {
          video: [[{ assetId: id()["landscape.mp4"].id, start: 0, end: 1.5 }]],
          image: [],
        },
        duration: 1.5,
        audio: true,
        check: (pixel, layout) => {
          const zone = layout.zones[0];
          // Contained 16:9 video leaves room above it where the blurred copy must show.
          const blurred = pixel(360, zone.y + 8);
          assert(
            blurred.reduce((n, v) => n + v, 0) > 60,
            "blurred background visible: " + blurred,
          );
        },
      },
      {
        preset: "stacked",
        layout: "viral",
        mute: true,
        picks: {
          video: [
            [{ assetId: id()["landscape.mp4"].id, start: 1, end: 3.5 }],
            [{ assetId: id()["portrait.mp4"].id, start: 0, end: 1.5 }],
          ],
          image: [],
        },
        duration: 2.5,
        audio: false,
      },
      {
        preset: "image-video",
        layout: "post",
        order: "text-top",
        picks: {
          image: [[{ assetId: id()["alpha.png"].id, zoom: 1.5, x: 20, y: 80 }]],
          video: [[{ assetId: id()["rotated.mp4"].id, start: 0, end: 1.2 }]],
        },
        duration: 1.2,
        audio: true,
      },
      {
        preset: "video-images",
        layout: "viral",
        profile: true,
        picks: {
          video: [[{ assetId: id()["landscape.mp4"].id, start: 0, end: 1.5 }]],
          image: [
            [{ assetId: id()["photo.jpg"].id }],
            [{ assetId: id()["opaque.webp"].id }],
          ],
        },
        duration: 1.5,
        audio: true,
        check: (pixel, layout) => {
          const right = layout.zones[1].cells[1];
          assert(
            near(
              pixel(right.x + right.width / 2, right.y + right.height / 2),
              [58, 196, 125],
            ),
            "right image cell",
          );
        },
      },
    ];
    assert.deepEqual(
      cases.map((c) => c.preset).sort(),
      Object.keys(PRESETS).sort(),
    );
    const rendered = [];
    for (const c of cases)
      await t.test(
        `preset ${c.preset} (${c.layout}) gera MP4 720×1280 válido`,
        async () => {
          let draft = applyPreset(
            defaultTemplate(c.layout, "Template QA"),
            c.preset,
          );
          draft.profile.handle = "viceclipz";
          if (c.order) draft.profile.order = c.order;
          if (c.profile)
            Object.assign(draft.profile, {
              avatar: true,
              avatarAssetId: assets["alpha.png"].id,
              showName: true,
              showHandle: true,
              verified: true,
            });
          draft.mute = Boolean(c.mute);
          draft = withMedia(
            draft,
            { video: [...c.picks.video], image: [...c.picks.image] },
            ["POV: preset " + c.preset + " renderizado com ação e emoção"],
          );
          const project = (
            await a("/projects", { method: "POST", data: draft, expected: 201 })
          ).value;
          const { value: preview } = await a("/templates/preview", {
            method: "POST",
            data: { ...project, phrase: project.phrases[0].text },
          });
          const batch = (
            await a(`/templates/${project.id}/batches`, {
              method: "POST",
              data: { requestKey: randomUUID(), revision: project.revision },
              expected: 202,
            })
          ).value;
          assert.equal(batch.total, 1);
          const done = await waitBatch(a, batch.id),
            item = done.items[0];
          assert.equal(item.state, "done", item.error + "\n" + logs);
          const out = file(`preset-${c.preset}.mp4`);
          await writeFile(
            out,
            (await a(`/jobs/${item.id}/download`, { binary: true })).value,
          );
          const meta = await metadata(out),
            video = meta.streams.find((s) => s.codec_type === "video");
          assert.deepEqual(
            [video.width, video.height, video.codec_name, video.pix_fmt],
            [720, 1280, "h264", "yuv420p"],
          );
          assert(
            Math.abs(Number(meta.format.duration) - c.duration) < 0.2,
            `duration ${meta.format.duration} vs ${c.duration}`,
          );
          assert.equal(
            meta.streams.some((s) => s.codec_type === "audio"),
            c.audio,
          );
          await processRun(ffmpeg, [
            "-v",
            "error",
            "-i",
            out,
            "-f",
            "null",
            "-",
          ]);
          const pixel = await frame(
            out,
            Math.min(0.5, c.duration / 2),
            file(`preset-${c.preset}.png`),
          );
          c.check?.(pixel, preview.layout);
          rendered.push({
            preset: c.preset,
            layout: c.layout,
            duration: Number(meta.format.duration),
          });
        },
      );
    let multi;
    await t.test(
      "lote combina mídias × frases, reserva cota por item e respeita duas operações ativas",
      async () => {
        let draft = applyPreset(
          defaultTemplate("meme", "Template QA"),
          "single",
        );
        draft.profile.handle = "viceclipz";
        draft = withMedia(
          draft,
          {
            video: [
              [
                { assetId: assets["landscape.mp4"].id, start: 0, end: 1 },
                { assetId: assets["landscape.mp4"].id, start: 2, end: 3 },
              ],
            ],
            image: [],
          },
          ["Frase A", "Frase B"],
        );
        const project = (
          await a("/projects", { method: "POST", data: draft, expected: 201 })
        ).value;
        const before = (await a("/templates/limits")).value.renders.used,
          key = randomUUID();
        multi = (
          await a(`/templates/${project.id}/batches`, {
            method: "POST",
            data: { requestKey: key, revision: project.revision },
            expected: 202,
          })
        ).value;
        assert.equal(multi.total, 4);
        const repeat = (
          await a(`/templates/${project.id}/batches`, {
            method: "POST",
            data: { requestKey: key, revision: project.revision },
          })
        ).value;
        assert.equal(repeat.id, multi.id);
        assert.equal(
          (await a("/templates/limits")).value.renders.used,
          before + 4,
        );
        await b("/batches/" + multi.id, { expected: 404 });
        await b("/batches/" + multi.id + "/cancel", {
          method: "POST",
          expected: 404,
        });
        const second = (
          await a(`/templates/${project.id}/batches`, {
            method: "POST",
            data: { requestKey: randomUUID(), revision: project.revision },
            expected: 202,
          })
        ).value;
        await a(`/templates/${project.id}/batches`, {
          method: "POST",
          data: { requestKey: randomUUID(), revision: project.revision },
          expected: 409,
        });
        const legacy = (
          await a("/projects", {
            method: "POST",
            data: {
              name: "Clássico",
              headline: "",
              assetId: assets["landscape.mp4"].id,
              template: "neon",
              format: "9:16",
              start: 0,
              end: 1,
            },
            expected: 201,
          })
        ).value;
        await a("/jobs", {
          method: "POST",
          data: { projectId: legacy.id },
          expected: 409,
        });
        const detail = (await a("/batches/" + second.id)).value;
        assert(
          detail.items.every((i) => i.state !== "queued" || i.position >= 1),
        );
        const cancelled = (
          await a("/batches/" + second.id + "/cancel", { method: "POST" })
        ).value;
        assert(
          cancelled.items.every((i) =>
            ["cancelled", "cancelling", "done"].includes(i.state),
          ),
        );
        await waitBatch(a, second.id);
        const settled = (await a("/batches/" + second.id)).value;
        const kept = settled.items.filter((i) => i.state === "done").length;
        assert.equal(
          (await a("/templates/limits")).value.renders.used,
          before + 4 + kept,
        );
        const retried = (
          await a("/batches/" + second.id + "/retry", {
            method: "POST",
            expected: 202,
          })
        ).value;
        assert.equal(
          (await a("/templates/limits")).value.renders.used,
          before + 8,
        );
        assert(retried.items.every((i) => i.state !== "failed"));
        const first = await waitBatch(a, multi.id),
          again = await waitBatch(a, second.id);
        assert(
          first.items.every((i) => i.state === "done"),
          JSON.stringify(first.items) + logs,
        );
        assert(
          again.items.every((i) => i.state === "done"),
          JSON.stringify(again.items) + logs,
        );
        assert.equal(
          (await a("/templates/limits")).value.renders.used,
          before + 8,
        );
        assert.deepEqual(
          first.items.map((i) => i.phrase),
          ["Frase A", "Frase A", "Frase B", "Frase B"],
        );
        await a("/batches/" + second.id, { method: "DELETE" });
        await a("/batches/" + second.id, { expected: 404 });
        assert.equal(
          (await a("/templates/limits")).value.renders.used,
          before + 8,
        );
      },
    );
    await t.test(
      "ZIP do lote é transmitido com CRC e tamanhos corretos",
      async () => {
        await b("/batches/" + multi.id + "/archive", {
          binary: true,
          expected: 404,
        });
        const { value: zip, headers } = await a(
          "/batches/" + multi.id + "/archive",
          { binary: true },
        );
        assert.equal(headers.get("content-type"), "application/zip");
        assert.equal(Number(headers.get("content-length")), zip.length);
        const entries = readZip(zip),
          detail = (await a("/batches/" + multi.id)).value;
        assert.deepEqual(
          entries.map((e) => e.name),
          [
            "variacao-01.mp4",
            "variacao-02.mp4",
            "variacao-03.mp4",
            "variacao-04.mp4",
          ],
        );
        for (const [i, entry] of entries.entries()) {
          assert.equal(crc32(entry.data) >>> 0, entry.crc);
          const direct = (
            await a(`/jobs/${detail.items[i].id}/download`, { binary: true })
          ).value;
          assert(direct.equals(entry.data));
        }
      },
    );
    await t.test(
      "arquivos usados por templates não podem ser removidos",
      async () => {
        await a("/assets/" + assets["photo.jpg"].id, {
          method: "DELETE",
          expected: 409,
        });
        await a("/assets/" + assets["landscape.mp4"].id, {
          method: "DELETE",
          expected: 409,
        });
        const spare = (
          await a("/assets?name=spare.png", {
            method: "POST",
            bytes: await readFile(file("alpha.png")),
            expected: 201,
          })
        ).value;
        await a("/assets/" + spare.id, { method: "DELETE" });
      },
    );
    await writeFile(
      file("summary.json"),
      JSON.stringify({ testedAt: new Date().toISOString(), rendered }, null, 2),
    );
    console.log("Evidence: " + results);
  } finally {
    await stop();
    await writeFile(file("server.log"), logs);
  }
});
