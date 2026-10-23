import { one, all } from "./db.mjs";
import { EXPORT_RESERVE } from "./config.mjs";
// One global worker renders sequentially. Queued jobs are interleaved per account
// (each account's oldest job first) so a 50-item batch cannot starve other users.
const ORDER = `SELECT * FROM (SELECT *,row_number() OVER (PARTITION BY user_id ORDER BY created,item_index,id) AS turn FROM jobs WHERE state='queued') ORDER BY turn,created,item_index,id`;
const ACTIVE = "('queued','running','cancelling')";
export const nextJob = () => one(ORDER + " LIMIT 1");
export const jobDuration = (snapshot) => {
  const spec = JSON.parse(snapshot);
  return spec.duration ?? spec.end - spec.start;
};
// A batch is one logical operation: its queued items do not count individually
// toward the two active exports allowed per account.
export function activeOperations(userId) {
  return Number(
    one(
      `SELECT (SELECT count(*) FROM jobs WHERE user_id=? AND batch_id IS NULL AND state IN ${ACTIVE})+(SELECT count(DISTINCT batch_id) FROM jobs WHERE user_id=? AND batch_id IS NOT NULL AND state IN ${ACTIVE}) AS n`,
      userId,
      userId,
    ).n,
  );
}
export const batchActive = (batchId) =>
  Boolean(
    one(
      `SELECT id FROM jobs WHERE batch_id=? AND state IN ${ACTIVE} LIMIT 1`,
      batchId,
    ),
  );
// Storage held for unfinished renders. Single exports keep the historical 100 MiB;
// batch items reserve their bitrate-bounded size (4 Mbit/s video + audio + VBV buffer).
export function reservedBytes(userId) {
  return Number(
    one(
      `SELECT coalesce(sum(coalesce(reserve,?)),0) AS n FROM jobs WHERE user_id=? AND state IN ${ACTIVE}`,
      EXPORT_RESERVE,
      userId,
    ).n,
  );
}
export const batchReserve = (duration) =>
  Math.min(EXPORT_RESERVE, Math.ceil(600000 * duration) + 4 * 1024 * 1024);
// Seconds of processing per second of output, from this server's recent renders.
export function renderRate() {
  const rows = all(
    "SELECT snapshot,started,updated FROM jobs WHERE state='done' AND started IS NOT NULL ORDER BY updated DESC LIMIT 20",
  );
  let work = 0,
    media = 0;
  for (const row of rows) {
    work += (row.updated - row.started) / 1000;
    media += jobDuration(row.snapshot);
  }
  return media > 0 ? work / media : null;
}
// Position 1 renders next. ETA is the time until the job finishes, or null without history.
export function queueEstimates() {
  const rate = renderRate(),
    running = one(
      "SELECT snapshot,progress FROM jobs WHERE state IN ('running','cancelling') LIMIT 1",
    );
  let ahead =
    running && rate
      ? jobDuration(running.snapshot) * rate * (1 - running.progress / 100)
      : 0;
  const estimates = new Map();
  all(ORDER).forEach((job, i) => {
    if (rate) ahead += jobDuration(job.snapshot) * rate;
    estimates.set(job.id, {
      position: i + 1,
      eta: rate ? Math.max(1, Math.round(ahead)) : null,
    });
  });
  return estimates;
}
