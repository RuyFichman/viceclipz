import {
  openSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { DATA } from "./config.mjs";
export function acquireServerLock() {
  const file = path.join(DATA, "server.lock");
  let handle;
  try {
    handle = openSync(file, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(readFileSync(file, "utf8"));
    if (!Number.isInteger(pid) || pid < 1)
      throw Error(
        "Lock inválido: confira o servidor antes de remover data/server.lock.",
      );
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") alive = false;
    }
    if (alive)
      throw Error(
        "Já existe um servidor usando DATA_DIR. Use apenas uma réplica.",
      );
    unlinkSync(file);
    handle = openSync(file, "wx");
  }
  writeFileSync(handle, String(process.pid));
  closeSync(handle);
  process.once("exit", () => {
    try {
      if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file);
    } catch {}
  });
}
