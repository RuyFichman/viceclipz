import { one, run } from "./db.mjs";
import { planFor, seal, unseal } from "./launch-store.mjs";
import { productionAdapter } from "./social.mjs";
export function recoverPosts() {
  run(
    "UPDATE scheduled_posts SET status='needs_review',error='O serviço foi interrompido após iniciar o envio. Confira a rede antes de marcar o resultado.',updated=? WHERE status='publishing'",
    Date.now(),
  );
  run(
    "UPDATE scheduled_posts SET status='queued',next_run=?,updated=? WHERE status='preparing'",
    Date.now(),
    Date.now(),
  );
}
export async function processPost(
  adapter = productionAdapter,
  now = Date.now(),
) {
  const post = one(
    "SELECT * FROM scheduled_posts WHERE status IN ('queued','processing') AND next_run<=? ORDER BY next_run LIMIT 1",
    now,
  );
  if (!post) return;
  const connection = one(
    "SELECT * FROM social_connections WHERE id=? AND user_id=?",
    post.connection_id,
    post.user_id,
  );
  if (
    !connection ||
    connection.state !== "connected" ||
    !planFor(post.user_id).social
  ) {
    run(
      "UPDATE scheduled_posts SET status='failed',error='Reconecte a conta e verifique sua assinatura.',updated=? WHERE id=?",
      now,
      post.id,
    );
    return;
  }
  if (now - post.due > 24 * 3600000) {
    run(
      "UPDATE scheduled_posts SET status='failed',error='Agendamento vencido há mais de 24 horas. Reagende para evitar publicação tardia.',updated=? WHERE id=?",
      now,
      post.id,
    );
    return;
  }
  try {
    if (post.status === "queued") {
      const claimed = run(
        "UPDATE scheduled_posts SET status='preparing',attempts=attempts+1,updated=? WHERE id=? AND status='queued'",
        now,
        post.id,
      );
      if (!claimed.changes) return;
      const checkpoint = await adapter.prepare(post, connection);
      run(
        "UPDATE scheduled_posts SET status='processing',checkpoint=?,next_run=?,updated=?,error=NULL WHERE id=? AND status='preparing'",
        seal(checkpoint),
        now + 5000,
        now,
        post.id,
      );
      return;
    }
    if (now - post.updated > 3600000) {
      run(
        "UPDATE scheduled_posts SET status='failed',error='O provedor não concluiu o processamento em uma hora.',updated=? WHERE id=?",
        now,
        post.id,
      );
      return;
    }
    const checkpoint = unseal(post.checkpoint);
    if (!(await adapter.ready(post, connection, checkpoint))) {
      run(
        "UPDATE scheduled_posts SET next_run=? WHERE id=?",
        now + 15000,
        post.id,
      );
      return;
    }
    const claimed = run(
      "UPDATE scheduled_posts SET status='publishing',updated=? WHERE id=? AND status='processing'",
      now,
      post.id,
    );
    if (!claimed.changes) return;
    const remote = await adapter.publish(post, connection, checkpoint);
    run(
      "UPDATE scheduled_posts SET status='published',remote_id=?,checkpoint=NULL,error=NULL,updated=? WHERE id=?",
      remote,
      Date.now(),
      post.id,
    );
  } catch {
    const latest = one(
      "SELECT status,attempts FROM scheduled_posts WHERE id=?",
      post.id,
    );
    if (!latest || ["cancelled", "published"].includes(latest.status)) return;
    if (latest.status === "publishing")
      run(
        "UPDATE scheduled_posts SET status='needs_review',error='O envio não foi confirmado. Confira a rede; não repetiremos automaticamente para evitar duplicação.',updated=? WHERE id=?",
        Date.now(),
        post.id,
      );
    else
      run(
        "UPDATE scheduled_posts SET status=?,next_run=?,error='Falha ao preparar a publicação. Verifique a conexão e o formato do vídeo.',updated=? WHERE id=?",
        latest.attempts >= 3 || post.status === "processing"
          ? "failed"
          : "queued",
        now + 60000 * Math.max(latest.attempts, 1),
        Date.now(),
        post.id,
      );
  }
}
