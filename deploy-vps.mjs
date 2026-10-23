import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Remote side: builds the uploaded release next to the live one, swaps the
// directories only after a successful build and waits for the healthcheck.
// The server-only .env always comes from the live directory.
const remoteScript = `
set -euo pipefail
mode="$1"; name="$2"; rev="\${3:-}"
dir="$HOME/$name"; next="$dir.next"; prev="$dir.prev"
compose() { docker compose -p "$name" --project-directory "$1" -f "$1/compose.vps.yaml" "\${@:2}"; }
[ -f "$dir/.env" ] || { echo "Falta $dir/.env no servidor." >&2; exit 1; }
if [ "$mode" = rollback ]; then
  [ -d "$prev" ] || { echo "Não há versão anterior para restaurar." >&2; exit 1; }
  rm -rf -- "$next"
  mv "$prev" "$next"
fi
cp -p "$dir/.env" "$next/.env"
[ -n "$rev" ] && echo "$rev" > "$next/REVISION"
compose "$next" config -q
echo "== Construindo imagem"
nice -n 15 docker compose -p "$name" --project-directory "$next" -f "$next/compose.vps.yaml" build
rm -rf -- "$prev"
mv "$dir" "$prev"
mv "$next" "$dir"
echo "== Reiniciando contêiner"
compose "$dir" up -d
status=starting
for _ in $(seq 1 50); do
  status=$(docker inspect -f '{{.State.Health.Status}}' viceclipz 2>/dev/null || echo missing)
  [ "$status" = healthy ] || [ "$status" = unhealthy ] && break
  sleep 3
done
if [ "$status" != healthy ]; then
  docker logs --tail 40 viceclipz 2>&1 || true
  echo "Contêiner não ficou saudável ($status). Para voltar: node deploy-vps.mjs <destino> --rollback" >&2
  exit 1
fi
docker image prune -f --filter "label=com.docker.compose.project=$name" >/dev/null || true
echo "== Versão no ar: $(cat "$dir/REVISION" 2>/dev/null || echo desconhecida)"
echo "ORIGIN=$(grep -m1 '^APP_ORIGIN=' "$dir/.env" | cut -d= -f2-)"
`;

export function deployOptions(argv, env = process.env) {
  const options = {
    target: env.VPS_TARGET,
    key: env.VPS_KEY,
    dir: "viceclipz",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rollback") options.rollback = true;
    else if (arg === "--key" || arg === "--dir")
      options[arg.slice(2)] = argv[++i];
    else if (!arg.startsWith("-")) options.target = arg;
    else throw Error("Opção desconhecida: " + arg);
  }
  if (
    !/^([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(options.target || "")
  )
    throw Error(
      "Uso: node deploy-vps.mjs usuario@host [--key ARQUIVO] [--dir PASTA] [--rollback]",
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options.dir || ""))
    throw Error(
      "--dir deve ser o nome de uma pasta na home do usuário remoto.",
    );
  if (options.key?.startsWith("~"))
    options.key = path.join(os.homedir(), options.key.slice(1));
  return options;
}

function run(command, args, { input, stdin, capture } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdin || input ? "pipe" : "inherit", "pipe", "inherit"],
    });
    if (stdin) stdin.pipe(child.stdin);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!capture) process.stdout.write(chunk);
    });
    if (input) child.stdin.end(input);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(Error(`${command} terminou com código ${code}.`)),
    );
  });
}

export async function deploy(options) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const git = (...args) =>
    run(
      "git",
      [
        "-c",
        "safe.directory=" + root.replaceAll("\\", "/"),
        "-C",
        root,
        ...args,
      ],
      { capture: true },
    );
  const ssh = (command, extra) =>
    run(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        ...(options.key ? ["-i", options.key, "-o", "IdentitiesOnly=yes"] : []),
        options.target,
        command,
      ],
      extra,
    );
  const args = [options.rollback ? "rollback" : "deploy", options.dir];
  if (!options.rollback) {
    const revision = (await git("rev-parse", "--short", "HEAD")).trim();
    if ((await git("status", "--porcelain")).trim())
      console.warn(
        "Aviso: alterações não commitadas não são enviadas; o deploy usa o commit " +
          revision +
          ".",
      );
    console.log(`== Enviando ${revision} para ${options.target}`);
    const archive = spawn(
      "git",
      [
        "-c",
        "safe.directory=" + root.replaceAll("\\", "/"),
        "-C",
        root,
        "archive",
        "--format=tar",
        "HEAD",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const archived = new Promise((resolve, reject) =>
      archive.on("close", (code) =>
        code === 0 ? resolve() : reject(Error("git archive falhou.")),
      ),
    );
    await Promise.all([
      ssh(
        `set -e; rm -rf -- "$HOME/${options.dir}.next"; mkdir -p "$HOME/${options.dir}.next"; tar -x -C "$HOME/${options.dir}.next"`,
        { stdin: archive.stdout },
      ),
      archived,
    ]);
    args.push(revision);
  }
  const output = await ssh("bash -s -- " + args.join(" "), {
    input: remoteScript,
  });
  const origin = output.match(/^ORIGIN=(https:\/\/\S+)$/m)?.[1];
  if (!origin) return;
  const health = await fetch(origin + "/api/health", {
    signal: AbortSignal.timeout(15000),
  })
    .then((response) => response.json())
    .catch(() => null);
  if (!health?.worker || !health?.automation)
    throw Error(
      `O contêiner está saudável, mas ${origin}/api/health não respondeu como esperado.`,
    );
  console.log(`== ${origin} no ar: worker e automation ativos.`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await deploy(deployOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
