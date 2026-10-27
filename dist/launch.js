import { openAccountDeletion } from "./account.js";
import { bytes, integer, plural } from "./format.js";
const $ = (s) => document.querySelector(s);
const names = { instagram: "Instagram", youtube: "YouTube" };
const states = {
  queued: "Agendado",
  preparing: "Preparando",
  processing: "Processando na rede",
  publishing: "Enviando",
  published: "Publicado",
  cancelled: "Cancelado",
  failed: "Falhou",
  needs_review: "Confira na rede",
};
let active = false,
  loading = false,
  requestKey = null,
  plan = null,
  upgrade = null,
  announce = false;
const UPGRADES = {
  social:
    "Agendar publicações e conectar suas redes fazem parte dos planos Creator e Studio.",
};
async function api(path, method = "GET", data) {
  const res = await fetch("/api" + path, {
    method,
    headers: {
      "X-ViceClipz": "studio",
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const value = await res.json();
  if (!res.ok) throw Error(value.error || "Não foi possível concluir.");
  return value;
}
function message(text) {
  $("#launch-message").textContent = text;
  $("#launch-message").hidden = !text;
}
function element(tag, text, cls) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function action(text, fn, disabled = false) {
  const b = element("button", text, "secondary");
  b.type = "button";
  b.disabled = disabled;
  b.onclick = async () => {
    b.disabled = true;
    message("");
    try {
      await fn();
    } catch (e) {
      message(e.message);
    } finally {
      b.disabled = disabled;
    }
  };
  return b;
}
// Paid features are marked before the click: a lock, the plan badge and a name
// that says which plans include them. Clicking explains it on Seu plano.
export function lockedButton(text, reason = "social") {
  const b = element("button", "", "secondary locked");
  b.type = "button";
  const lock = element("span", "", "lock-icon");
  lock.setAttribute("aria-hidden", "true");
  lock.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5A1.5 1.5 0 0 1 13.5 8.5v5A1.5 1.5 0 0 1 12 15H4a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 4 7h.5ZM6 7h4V5a2 2 0 1 0-4 0v2Z"/></svg>';
  b.append(
    lock,
    text,
    element("span", " — disponível nos planos ", "visually-hidden"),
    element("span", "Creator", "plan-badge"),
    element("span", " e Studio", "visually-hidden"),
  );
  b.onclick = () => showUpgrade(reason);
  return b;
}
export function showUpgrade(reason) {
  upgrade = reason;
  announce = true;
  if (location.hash === "#billing") refreshLaunch();
  else location.hash = "billing";
}
export function setLaunchPlan(value) {
  const changed = plan?.social !== value?.social;
  plan = value;
  if (changed) renderPublishAction();
}
function section(id, title, copy) {
  const s = element("section", "", "page launch-page");
  s.id = id;
  s.hidden = true;
  const heading = element("div", "", "heading");
  const text = element("div");
  text.append(
    element("p", "DO ESTÚDIO PARA O MUNDO", "eyebrow"),
    element("h1", title),
    element("p", copy),
  );
  heading.append(text);
  s.append(heading);
  // The sidebar link for this page lives in its group in index.html.
  $("#main").insertBefore(s, $("#main footer"));
  return s;
}
const integrations = section(
  "integrations",
  "Contas conectadas",
  "Autorize a rede para publicar os vídeos que você agendar.",
);
integrations.innerHTML +=
  '<div id="connection-cards" class="launch-grid"></div><p class="field-help">Instagram requer uma conta profissional. Ao desconectar, os agendamentos ainda não enviados são cancelados. Você também pode revogar o aplicativo nas configurações da rede.</p>';
const publishing = section(
  "publishing",
  "Publicações",
  "Escolha um MP4 pronto e defina quando ele deve ir ao ar.",
);
const publishAction = element("div", "", "actions");
publishing.append(publishAction);
function renderPublishAction() {
  publishAction.replaceChildren(
    plan && !plan.social
      ? lockedButton("Agendar publicação")
      : action("＋ Agendar publicação", () => openSchedule()),
  );
}
renderPublishAction();
const scheduleList = element("div", "", "launch-list");
scheduleList.id = "schedule-list";
publishing.append(scheduleList);
const billing = section(
  "billing",
  "Seu plano",
  "Acompanhe seu uso e gerencie sua assinatura com segurança.",
);
billing.innerHTML +=
  '<p id="plan-notice" class="plan-notice" tabindex="-1" hidden></p><div id="billing-summary" class="launch-card plan-summary"></div><h2 class="plans-title">Compare os planos</h2><div id="plan-cards" class="launch-grid plan-cards"></div><p class="field-help">A assinatura só libera os recursos depois que o Stripe confirma o pagamento. A cota de exportações renova no primeiro dia de cada mês, em UTC. Cada MP4 concluído conta uma exportação, inclusive cada variação de um lote, e continua contando mesmo depois de removido; falhas e cancelamentos devolvem a cota.</p>';
const account = section(
  "account",
  "Sua conta",
  "Seus dados de acesso, documentos e a exclusão da conta.",
);
account.querySelector(".eyebrow").textContent = "PRIVACIDADE E CONTROLE";
account.innerHTML +=
  '<div class="launch-grid"><article class="launch-card"><h2>Dados de acesso</h2><p id="account-name"></p><p id="account-address"></p><small>Para trocar a senha, saia e use Esqueci minha senha na tela de entrada.</small></article><article class="launch-card"><h2>Documentos</h2><p><a href="/termos" target="_blank" rel="noopener">Termos de uso ↗</a></p><p><a href="/privacidade" target="_blank" rel="noopener">Política de privacidade ↗</a></p><p><a href="/retencao" target="_blank" rel="noopener">Política de retenção ↗</a></p><p><a href="/suporte" target="_blank" rel="noopener">Suporte e contato ↗</a></p></article><article class="launch-card" id="account-removal"><h2>Excluir conta</h2><p>Remove definitivamente seu cadastro, arquivos, projetos, exportações, conexões e agendamentos deste servidor.</p><small>Cancele antes qualquer assinatura ativa. Publicações já feitas continuam nas redes.</small></article></div>';
const removeButton = element("button", "Excluir minha conta", "danger");
removeButton.type = "button";
removeButton.onclick = openAccountDeletion;
$("#account-removal").append(removeButton);
const alert = element("p", "", "error");
alert.id = "launch-message";
alert.setAttribute("role", "status");
alert.hidden = true;
$("#main").prepend(alert);
const dialog = document.createElement("dialog");
dialog.id = "schedule-dialog";
dialog.innerHTML = `<form id="schedule-form"><div class="section-heading"><h2>Agendar publicação</h2><button type="button" id="schedule-close" class="secondary">Fechar</button></div><p>O MP4 será enviado automaticamente para a conta escolhida.</p><label>MP4 exportado<select id="schedule-job" required></select></label><label>Conta de destino<select id="schedule-connection" required></select></label><label>Título<input id="schedule-title" required maxlength="100"></label><label>Legenda<textarea id="schedule-caption" maxlength="2200" rows="3"></textarea></label><label>Data e horário<input id="schedule-due" type="datetime-local" required></label><p id="schedule-zone" class="field-help"></p><label id="privacy-label">Visibilidade<select id="schedule-privacy" required><option value="private">Privado</option><option value="unlisted">Não listado</option><option value="public">Público</option></select></label><label id="kids-label">Este vídeo é feito para crianças?<select id="schedule-kids" required><option value="">Selecione</option><option value="false">Não</option><option value="true">Sim</option></select></label><p id="schedule-notice" class="field-help"></p><p id="schedule-error" class="error" role="alert"></p><button class="primary" id="schedule-submit">Confirmar agendamento</button></form>`;
document.body.append(dialog);
$("#schedule-close").onclick = () => dialog.close();
export async function openSchedule(jobId) {
  const [jobs, info] = await Promise.all([api("/jobs"), api("/integrations")]);
  const ready = jobs.filter((j) => j.state === "done"),
    connections = info.connections.filter(
      (c) =>
        c.state === "connected" &&
        info.providers.some((p) => p.provider === c.provider && p.configured),
    );
  if (!info.enabled) return showUpgrade("social");
  if (!ready.length) throw Error("Exporte um MP4 antes de agendar.");
  if (!connections.length) {
    location.hash = "integrations";
    throw Error("Conecte uma conta antes de agendar.");
  }
  $("#schedule-form").reset();
  $("#schedule-error").textContent = "";
  requestKey = crypto.randomUUID();
  const populate = (select, list, label) => {
    select.replaceChildren();
    for (const item of list) {
      const o = element("option", label(item));
      o.value = item.id;
      select.append(o);
    }
  };
  populate($("#schedule-job"), ready, (j) => j.name + " · " + j.format);
  if (jobId) $("#schedule-job").value = jobId;
  populate(
    $("#schedule-connection"),
    connections,
    (c) => names[c.provider] + " · " + c.label,
  );
  const update = () => {
    const instagram =
      connections.find((c) => c.id === $("#schedule-connection").value)
        .provider === "instagram";
    $("#privacy-label").hidden = instagram;
    $("#kids-label").hidden = instagram;
    $("#schedule-kids").required = !instagram;
    $("#schedule-notice").textContent = instagram
      ? "Este agendamento publicará um Reel em sua conta do Instagram. Use um MP4 vertical de pelo menos 3 segundos."
      : "A visibilidade selecionada será enviada ao YouTube. Contas de aplicativos ainda não aprovados podem ter restrições.";
    $("#schedule-caption").maxLength = instagram ? 2200 : 5000;
  };
  $("#schedule-connection").onchange = update;
  update();
  $("#schedule-title").value =
    ready.find((j) => j.id === $("#schedule-job").value)?.name || "";
  const date = new Date(Date.now() + 3600000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  $("#schedule-due").value = date.toISOString().slice(0, 16);
  $("#schedule-zone").textContent =
    "Fuso deste dispositivo: " +
    Intl.DateTimeFormat().resolvedOptions().timeZone +
    ". A publicação pode levar alguns minutos para concluir.";
  dialog.showModal();
}
$("#schedule-form").onsubmit = async (e) => {
  e.preventDefault();
  const submit = $("#schedule-submit");
  submit.disabled = true;
  try {
    await api("/schedules", "POST", {
      requestKey,
      jobId: $("#schedule-job").value,
      connectionId: $("#schedule-connection").value,
      title: $("#schedule-title").value,
      caption: $("#schedule-caption").value,
      due: new Date($("#schedule-due").value).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      privacy: $("#schedule-privacy").value,
      madeForKids: $("#schedule-kids").value === "true",
    });
    dialog.close();
    location.hash = "publishing";
    await refreshLaunch();
    message("Publicação agendada. Você pode fechar o navegador.");
  } catch (error) {
    $("#schedule-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
async function connections() {
  const info = await api("/integrations");
  const target = $("#connection-cards");
  target.replaceChildren();
  for (const p of info.providers) {
    const c = info.connections.find((c) => c.provider === p.provider);
    const card = element("article", "", "launch-card");
    card.append(
      element("p", p.provider === "instagram" ? "◎" : "▷", "network-icon"),
      element("h2", names[p.provider]),
      element(
        "p",
        c?.state === "connected"
          ? c.label
          : c?.state === "reconnect"
            ? "Reconecte sua conta"
            : "Nenhuma conta conectada",
      ),
      element(
        "small",
        !p.configured
          ? "Disponível após configuração do serviço."
          : !info.enabled
            ? "Disponível nos planos Creator e Studio."
            : c?.state === "connected"
              ? "Conectada e pronta para agendar."
              : "Autorize com segurança no site da rede.",
      ),
    );
    const label =
      c?.state === "connected" ? "Reconectar" : "Conectar " + names[p.provider];
    card.append(
      p.configured && !info.enabled
        ? lockedButton(label)
        : action(
            label,
            async () => {
              location.assign(
                (await api("/integrations/" + p.provider + "/connect", "POST"))
                  .url,
              );
            },
            !p.configured,
          ),
    );
    if (c && c.state !== "disconnected")
      card.append(
        action("Desconectar", async () => {
          if (
            !confirm(
              "Desconectar esta conta e cancelar os agendamentos ainda não enviados?",
            )
          )
            return;
          await api("/connections/" + c.id, "DELETE");
          await refreshLaunch();
        }),
      );
    target.append(card);
  }
}
async function schedules() {
  const posts = await api("/schedules"),
    target = $("#schedule-list");
  target.replaceChildren();
  if (!posts.length)
    target.append(
      element(
        "p",
        "Nenhuma publicação agendada. Seus MP4s prontos aparecem ao clicar em Agendar publicação.",
        "launch-empty",
      ),
    );
  for (const p of posts) {
    const row = element("article", "", "launch-card");
    row.append(
      element("span", states[p.status] || p.status, "tag"),
      element("h3", p.title),
      element("p", names[p.provider] + " · " + p.label),
      element(
        "small",
        new Intl.DateTimeFormat("pt-BR", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: p.timezone,
        }).format(p.due) +
          " · " +
          p.timezone,
      ),
      element("p", p.error || ""),
    );
    const controls = element("div", "", "actions");
    if (["queued", "processing", "failed"].includes(p.status))
      controls.append(
        action("Cancelar", async () => {
          await api("/schedules/" + p.id + "/cancel", "POST");
          await refreshLaunch();
        }),
      );
    if (p.status === "needs_review")
      for (const [result, label] of [
        ["published", "Conferi: foi publicado"],
        ["cancelled", "Conferi: não foi publicado"],
      ])
        controls.append(
          action(label, async () => {
            if (
              !confirm(
                "Você conferiu o resultado diretamente na rede? Esta ação não envia o vídeo novamente.",
              )
            )
              return;
            await api("/schedules/" + p.id + "/resolve", "POST", { result });
            await refreshLaunch();
          }),
        );
    if (["failed", "cancelled", "published"].includes(p.status))
      controls.append(
        action("Remover registro", async () => {
          if (
            !confirm(
              "Remover este registro? Isso não apaga o conteúdo já publicado na rede.",
            )
          )
            return;
          await api("/schedules/" + p.id, "DELETE");
          await refreshLaunch();
        }),
      );
    row.append(controls);
    target.append(row);
  }
}
function priceText(price) {
  const format = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: price.currency,
  });
  const digits = format.resolvedOptions().maximumFractionDigits;
  return format.format(price.amount / 10 ** digits) + "/mês";
}
async function profile() {
  const { user } = await api("/auth/me");
  $("#account-name").textContent = user.name;
  $("#account-address").textContent = user.email;
}
const SUBSCRIPTION = {
  active: "Assinatura ativa",
  trialing: "Período de teste",
  past_due: "Pagamento em atraso",
  unpaid: "Pagamento não realizado",
  canceled: "Assinatura cancelada",
  incomplete: "Aguardando confirmação do pagamento",
  incomplete_expired: "Pagamento não concluído",
  paused: "Assinatura pausada",
};
const shortDate = (ms) => new Intl.DateTimeFormat("pt-BR").format(ms);
// The monthly quota is counted per calendar month in UTC.
function renewal() {
  const now = new Date(),
    next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return "1º/" + String(next.getUTCMonth() + 1).padStart(2, "0");
}
function meter(label, value, ratio, note) {
  const box = element("div", "", "plan-meter"),
    head = element("p"),
    bar = element("div", "", "meter"),
    fill = element("i");
  head.append(element("span", label), element("strong", value));
  bar.setAttribute("aria-hidden", "true");
  bar.hidden = ratio === null;
  bar.classList.toggle("full", ratio >= 0.9);
  fill.style.width = Math.min(100, (ratio || 0) * 100) + "%";
  bar.append(fill);
  box.append(head, bar, element("small", note));
  return box;
}
function feature(text, included = true) {
  const li = element("li", text, included ? "" : "no"),
    mark = element("span", included ? "✓" : "—");
  mark.setAttribute("aria-hidden", "true");
  li.prepend(mark);
  return li;
}
const portal = async () =>
  location.assign((await api("/billing/portal", "POST")).url);
async function plans() {
  const [info, me] = await Promise.all([api("/billing"), api("/auth/me")]),
    summary = $("#billing-summary"),
    notice = $("#plan-notice");
  notice.hidden = !upgrade;
  notice.textContent = upgrade
    ? UPGRADES[upgrade] +
      (info.configured
        ? " Compare os planos abaixo."
        : " Os planos pagos ainda não estão disponíveis para assinatura.")
    : "";
  if (upgrade && announce) {
    announce = false;
    notice.focus();
  }
  const local = info.plan.key === "local",
    sub = info.subscription,
    // Same rule the server uses to refuse a second checkout.
    subscribed = Boolean(
      sub && !["canceled", "incomplete_expired"].includes(sub.status),
    ),
    left = info.plan.renders - info.used,
    head = element("div", "", "plan-summary-head"),
    title = element("div"),
    meters = element("div", "", "plan-meters");
  title.append(
    element("p", "PLANO ATUAL", "eyebrow"),
    element("h2", info.plan.name),
  );
  if (sub)
    title.append(
      element(
        "p",
        (SUBSCRIPTION[sub.status] || "Assinatura: " + sub.status) +
          (sub.period_end && sub.cancel_at_end
            ? " · termina em " + shortDate(sub.period_end)
            : sub.period_end && sub.status === "active"
              ? " · renova em " + shortDate(sub.period_end)
              : ["past_due", "unpaid", "incomplete", "paused"].includes(
                    sub.status,
                  )
                ? " · resolva no portal do Stripe para liberar o plano"
                : ""),
        "plan-status",
      ),
    );
  head.append(title);
  if (sub && info.configured)
    head.append(action("Gerenciar assinatura", portal));
  meters.append(
    meter(
      "Exportações este mês",
      local
        ? integer(info.used)
        : integer(info.used) + " de " + integer(info.plan.renders),
      local ? null : info.used / info.plan.renders,
      local
        ? "Sem limite no desenvolvimento local."
        : (left <= 0 ? "Você usou todas as exportações deste mês. " : "") +
            "A cota renova em " +
            renewal() +
            " (UTC).",
    ),
    meter(
      "Armazenamento",
      bytes(me.usage) + " de " + bytes(me.storageLimit),
      me.usage / me.storageLimit,
      "Arquivos da biblioteca e MP4 exportados.",
    ),
  );
  summary.replaceChildren(
    head,
    meters,
    element(
      "small",
      !info.configured
        ? "As assinaturas ainda não estão disponíveis."
        : info.mode === "test"
          ? "Stripe em modo de teste. Não use cartões reais."
          : "Pagamentos processados com segurança pelo Stripe.",
    ),
  );
  const target = $("#plan-cards");
  target.replaceChildren();
  for (const p of info.plans) {
    const current = p.key === info.plan.key,
      recommended =
        p.key === "creator" && ["free", "local"].includes(info.plan.key),
      card = element("article", "", "launch-card plan-card"),
      features = element("ul", "", "plan-features"),
      actions = element("div", "", "plan-actions");
    card.classList.toggle("current", current);
    card.classList.toggle("recommended", recommended);
    if (current || recommended)
      card.append(
        element("p", current ? "Seu plano atual" : "Recomendado", "plan-flag"),
      );
    features.append(
      feature(plural(p.renders, "exportação", "exportações") + " por mês"),
      feature(bytes(p.storage) + " de armazenamento"),
      p.social
        ? feature("Publicação agendada nas redes conectadas")
        : feature("Sem publicação agendada", false),
    );
    card.append(
      element("h3", p.name),
      p.key === "free" || p.price
        ? element(
            "p",
            p.price ? priceText(p.price) : "Sem cobrança",
            "plan-price",
          )
        : element("small", "O preço aparece no checkout seguro do Stripe."),
      features,
    );
    // Every unavailable action says why, next to it.
    if (p.key === "free") {
      if (!current && subscribed)
        actions.append(
          element(
            "small",
            "Para voltar ao Grátis, cancele a assinatura no portal do Stripe.",
          ),
        );
    } else if (!current) {
      if (!info.configured)
        actions.append(
          action("Assinar " + p.name, async () => {}, true),
          element("small", "Assinaturas ainda não disponíveis."),
        );
      else if (subscribed)
        actions.append(
          action("Gerenciar assinatura", portal),
          element(
            "small",
            "Você já tem uma assinatura. Gerencie ou cancele no portal do Stripe antes de assinar outro plano.",
          ),
        );
      else {
        actions.append(
          action(
            p.price ? "Assinar " + p.name : "Ver preço e assinar",
            async () =>
              location.assign(
                (await api("/billing/checkout", "POST", { plan: p.key })).url,
              ),
          ),
        );
        if (info.mode === "test")
          actions.append(
            element("small", "Modo de teste: use apenas cartões de teste."),
          );
      }
    }
    if (actions.childNodes.length) card.append(actions);
    target.append(card);
  }
}
export async function refreshLaunch() {
  if (!active || loading) return;
  const page = location.hash.slice(1);
  const fn = {
    integrations: connections,
    publishing: schedules,
    billing: plans,
    account: profile,
  }[page];
  if (!fn) return;
  loading = true;
  try {
    await fn();
  } catch (e) {
    message(e.message);
  } finally {
    loading = false;
  }
}
export function setLaunchSession(value) {
  active = value;
  if (!value) {
    plan = null;
    upgrade = null;
    renderPublishAction();
    dialog.close();
    message("");
    for (const id of [
      "connection-cards",
      "schedule-list",
      "billing-summary",
      "plan-cards",
      "account-name",
      "account-address",
    ])
      $("#" + id).replaceChildren();
  } else {
    const status = new URLSearchParams(location.search).get("connection");
    if (status) {
      message(
        status === "success"
          ? "Conta conectada."
          : "Não foi possível conectar. Confira as permissões e tente novamente.",
      );
      history.replaceState(null, "", location.pathname + location.hash);
    }
    refreshLaunch();
  }
}
window.addEventListener("hashchange", () => {
  message("");
  if (location.hash !== "#billing") upgrade = null;
  refreshLaunch();
});
setInterval(() => {
  if (!document.hidden) refreshLaunch();
}, 15000);
