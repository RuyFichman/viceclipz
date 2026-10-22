import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename, copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 4187,
  origin = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  data = path.join(root, ".test-data-" + runId),
  results = path.join(root, "test-results", runId);
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
      `${method} ${route}: ${JSON.stringify(value).slice(0, 500)}`,
    );
    return { value, headers: res.headers };
  };
}
async function waitJob(c, id, states = ["done", "failed", "cancelled"]) {
  for (let i = 0; i < 600; i++) {
    const { value } = await c("/jobs/" + id);
    if (states.includes(value.state)) return value;
    await delay(100);
  }
  throw Error("Render timeout: " + logs);
}
await test("MVP: contas, isolamento, uploads persistentes e renderização real", async (t) => {
  await mkdir(results, { recursive: true });
  const source = path.join(results, "source.mp4"),
    silent = path.join(results, "silent.mp4");
  await processRun(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
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
    "-movflags",
    "+faststart",
    source,
  ]);
  await processRun(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    source,
    "-an",
    "-c:v",
    "copy",
    silent,
  ]);
  const a = client(),
    b = client(),
    guest = client(),
    password = "Integration-" + randomUUID(),
    email = "a-" + runId + "@example.test";
  let asset, project, firstJob;
  try {
    await start();
    await t.test(
      "cadastro, hash de senha, sessão HttpOnly, login e CSRF",
      async () => {
        const res = await a("/auth/register", {
          method: "POST",
          data: { name: "Creator A", email, password },
          expected: 201,
        });
        assert.match(res.headers.get("set-cookie"), /HttpOnly/);
        assert.match(res.headers.get("set-cookie"), /SameSite=Strict/);
        await a("/auth/register", {
          method: "POST",
          data: { name: "Creator A", email, password },
          expected: 409,
        });
        await b("/auth/register", {
          method: "POST",
          data: {
            name: "Creator B",
            email: "b-" + runId + "@example.test",
            password,
          },
          expected: 201,
        });
        await guest("/projects", { expected: 401 });
        await a("/auth/logout", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
          expected: 403,
        });
        await a("/auth/logout", { method: "POST" });
        await a("/auth/me", { expected: 401 });
        await a("/auth/login", {
          method: "POST",
          data: { email, password: "wrong-password" },
          expected: 401,
        });
        await a("/auth/login", { method: "POST", data: { email, password } });
        const db = new DatabaseSync(path.join(data, "viceclipz.sqlite"));
        assert.notEqual(
          db.prepare("SELECT password FROM users WHERE email=?").get(email)
            .password,
          password,
        );
        db.close();
      },
    );
    await t.test(
      "upload validado, arquivo persistente, range e isolamento da biblioteca",
      async () => {
        await a("/assets?name=invalid.mp4", {
          method: "POST",
          bytes: Buffer.from("not a video"),
          expected: 400,
        });
        asset = (
          await a("/assets?name=source.mp4", {
            method: "POST",
            bytes: await readFile(source),
            expected: 201,
          })
        ).value;
        assert.ok(asset.duration >= 4);
        assert.equal(asset.hasAudio, true);
        assert.equal((await b("/assets")).value.length, 0);
        await b("/assets/" + asset.id + "/content", { expected: 404 });
        await b("/assets/" + asset.id, { method: "DELETE", expected: 404 });
        const range = await a("/assets/" + asset.id + "/content", {
          headers: { Range: "bytes=0-31" },
          binary: true,
          expected: 206,
        });
        assert.equal(range.value.length, 32);
        const end = await a("/assets/" + asset.id + "/content", {
          headers: { Range: "bytes=-16" },
          binary: true,
          expected: 206,
        });
        assert.equal(end.value.length, 16);
      },
    );
    const draft = {
      name: "Teste de exportação",
      headline: "Olá! 100%: vídeo 'seguro' — ação",
      assetId: null,
      template: "neon",
      format: "9:16",
      start: 0.5,
      end: 2.5,
      fontSize: 42,
      position: "bottom",
      fit: "cover",
      mute: false,
      date: "2026-10-23",
    };
    await t.test(
      "edição validada, revisões e bloqueio de acesso entre contas",
      async () => {
        draft.assetId = asset.id;
        project = (
          await a("/projects", { method: "POST", data: draft, expected: 201 })
        ).value;
        await b("/projects/" + project.id, { expected: 404 });
        await b("/projects/" + project.id, {
          method: "PUT",
          data: project,
          expected: 404,
        });
        await b("/projects", { method: "POST", data: draft, expected: 404 });
        await b("/projects/" + project.id, { method: "DELETE", expected: 404 });
        await a("/projects/" + project.id, {
          method: "PUT",
          data: { ...project, end: 900 },
          expected: 400,
        });
        await a("/projects/" + project.id, {
          method: "PUT",
          data: { ...project, start: 3, end: 2 },
          expected: 400,
        });
        const older = project;
        project = (
          await a("/projects/" + project.id, {
            method: "PUT",
            data: { ...project, name: "Projeto atualizado" },
          })
        ).value;
        await a("/projects/" + project.id, {
          method: "PUT",
          data: older,
          expected: 409,
        });
        await a("/assets/" + asset.id, { method: "DELETE", expected: 409 });
        const img = await a("/overlay", {
          method: "POST",
          data: project,
          binary: true,
        });
        assert.equal(img.value.subarray(1, 4).toString(), "PNG");
        await writeFile(path.join(results, "overlay.png"), img.value);
      },
    );
    for (const [format, width, height, mute, fit] of [
      ["9:16", 720, 1280, false, "cover"],
      ["1:1", 720, 720, true, "contain"],
      ["4:5", 720, 900, false, "cover"],
    ])
      await t.test(
        "MP4 real " + format + " com corte, headline e áudio correto",
        async () => {
          project = (
            await a("/projects/" + project.id, {
              method: "PUT",
              data: { ...project, format, mute, fit },
            })
          ).value;
          const job = (
            await a("/jobs", {
              method: "POST",
              data: { projectId: project.id },
              expected: 202,
            })
          ).value;
          firstJob ??= job;
          const repeat = (
            await a("/jobs", {
              method: "POST",
              data: { projectId: project.id },
              expected: 200,
            })
          ).value;
          assert.equal(repeat.id, job.id);
          for (const action of ["", "/download"])
            await b("/jobs/" + job.id + action, { expected: 404 });
          for (const action of ["cancel", "retry"])
            await b("/jobs/" + job.id + "/" + action, {
              method: "POST",
              expected: 404,
            });
          const finished = await waitJob(a, job.id);
          assert.equal(finished.state, "done", logs);
          assert.equal(finished.progress, 100);
          const file = path.join(
            results,
            "export-" + format.replace(":", "x") + ".mp4",
          );
          await writeFile(
            file,
            (await a("/jobs/" + job.id + "/download", { binary: true })).value,
          );
          const metadata = JSON.parse(
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
          const v = metadata.streams.find((s) => s.codec_type === "video");
          assert.equal(v.width, width);
          assert.equal(v.height, height);
          assert.equal(v.codec_name, "h264");
          assert.equal(v.pix_fmt, "yuv420p");
          assert.ok(Math.abs(Number(metadata.format.duration) - 2) < 0.15);
          assert.equal(
            metadata.streams.some((s) => s.codec_type === "audio"),
            !mute,
          );
          await processRun(ffmpeg, [
            "-v",
            "error",
            "-i",
            file,
            "-f",
            "null",
            "-",
          ]);
          if (format === "9:16")
            await processRun(ffmpeg, [
              "-v",
              "error",
              "-y",
              "-i",
              file,
              "-frames:v",
              "1",
              path.join(results, "export-frame.png"),
            ]);
        },
      );
    await t.test("vídeo sem áudio exporta normalmente", async () => {
      const silentAsset = (
        await a("/assets?name=silent.mp4", {
          method: "POST",
          bytes: await readFile(silent),
          expected: 201,
        })
      ).value;
      assert.equal(silentAsset.hasAudio, false);
      const p = (
        await a("/projects", {
          method: "POST",
          data: {
            ...draft,
            assetId: silentAsset.id,
            headline: "",
            format: "1:1",
          },
          expected: 201,
        })
      ).value;
      const j = (
        await a("/jobs", {
          method: "POST",
          data: { projectId: p.id },
          expected: 202,
        })
      ).value;
      assert.equal((await waitJob(a, j.id)).state, "done", logs);
    });
    await t.test(
      "limites de armazenamento e de dois jobs ativos por conta",
      async () => {
        const p = (
          await a("/projects", {
            method: "POST",
            data: { ...draft, name: "Verificar limites", end: 4 },
            expected: 201,
          })
        ).value;
        const db = new DatabaseSync(path.join(data, "viceclipz.sqlite"));
        const prior = db
          .prepare("SELECT size FROM assets WHERE id=?")
          .get(asset.id).size;
        try {
          db.prepare("UPDATE assets SET size=? WHERE id=?").run(
            2 * 1024 ** 3,
            asset.id,
          );
          await a("/jobs", {
            method: "POST",
            data: { projectId: p.id },
            expected: 409,
          });
          await a("/assets?name=source.mp4", {
            method: "POST",
            bytes: await readFile(source),
            expected: 409,
          });
        } finally {
          db.prepare("UPDATE assets SET size=? WHERE id=?").run(
            prior,
            asset.id,
          );
          db.close();
        }
        const p2 = (
          await a("/projects", {
            method: "POST",
            data: { ...draft, name: "Segunda vaga", end: 4 },
            expected: 201,
          })
        ).value;
        const p3 = (
          await a("/projects", {
            method: "POST",
            data: { ...draft, name: "Terceira vaga", end: 4 },
            expected: 201,
          })
        ).value;
        const j1 = (
          await a("/jobs", {
            method: "POST",
            data: { projectId: p.id },
            expected: 202,
          })
        ).value;
        const j2 = (
          await a("/jobs", {
            method: "POST",
            data: { projectId: p2.id },
            expected: 202,
          })
        ).value;
        await a("/jobs", {
          method: "POST",
          data: { projectId: p3.id },
          expected: 409,
        });
        assert.equal(
          (await waitJob(a, j1.id, ["running", "done"])).state,
          "running",
        );
        await a("/jobs/" + j1.id + "/cancel", { method: "POST" });
        await a("/jobs/" + j2.id + "/cancel", { method: "POST" });
        assert.equal((await waitJob(a, j1.id)).state, "cancelled");
        assert.equal((await waitJob(a, j2.id)).state, "cancelled");
      },
    );
    await t.test("cancelamento, retry e recuperação de falha", async () => {
      project = (
        await a("/projects/" + project.id, {
          method: "PUT",
          data: {
            ...project,
            headline: "Cancelar esta exportação",
            start: 0,
            end: 4,
          },
        })
      ).value;
      let j = (
        await a("/jobs", {
          method: "POST",
          data: { projectId: project.id },
          expected: 202,
        })
      ).value;
      await a("/jobs/" + j.id + "/cancel", { method: "POST" });
      assert.equal((await waitJob(a, j.id)).state, "cancelled");
      await a("/jobs/" + j.id + "/download", { expected: 409 });
      await a("/jobs/" + j.id + "/retry", { method: "POST", expected: 202 });
      assert.equal((await waitJob(a, j.id)).state, "done", logs);
      project = (
        await a("/projects/" + project.id, {
          method: "PUT",
          data: { ...project, headline: "Recuperar render" },
        })
      ).value;
      const original = path.join(data, "assets", asset.id + ".media"),
        held = original + ".held";
      await rename(original, held);
      try {
        j = (
          await a("/jobs", {
            method: "POST",
            data: { projectId: project.id },
            expected: 202,
          })
        ).value;
        assert.equal((await waitJob(a, j.id)).state, "failed");
      } finally {
        await rename(held, original);
      }
      await a("/jobs/" + j.id + "/retry", { method: "POST", expected: 202 });
      const recovered = await waitJob(a, j.id);
      assert.equal(recovered.state, "done", logs);
      assert.equal(recovered.attempts, 2);
    });
    await t.test(
      "reinício recupera job interrompido e preserva contas e arquivos",
      async () => {
        const p = (
          await a("/projects", {
            method: "POST",
            data: { ...draft, name: "Interromper processo", end: 4 },
            expected: 201,
          })
        ).value;
        const j = (
          await a("/jobs", {
            method: "POST",
            data: { projectId: p.id },
            expected: 202,
          })
        ).value;
        assert.equal(
          (await waitJob(a, j.id, ["running", "done"])).state,
          "running",
        );
        await stop();
        await start();
        assert.equal((await a("/auth/me")).value.user.email, email);
        assert.equal(
          (await a("/projects/" + project.id)).value.name,
          "Projeto atualizado",
        );
        assert.ok((await a("/assets")).value.length >= 2);
        await a("/jobs/" + firstJob.id + "/download", { binary: true });
        assert.equal((await a("/jobs/" + j.id)).value.state, "failed");
        await a("/jobs/" + j.id + "/retry", { method: "POST", expected: 202 });
        assert.equal((await waitJob(a, j.id)).state, "done", logs);
      },
    );
    await t.test(
      "remoção libera espaço e invalida arquivo da exportação",
      async () => {
        const before = (await a("/auth/me")).value.usage;
        await a("/jobs/" + firstJob.id, { method: "DELETE" });
        await a("/jobs/" + firstJob.id + "/download", { expected: 404 });
        assert.ok((await a("/auth/me")).value.usage < before);
      },
    );
    await writeFile(
      path.join(results, "summary.json"),
      JSON.stringify(
        {
          testedAt: new Date().toISOString(),
          formats: ["720x1280", "720x720", "720x900"],
          codec: "h264",
          duration: 2,
          checks: [
            "accounts",
            "session cookies",
            "CSRF",
            "tenant isolation",
            "upload validation",
            "range requests",
            "optimistic concurrency",
            "idempotency",
            "trim",
            "audio",
            "silent input",
            "cancel",
            "retry",
            "restart persistence",
            "storage release",
          ],
        },
        null,
        2,
      ),
    );
    console.log("Evidence: " + results);
  } finally {
    await stop();
    await writeFile(path.join(results, "server.log"), logs);
  }
});
