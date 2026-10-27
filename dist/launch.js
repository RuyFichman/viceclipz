import { openAccountDeletion } from "./account.js";
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
  requestKey = null;
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
  $("#main").insertBefore(s, $("#main footer"));
  const a = element("a", title);
  a.prepend(
    element(
      "span",
      { integrations: "◎", publishing: "↗", billing: "◇", account: "◉" }[id],
    ),
  );
  a.href = "#" + id;
  a.dataset.nav = id;
  $('nav[aria-label="Navegação principal"]').append(a);
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
publishing.append(action("＋ Agendar publicação", () => openSchedule()));
const scheduleList = element("div", "", "launch-list");
scheduleList.id = "schedule-list";
publishing.append(scheduleList);
const billing = section(
  "billing",
  "Seu plano",
  "Acompanhe seu uso e gerencie sua assinatura com segurança.",
);
billing.innerHTML +=
  '<div id="billing-summary" class="launch-card"></div><div id="plan-cards" class="launch-grid"></div><p class="field-help">A assinatura só libera os recursos após confirmação do Stripe. A cota de exportações renova no primeiro dia de cada mês, em UTC. Exportações concluídas contam mesmo depois de removidas.</p>';
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
  if (!ready.length) throw Error("Exporte um MP4 antes de agendar.");
  if (!info.enabled) {
    location.hash = "billing";
    throw Error("Escolha um plano com publicação social.");
  }
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
            ? "Requer um plano com publicação social."
            : c?.state === "connected"
              ? "Conectada e pronta para agendar."
              : "Autorize com segurança no site da rede.",
      ),
    );
    card.append(
      action(
        c?.state === "connected"
          ? "Reconectar"
          : "Conectar " + names[p.provider],
        async () => {
          location.assign(
            (await api("/integrations/" + p.provider + "/connect", "POST")).url,
          );
        },
        !p.configured || !info.enabled,
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
async function plans() {
  const info = await api("/billing"),
    summary = $("#billing-summary");
  summary.replaceChildren(
    element("p", "PLANO ATUAL", "eyebrow"),
    element("h2", info.plan.name),
    element(
      "p",
      info.used +
        " exportações usadas neste mês" +
        (info.plan.key === "local" ? "" : " de " + info.plan.renders),
    ),
    element(
      "small",
      info.configured
        ? info.mode === "test"
          ? "Stripe em modo de teste. Não use cartões reais."
          : "Cobrança processada pelo Stripe."
        : "As assinaturas estarão disponíveis após configuração do serviço.",
    ),
  );
  if (info.subscription)
    summary.append(
      element(
        "p",
        "Assinatura: " +
          info.subscription.status +
          (info.subscription.cancel_at_end
            ? " · cancelamento ao fim do período"
            : ""),
      ),
      action(
        "Gerenciar assinatura",
        async () => location.assign((await api("/billing/portal", "POST")).url),
        !info.configured,
      ),
    );
  const target = $("#plan-cards");
  target.replaceChildren();
  for (const p of info.plans) {
    const card = element("article", "", "launch-card");
    card.append(
      element("h2", p.name),
      element(
        "p",
        p.key === "free"
          ? "Sem cobrança"
          : p.price
            ? priceText(p.price)
            : "Preço exibido no checkout",
        "plan-price",
      ),
      element("p", p.renders + " exportações / mês"),
      element("p", p.storage / 1024 ** 3 + " GB para seus arquivos"),
      element(
        "p",
        p.social
          ? "Agendamento para redes conectadas"
          : "Edição e exportação MP4",
      ),
    );
    if (p.key !== "free")
      card.append(
        action(
          p.price ? "Assinar " + p.name : "Ver preço e assinar",
          async () =>
            location.assign(
              (await api("/billing/checkout", "POST", { plan: p.key })).url,
            ),
          !info.configured ||
            Boolean(
              info.subscription &&
              !["canceled", "incomplete_expired"].includes(
                info.subscription.status,
              ),
            ),
        ),
      );
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
  refreshLaunch();
});
setInterval(() => {
  if (!document.hidden) refreshLaunch();
}, 15000);
