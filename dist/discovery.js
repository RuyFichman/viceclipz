const $ = (s) => document.querySelector(s);
const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
let active = false,
  generation = 0;
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
function page(id, title, copy) {
  const s = el("section", "", "page launch-page");
  s.id = id;
  s.hidden = true;
  const heading = el("div", "", "heading"),
    wrap = el("div");
  wrap.append(
    el("p", "CRIE COM INTENÇÃO", "eyebrow"),
    el("h1", title),
    el("p", copy),
  );
  heading.append(wrap);
  s.append(heading);
  $("#main").insertBefore(s, $("#main footer"));
  const link = el("a", title);
  link.href = "#" + id;
  link.dataset.nav = id;
  link.prepend(el("span", id === "discovery" ? "⌕" : "▥"));
  $('nav[aria-label="Navegação principal"]').append(link);
  return s;
}
const discovery = page(
  "discovery",
  "Descobrir conteúdo",
  "Reúna referências de sites, feeds RSS/Atom, Instagram e TikTok. Cada coleta preserva a origem.",
);
discovery.innerHTML += `<form id="discovery-form" class="launch-card"><label for="source-url">Link público</label><div class="collect-row"><input id="source-url" type="url" required maxlength="2048" placeholder="https://…" aria-describedby="source-help"><button class="primary" type="submit">Coletar referências</button></div><p id="source-help" class="field-help">Sites: uma página ou até 20 itens de um feed. Instagram primeiro, TikTok também disponível por link completo de publicação. Sem perfis privados ou links curtos.</p><p class="field-help">Coletamos título, trecho e autoria. Para editar um vídeo, envie um arquivo que você tem autorização para usar em Meus vídeos.</p></form><p id="discovery-message" role="status"></p><div id="reference-list" class="launch-grid"></div>`;
const metrics = page(
  "metrics",
  "Métricas do estúdio",
  "Dados da sua conta. Atualize para acompanhar suas exportações e publicações.",
);
metrics.innerHTML += `<button class="secondary" id="refresh-metrics">Atualizar métricas</button><p id="metrics-message" role="status"></p><div id="metrics-cards" class="launch-grid"></div><div id="metrics-detail" class="launch-card"></div><p class="field-help">Contagens de arquivos, estados e tempo médio consideram registros atualmente mantidos. O tempo inclui espera na fila. O histórico de uso mantém exportações concluídas mesmo após exclusão, agrupadas pela data de solicitação em UTC. Não são métricas de audiência das redes sociais.</p>`;
function button(text, fn) {
  const b = el("button", text, "secondary");
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    const ticket = generation;
    try {
      await fn();
    } catch (e) {
      if (active && ticket === generation)
        $("#discovery-message").textContent = e.message;
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
async function references(ticket = generation) {
  const rows = await api("/discovery");
  if (!active || ticket !== generation) return;
  $("#reference-list").replaceChildren();
  if (!rows.length)
    $("#reference-list").append(
      el(
        "p",
        "Sua biblioteca de referências está vazia. Cole um link acima para começar.",
        "launch-card",
      ),
    );
  for (const row of rows) {
    const card = el("article", "", "launch-card");
    card.append(
      el("p", row.provider.toUpperCase(), "eyebrow"),
      el("h2", row.title),
      el("p", row.description),
      el("small", row.author || new URL(row.url).hostname),
    );
    const link = el("a", "Abrir fonte ↗", "secondary");
    link.href = row.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    card.append(link);
    card.append(
      button("Criar rascunho", async () => {
        await api("/discovery/" + row.id + "/project", "POST", {});
        if (active && ticket === generation) {
          $("#discovery-message").textContent =
            "Rascunho criado. Abra Meus projetos para adicionar seu vídeo e texto.";
          window.dispatchEvent(new Event("viceclipz:projects-changed"));
        }
      }),
    );
    card.append(
      button("Remover referência", async () => {
        await api("/discovery/" + row.id, "DELETE");
        await references(ticket);
      }),
    );
    $("#reference-list").append(card);
  }
}
const states = {
  done: "Concluídas",
  queued: "Na fila",
  running: "Processando",
  failed: "Falharam",
  cancelled: "Canceladas",
  cancelling: "Cancelando",
  published: "Publicadas",
  preparing: "Preparando",
  processing: "Processando na rede",
  publishing: "Enviando",
  needs_review: "Conferir na rede",
};
async function renderMetrics(ticket = generation) {
  const data = await api("/metrics");
  if (!active || ticket !== generation) return;
  $("#metrics-message").textContent =
    "Atualizado em " + new Date(data.generatedAt).toLocaleString("pt-BR");
  $("#metrics-cards").replaceChildren(
    ...[
      ["Projetos", data.projects],
      ["Vídeos", data.assets],
      ["Referências", data.references],
      ["Armazenamento", (data.storageBytes / 1024 ** 2).toFixed(1) + " MB"],
      [
        "Tempo médio de exportação",
        data.averageExportSeconds === null
          ? "Ainda sem dados"
          : data.averageExportSeconds.toFixed(1) + " s",
      ],
    ].map(([label, value]) => {
      const card = el("article", "", "launch-card");
      card.append(el("p", label), el("h2", String(value)));
      return card;
    }),
  );
  const detail = $("#metrics-detail");
  detail.replaceChildren();
  for (const [title, rows] of [
    ["Exportações", data.exports],
    ["Publicações", data.publications],
  ]) {
    detail.append(el("h2", title));
    if (!rows.length) detail.append(el("p", "Ainda sem registros."));
    for (const row of rows)
      detail.append(el("p", `${states[row.state] || row.state}: ${row.count}`));
  }
  detail.append(el("h2", "Exportações concluídas • últimos 30 dias"));
  if (!data.daily.length)
    detail.append(el("p", "Nenhuma exportação concluída no período."));
  else {
    const table = el("table");
    const head = el("tr");
    head.append(el("th", "Data (UTC)"), el("th", "Quantidade"));
    table.append(head);
    for (const row of data.daily) {
      const tr = el("tr");
      tr.append(el("td", row.day), el("td", String(row.count)));
      table.append(tr);
    }
    detail.append(table);
  }
}
async function refresh() {
  const ticket = generation,
    route = location.hash;
  if (!active) return;
  try {
    if (route === "#discovery") await references(ticket);
    if (route === "#metrics") await renderMetrics(ticket);
  } catch (e) {
    if (active && ticket === generation)
      $(
        route === "#metrics" ? "#metrics-message" : "#discovery-message",
      ).textContent = e.message;
  }
}
$("#discovery-form").onsubmit = async (event) => {
  event.preventDefault();
  const ticket = generation,
    b = $("#discovery-form button");
  b.disabled = true;
  $("#discovery-message").textContent = "Consultando a fonte…";
  try {
    const result = await api("/discovery", "POST", {
      url: $("#source-url").value,
    });
    if (active && ticket === generation) {
      $("#discovery-message").textContent =
        `${result.collected} referências consultadas, ${result.added} novas.`;
      await references(ticket);
    }
  } catch (e) {
    if (active && ticket === generation)
      $("#discovery-message").textContent = e.message;
  } finally {
    b.disabled = false;
  }
};
$("#refresh-metrics").onclick = refresh;
window.addEventListener("hashchange", refresh);
export function setDiscoverySession(value) {
  active = value;
  generation++;
  if (value) refresh();
  else {
    for (const id of [
      "reference-list",
      "metrics-cards",
      "metrics-detail",
      "metrics-message",
      "discovery-message",
    ])
      $("#" + id).replaceChildren();
    $("#source-url").value = "";
  }
}
