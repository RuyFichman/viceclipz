import { run } from "./lib/db.mjs";
import { recoverPosts, processPost } from "./lib/scheduler.mjs";
import { processBilling } from "./lib/billing.mjs";
import { processAccountMail, recoverAccountMail } from "./lib/account.mjs";
recoverPosts();
recoverAccountMail();
let busy = false,
  stopping = false;
async function tick() {
  if (busy || stopping) return;
  busy = true;
  try {
    run(
      "INSERT INTO service_heartbeats VALUES(?,?) ON CONFLICT(name) DO UPDATE SET updated=excluded.updated",
      "automation",
      Date.now(),
    );
    await processAccountMail();
    await processBilling();
    await processPost();
  } catch {
    console.error("Automation cycle failed. See persisted job status.");
  } finally {
    busy = false;
  }
}
const timer = setInterval(tick, 3000);
tick();
function stop() {
  stopping = true;
  clearInterval(timer);
  const check = setInterval(() => {
    if (!busy) {
      clearInterval(check);
      process.exit(0);
    }
  }, 100);
}
process.on("message", (m) => {
  if (m === "stop") stop();
});
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.send?.("ready");
