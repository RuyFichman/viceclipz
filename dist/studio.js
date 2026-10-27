import {
  lockedButton,
  openSchedule,
  setLaunchPlan,
  setLaunchSession,
} from "./launch.js";
import { setDiscoverySession } from "./discovery.js";
import { setTemplateSession, useAssetInTemplate } from "./templates.js";
import {
  accountHandlers,
  hideVerification,
  showVerification,
} from "./account.js";
import { bytes, seconds, plural } from "./format.js";
const $ = (s) => document.querySelector(s);
// Themes of the classic headline editor, kept for projects created before templates.
const templates = [
  {
    id: "neon",
    name: "Neon editorial",
    format: "9:16",
    tag: "GAMING / CULTURA",
    headline: "FORA DO<br>ÓBVIO.",
    description: "Contraste que prende o olhar",
  },
  {
    id: "lilac",
    name: "Recorte criativo",
    format: "1:1",
    tag: "IDEIAS / DESCOBERTAS",
    headline: "OUTRO<br>PONTO DE VISTA.",
    description: "Uma nova leitura do seu conteúdo",
  },
  {
    id: "rose",
    name: "Em movimento",
    format: "4:5",
    tag: "HISTÓRIAS / LIFESTYLE",
    headline: "DÊ PLAY<br>NA SUA IDEIA.",
    description: "Espaço para contar sua história",
  },
];
const dimensions = {
  "9:16": [720, 1280],
  "1:1": [720, 720],
  "4:5": [720, 900],
};
const templateLabels = {
  post: "Post card",
  meme: "Meme",
  viral: "Vídeo viral",
};
const labels = {
  overview: "Visão geral",
  projects: "Meus projetos",
  templates: "Templates",
  builder: "Editor de template",
  library: "Biblioteca",
  exports: "Exportações",
  calendar: "Calendário",
  integrations: "Contas conectadas",
  publishing: "Publicações",
  billing: "Seu plano",
  account: "Sua conta",
  discovery: "Descobrir conteúdo",
  metrics: "Métricas do estúdio",
};
let user = null,
  plan = null,
  projects = [],
  assets = [],
  jobs = [],
  editing = null,
  register = false,
  busy = false,
  uploading = false,
  overlayURL = null,
  previewSequence = 0,
  pollBusy = false;
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").hidden = true), 5000);
}
async function request(path, { method = "GET", data, raw = false } = {}) {
  const res = await fetch("/api" + path, {
    method,
    headers: {
      "X-ViceClipz": "studio",
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  if (!res.ok) {
    const error = await res
      .json()
      .catch(() => ({ error: "Não foi possível conectar ao servidor." }));
    if (res.status === 401 && !path.startsWith("/auth/")) showAuth();
    throw new Error(error.error || "Não foi possível concluir.");
  }
  return raw ? res.blob() : res.json();
}
function showAuth() {
  hideVerification();
  setLaunchSession(false);
  setDiscoverySession(false);
  setTemplateSession(null);
  user = null;
  plan = null;
  projects = [];
  assets = [];
  jobs = [];
  $("#app").hidden = true;
  $("#auth-screen").hidden = false;
  $("#editor").close();
  $("#more-sheet").close();
  $("#auth-password").value = "";
}
function setGlobalError(message = "") {
  $("#global-error").textContent = message;
  $("#global-error").hidden = !message;
}
async function load() {
  const session = await request("/auth/me");
  if (session.verification?.required && !session.verification.verified) {
    user = null;
    setLaunchSession(false);
    setDiscoverySession(false);
    setTemplateSession(null);
    showVerification(session);
    return;
  }
  hideVerification();
  const [p, a, j] = await Promise.all([
    request("/projects"),
    request("/assets"),
    request("/jobs"),
  ]);
  user = session.user;
  projects = p;
  assets = a;
  jobs = j;
  $("#auth-screen").hidden = true;
  $("#app").hidden = false;
  $("#user-name").textContent = user.name;
  $("#user-avatar").textContent = user.name.slice(0, 1).toUpperCase();
  storage(session);
  render();
  route();
  setGlobalError();
  setLaunchSession(true);
  setDiscoverySession(true);
  setTemplateSession(user);
}
function storage(session) {
  const { rendersUsed } = session,
    changed = plan?.social !== session.plan.social;
  plan = session.plan;
  setLaunchPlan(plan);
  // Scheduling buttons show the lock before the click; redraw when it changes.
  if (changed) renderJobs();
  $("#plan-label").textContent = "Plano " + plan.name;
  $("#usage-exports").textContent =
    plan.key === "local"
      ? plural(rendersUsed, "exportação", "exportações") + " este mês"
      : `${rendersUsed} de ${plural(plan.renders, "exportação", "exportações")} este mês`;
  $("#storage-label").textContent =
    `${bytes(session.usage)} de ${bytes(session.storageLimit)}`;
  $("#storage-bar").style.width =
    Math.min(100, (session.usage / session.storageLimit) * 100) + "%";
}
function route() {
  const hash = location.hash.slice(1).split("/")[0],
    page = Object.hasOwn(labels, hash) ? hash : "overview";
  document
    .querySelectorAll(".page")
    .forEach((el) => (el.hidden = el.id !== page));
  const nav = page === "builder" ? "templates" : page;
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.classList.toggle("active", el.dataset.nav === nav);
    if (el.dataset.nav === nav) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
  // Pages without a shortcut in the phone tab bar live under "Mais".
  const more = !$(`.tabbar [data-nav="${nav}"]`);
  $("#more-button").classList.toggle("active", more);
  $("#more-current").textContent = more
    ? ", página atual: " + labels[page]
    : "";
  $("#breadcrumb-group").textContent = $(`.side-nav [data-nav="${nav}"]`)
    .closest(".nav-group")
    .querySelector(".nav-label").textContent;
  $("#breadcrumb").textContent = labels[page];
  if ($("#more-sheet").open) $("#more-sheet").close();
}
// On phones the sidebar moves into the "Mais" sheet while it is open, so its
// links, plan card and logout button exist only once in the page.
function openMore() {
  $("#more-sheet .sheet-body").append($(".sidebar"));
  $("#more-sheet").showModal();
  $("#more-button").setAttribute("aria-expanded", "true");
}
$("#more-button").onclick = openMore;
$("#more-close").onclick = () => $("#more-sheet").close();
$("#more-sheet").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
$("#more-sheet").addEventListener("close", () => {
  $("#app").prepend($(".sidebar"));
  $("#more-button").setAttribute("aria-expanded", "false");
  $("#more-button").focus();
});
matchMedia("(min-width: 801px)").addEventListener("change", (e) => {
  if (e.matches && $("#more-sheet").open) $("#more-sheet").close();
});
function empty(el, title, copy) {
  el.innerHTML = '<div class="empty simple"><h3></h3><p></p></div>';
  el.querySelector("h3").textContent = title;
  el.querySelector("p").textContent = copy;
}
function button(text, action, style = "secondary") {
  const el = document.createElement("button");
  el.type = "button";
  el.className = style;
  el.textContent = text;
  el.onclick = async () => {
    el.disabled = true;
    try {
      await action();
    } catch (e) {
      toast(e.message);
    } finally {
      el.disabled = false;
    }
  };
  return el;
}
async function confirmRemove(message) {
  $("#confirm-message").textContent = message;
  const dialog = $("#confirm-dialog");
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "delete"),
      { once: true },
    ),
  );
}
function projectList(target, list) {
  target.replaceChildren();
  if (!list.length) {
    empty(
      target,
      "Espaço para a sua próxima ideia.",
      "Crie um projeto ou experimente outro termo de busca.",
    );
    return;
  }
  for (const p of list) {
    const el = document.createElement("article"),
      template = p.kind === "template";
    el.className = "project-row";
    el.innerHTML = `<span class="project-icon ${template ? "neon" : p.template}">${template ? "▦" : "▹"}</span><div><h3></h3><small></small></div><span class="draft"></span><div class="actions"></div>`;
    el.querySelector("h3").textContent = p.name;
    el.querySelector(".draft").textContent = template
      ? "Template"
      : "Vídeo com título";
    el.querySelector("small").textContent = template
      ? `${templateLabels[p.layout] || "Template"} · 9:16 · ${p.zones.length} ${p.zones.length === 1 ? "zona" : "zonas"} · ${p.phrases.length} ${p.phrases.length === 1 ? "frase" : "frases"}`
      : `${p.format} · ${p.assetId ? seconds(p.end - p.start) : "Sem vídeo"}${p.date ? " · Planejado: " + new Date(p.date + "T12:00:00").toLocaleDateString("pt-BR") : ""}`;
    el.querySelector(".actions").append(
      button("Editar ↗", () =>
        template ? (location.hash = "builder/" + p.id) : openEditor(p),
      ),
      button(
        "Remover",
        async () => {
          if (
            await confirmRemove(
              template
                ? "O template, seus lotes e as variações geradas serão removidos. Os arquivos continuarão na biblioteca."
                : "O projeto e suas exportações serão removidos. O vídeo original continuará na biblioteca.",
            )
          ) {
            await request("/projects/" + p.id, { method: "DELETE" });
            await refresh();
          }
        },
        "danger",
      ),
    );
    target.append(el);
  }
}
function renderAssets() {
  const target = $("#asset-list");
  target.replaceChildren();
  if (!assets.length) {
    empty(
      target,
      "Seu primeiro arquivo começa aqui.",
      "Envie vídeos MP4, MOV ou WebM e imagens PNG, JPEG ou WebP para usar nos seus templates.",
    );
    return;
  }
  for (const a of assets) {
    const el = document.createElement("article"),
      image = a.kind === "image";
    el.className = "project-row";
    el.innerHTML = image
      ? '<img class="asset-preview" alt="" loading="lazy" /><div><h3></h3><small></small></div><div class="actions"></div>'
      : '<span class="project-icon neon">▶</span><div><h3></h3><small></small></div><div class="actions"></div>';
    if (image) el.querySelector("img").src = "/api/assets/" + a.id + "/content";
    el.querySelector("h3").textContent = a.name;
    el.querySelector("small").textContent = image
      ? `Imagem · ${a.width} × ${a.height} · ${bytes(a.size)}`
      : `${seconds(a.duration)} · ${a.width} × ${a.height} · ${bytes(a.size)}`;
    el.querySelector(".actions").append(
      button("Usar em template ↗", () => useAssetInTemplate(a)),
      button(
        "Remover",
        async () => {
          if (
            await confirmRemove(
              "O arquivo original será removido do servidor. Arquivos em uso por projetos ou templates não podem ser removidos.",
            )
          ) {
            await request("/assets/" + a.id, { method: "DELETE" });
            await refresh();
          }
        },
        "danger",
      ),
    );
    target.append(el);
  }
}
const states = {
  queued: "Na fila",
  running: "Renderizando",
  cancelling: "Cancelando",
  done: "MP4 pronto",
  failed: "Falhou",
  cancelled: "Cancelado",
};
function renderJobs() {
  const target = $("#job-list");
  target.replaceChildren();
  if (!jobs.length) {
    empty(
      target,
      "Suas próximas exportações vão aparecer aqui.",
      "Gere variações em um template ou exporte um projeto com vídeo.",
    );
    return;
  }
  for (const j of jobs) {
    const el = document.createElement("article");
    el.className = "project-row";
    el.innerHTML =
      '<span class="project-icon neon">↓</span><div><h3></h3><small class="job-meta"></small><div class="job-progress"><i></i></div><div class="job-error"></div></div><div class="actions"></div>';
    el.querySelector("h3").textContent = j.name;
    el.querySelector(".job-meta").textContent =
      `${states[j.state] || j.state} · ${j.format}${j.state === "running" ? " · " + j.progress + "%" : ""}${j.state === "done" ? " · " + bytes(j.size) : ""}`;
    el.querySelector(".job-progress i").style.width = j.progress + "%";
    el.querySelector(".job-progress").hidden = ![
      "running",
      "queued",
      "cancelling",
    ].includes(j.state);
    el.querySelector(".job-error").textContent = j.error || "";
    const actions = el.querySelector(".actions");
    if (j.state === "done") {
      const link = document.createElement("a");
      link.className = "download-link";
      link.textContent = "Baixar MP4 ↓";
      link.href = "/api/jobs/" + j.id + "/download";
      link.download = "viceclipz.mp4";
      actions.append(link);
      actions.append(
        plan && !plan.social
          ? lockedButton("Agendar")
          : button("Agendar", () => openSchedule(j.id)),
      );
    }
    if (["running", "queued"].includes(j.state))
      actions.append(
        button("Cancelar", async () => {
          await request("/jobs/" + j.id + "/cancel", { method: "POST" });
          await poll();
        }),
      );
    if (["failed", "cancelled"].includes(j.state) && j.attempts < 3)
      actions.append(
        button("Tentar novamente", async () => {
          await request("/jobs/" + j.id + "/retry", { method: "POST" });
          await poll();
        }),
      );
    if (!["running", "queued", "cancelling"].includes(j.state))
      actions.append(
        button(
          "Remover",
          async () => {
            if (
              await confirmRemove(
                "Esta exportação será removida. Seu projeto continuará disponível para gerar um novo MP4.",
              )
            ) {
              await request("/jobs/" + j.id, { method: "DELETE" });
              await refresh();
            }
          },
          "danger",
        ),
      );
    target.append(el);
  }
}
function stats() {
  $("#project-count").textContent = projects.length;
  $("#stat-projects").textContent = projects.length;
  $("#stat-assets").textContent = assets.length;
  $("#stat-exports").textContent = jobs.filter(
    (j) => j.state === "done",
  ).length;
  const active = jobs.filter((j) =>
    ["queued", "running", "cancelling"].includes(j.state),
  ).length;
  $("#stat-active").textContent = active;
  // Same number the Exportações page lists, so the badge never contradicts it.
  $("#job-count").textContent = jobs.length;
}
function render() {
  const q = $("#search").value.toLocaleLowerCase("pt-BR");
  projectList($("#recent-projects"), projects.slice(0, 3));
  projectList(
    $("#all-projects"),
    projects.filter((p) => p.name.toLocaleLowerCase("pt-BR").includes(q)),
  );
  projectList(
    $("#calendar-list"),
    projects.filter((p) => p.date).sort((a, b) => a.date.localeCompare(b.date)),
  );
  renderAssets();
  renderJobs();
  stats();
}
for (const event of ["viceclipz:projects-changed", "viceclipz:assets-changed"])
  window.addEventListener(event, () => {
    if (user) refresh().catch((error) => toast(error.message));
  });
async function refresh() {
  const [p, a, j, s] = await Promise.all([
    request("/projects"),
    request("/assets"),
    request("/jobs"),
    request("/auth/me"),
  ]);
  projects = p;
  assets = a;
  jobs = j;
  storage(s);
  render();
}
async function poll() {
  if (!user || pollBusy) return;
  pollBusy = true;
  try {
    const latest = await request("/jobs");
    if (JSON.stringify(latest) !== JSON.stringify(jobs)) {
      jobs = latest;
      renderJobs();
      stats();
      storage(await request("/auth/me"));
    }
    setGlobalError();
  } catch (e) {
    setGlobalError(e.message);
  } finally {
    pollBusy = false;
  }
}
function fillAssets() {
  const select = $("#asset-select");
  select.replaceChildren(new Option("Selecione um vídeo", ""));
  for (const a of assets)
    if (a.kind !== "image") select.append(new Option(a.name, a.id));
}
function clearPreview() {
  previewSequence++;
  clearTimeout(updatePreview.timer);
  $("#video-preview").pause();
  $("#video-preview").removeAttribute("src");
  $("#video-preview").load();
  if (overlayURL) URL.revokeObjectURL(overlayURL);
  overlayURL = null;
  $("#overlay-preview").hidden = true;
}
function openEditor(p = null, templateId = "neon") {
  editing = p;
  $("#project-form").reset();
  clearPreview();
  fillAssets();
  $("#form-status").textContent = "";
  $("#upload-status").textContent = "MP4, MOV ou WebM · até 100 MB.";
  $("#editor-heading").textContent = p ? "Editar projeto" : "Novo projeto";
  $("#project-name").value = p?.name || "";
  $("#headline").value = p?.headline || "";
  $("#template-select").value = p?.template || templateId;
  $("#format").value =
    p?.format || templates.find((t) => t.id === templateId).format;
  $("#position").value = p?.position || "bottom";
  $("#font-size").value = p?.fontSize || 42;
  $("#fit").value = p?.fit || "cover";
  $("#mute").checked = p?.mute || false;
  $("#planned-date").value = p?.date || "";
  $("#asset-select").value = p?.assetId || "";
  selectAsset(false);
  $("#trim-start").value = p?.start ?? 0;
  $("#trim-end").value =
    p?.end ?? Math.min(selectedAsset()?.duration || 10, 120);
  $("#editor").showModal();
  updatePreview();
  $("#project-name").focus();
}
function selectedAsset() {
  return assets.find((a) => a.id === $("#asset-select").value);
}
function selectAsset(reset = true) {
  const a = selectedAsset(),
    video = $("#video-preview");
  video.pause();
  if (a) {
    video.src = "/api/assets/" + a.id + "/content";
    video.hidden = false;
    $("#no-video").hidden = true;
    $("#upload-status").textContent =
      `${a.name} · ${seconds(a.duration, 2)} · ${bytes(a.size)} · salvo na biblioteca`;
  } else {
    video.removeAttribute("src");
    video.load();
    video.hidden = true;
    $("#no-video").hidden = false;
  }
  if (reset) {
    $("#trim-start").value = 0;
    $("#trim-end").value = Math.min(a?.duration || 10, 120);
  }
  $("#trim-end").max = a?.duration || 120;
  updatePreview();
}
function spec() {
  return {
    name: $("#project-name").value.trim(),
    headline: $("#headline").value.trim(),
    assetId: $("#asset-select").value || null,
    template: $("#template-select").value,
    format: $("#format").value,
    start: Number($("#trim-start").value),
    end: Number($("#trim-end").value),
    position: $("#position").value,
    fontSize: Number($("#font-size").value),
    fit: $("#fit").value,
    mute: $("#mute").checked,
    date: $("#planned-date").value,
    variants: editing?.variants || [],
    revision: editing?.revision,
  };
}
function updatePreview() {
  const s = spec(),
    seq = ++previewSequence;
  $("#composition").style.aspectRatio = s.format.replace(":", "/");
  $("#composition").style.setProperty(
    "--ratio",
    dimensions[s.format][0] / dimensions[s.format][1],
  );
  $("#preview-format").textContent = s.format;
  $("#export-dimensions").textContent = dimensions[s.format].join(" × ");
  $("#video-preview").style.objectFit = s.fit;
  $("#video-preview").muted = s.mute;
  clearTimeout(updatePreview.timer);
  updatePreview.timer = setTimeout(async () => {
    if (!$("#editor").open) return;
    try {
      const image = await request("/overlay", {
        method: "POST",
        data: { ...s, name: s.name || "Prévia" },
        raw: true,
      });
      if (seq !== previewSequence) return;
      if (overlayURL) URL.revokeObjectURL(overlayURL);
      overlayURL = URL.createObjectURL(image);
      $("#overlay-preview").src = overlayURL;
      $("#overlay-preview").hidden = false;
      $("#preview-status").textContent =
        "A prévia usa a mesma composição aplicada ao MP4.";
    } catch (e) {
      if (seq === previewSequence) {
        $("#overlay-preview").hidden = true;
        $("#preview-status").textContent = e.message;
      }
    }
  }, 200);
}
function setBusy(value) {
  busy = value;
  $("#editor")
    .querySelectorAll("input,select,button")
    .forEach((el) => (el.disabled = value));
}
function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (file.size > 100 * 1024 * 1024) {
      reject(new Error("Escolha um vídeo de até 100 MB."));
      return;
    }
    if (!/\.(mp4|mov|webm|png|jpe?g|webp)$/i.test(file.name)) {
      reject(
        new Error(
          "Escolha um vídeo MP4, MOV ou WebM ou uma imagem PNG, JPEG ou WebP.",
        ),
      );
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/assets?name=" + encodeURIComponent(file.name));
    xhr.setRequestHeader("X-ViceClipz", "studio");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = 300000;
    xhr.upload.onprogress = (e) =>
      onProgress(
        e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : 0,
      );
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || "Falha no upload."));
      } catch {
        reject(new Error("Resposta inválida do servidor."));
      }
    };
    xhr.onerror = () =>
      reject(new Error("Conexão interrompida. Tente enviar novamente."));
    xhr.ontimeout = () =>
      reject(new Error("O upload excedeu o tempo limite. Tente novamente."));
    xhr.send(file);
  });
}
async function uploadFile(file, status, intoEditor = false) {
  if (!file) return;
  if (uploading) throw new Error("Aguarde o upload atual.");
  uploading = true;
  if (intoEditor) setBusy(true);
  $("#library-upload").disabled = true;
  $("#upload-button").disabled = true;
  try {
    const a = await upload(
      file,
      (n) =>
        (status.textContent =
          n === 100 ? "Verificando arquivo…" : `Enviando arquivo… ${n}%`),
    );
    if (intoEditor && a.kind === "image")
      throw new Error(
        "Este editor usa apenas vídeos. A imagem foi salva na biblioteca.",
      );
    assets.unshift(a);
    status.textContent =
      a.kind === "image"
        ? "Imagem enviada e verificada."
        : "Vídeo enviado e verificado.";
    if (intoEditor) {
      fillAssets();
      $("#asset-select").value = a.id;
      selectAsset();
    }
    renderAssets();
    stats();
    storage(await request("/auth/me"));
    toast("Arquivo salvo na sua biblioteca.");
  } catch (e) {
    status.textContent = e.message;
  } finally {
    uploading = false;
    if (intoEditor) setBusy(false);
    $("#library-upload").disabled = false;
    $("#upload-button").disabled = false;
  }
}
async function save(exportAfter = false) {
  if (busy || !$("#project-form").reportValidity()) return;
  setBusy(true);
  $("#form-status").textContent = "Salvando projeto…";
  try {
    const s = spec();
    if (exportAfter && !s.assetId)
      throw new Error("Selecione ou envie um vídeo para exportar.");
    const saved = await request(
      editing ? "/projects/" + editing.id : "/projects",
      { method: editing ? "PUT" : "POST", data: s },
    );
    editing = saved;
    $("#form-status").textContent = "Projeto salvo.";
    if (exportAfter) {
      await request("/jobs", { method: "POST", data: { projectId: saved.id } });
      location.hash = "exports";
    }
    await refresh();
    $("#editor").close();
    toast(
      exportAfter
        ? "Exportação adicionada à fila."
        : "Projeto salvo na sua conta.",
    );
  } catch (e) {
    $("#form-status").textContent = e.message;
  } finally {
    setBusy(false);
  }
}
$("#auth-toggle").onclick = () => {
  register = !register;
  $("#name-label").hidden = !register;
  $("#auth-legal").hidden = !register;
  $("#auth-name").required = register;
  $("#auth-title").textContent = register
    ? "Seu próximo capítulo."
    : "Bom te ver por aqui.";
  $("#auth-copy").textContent = register
    ? "Crie sua conta e encontre seu ritmo."
    : "Entre para continuar criando.";
  $("#auth-submit").textContent = register
    ? "Criar minha conta ↗"
    : "Entrar no estúdio ↗";
  $("#auth-toggle").textContent = register
    ? "Já tem conta? Entrar"
    : "Ainda não tem conta? Criar conta";
  $("#auth-password").autocomplete = register
    ? "new-password"
    : "current-password";
  $("#auth-error").textContent = "";
};
$("#auth-form").onsubmit = async (e) => {
  e.preventDefault();
  $("#auth-submit").disabled = true;
  $("#auth-error").textContent = "";
  try {
    await request("/auth/" + (register ? "register" : "login"), {
      method: "POST",
      data: {
        name: $("#auth-name").value,
        email: $("#auth-email").value,
        password: $("#auth-password").value,
      },
    });
    $("#auth-password").value = "";
    await load();
  } catch (e) {
    $("#auth-error").textContent = e.message;
  } finally {
    $("#auth-submit").disabled = false;
  }
};
$("#logout").onclick = async () => {
  try {
    await request("/auth/logout", { method: "POST" });
    showAuth();
  } catch (e) {
    toast(e.message);
  }
};
for (const t of templates)
  $("#template-select").append(new Option(t.name, t.id));
document
  .querySelectorAll(".new-project")
  .forEach((b) => (b.onclick = () => (location.hash = "templates")));
$("#close-editor").onclick = () => {
  if (!busy) $("#editor").close();
};
$("#editor").addEventListener("cancel", (e) => {
  if (busy) e.preventDefault();
});
$("#editor").addEventListener("close", clearPreview);
$("#project-form").onsubmit = (e) => {
  e.preventDefault();
  save();
};
$("#export-project").onclick = () => save(true);
$("#search").oninput = render;
$("#asset-select").onchange = () => selectAsset();
for (const selector of [
  "#headline",
  "#format",
  "#template-select",
  "#position",
  "#font-size",
  "#fit",
  "#mute",
  "#trim-start",
  "#trim-end",
])
  $(selector).addEventListener("input", updatePreview);
$("#video-file").onchange = () =>
  uploadFile($("#video-file").files[0], $("#upload-status"), true).catch((e) =>
    toast(e.message),
  );
$("#library-upload").onchange = async () => {
  await uploadFile($("#library-upload").files[0], $("#library-status")).catch(
    (e) => toast(e.message),
  );
  $("#library-upload").value = "";
};
$("#play-preview").onclick = async () => {
  const video = $("#video-preview"),
    s = spec();
  if (!selectedAsset()) {
    toast("Selecione um vídeo.");
    return;
  }
  if (!video.paused) {
    video.pause();
    return;
  }
  if (
    !Number.isFinite(s.start) ||
    !Number.isFinite(s.end) ||
    s.start < 0 ||
    s.end <= s.start ||
    s.end > selectedAsset().duration + 0.05
  ) {
    toast("Revise o início e o fim do corte.");
    return;
  }
  video.currentTime = s.start;
  try {
    await video.play();
  } catch {
    $("#preview-status").textContent =
      "Este codec não pode ser reproduzido neste navegador. Você ainda pode tentar exportar para MP4.";
  }
};
$("#video-preview").ontimeupdate = () => {
  const v = $("#video-preview");
  if (!v.paused && v.currentTime >= Number($("#trim-end").value)) v.pause();
};
$("#video-preview").onplay = () =>
  ($("#play-preview").textContent = "Ⅱ Pausar prévia");
$("#video-preview").onpause = () =>
  ($("#play-preview").textContent = "▶ Reproduzir corte");
$("#video-preview").onerror = () => {
  if (selectedAsset())
    $("#preview-status").textContent =
      "Prévia indisponível para este codec. A exportação MP4 pode converter o vídeo.";
};
window.addEventListener("hashchange", route);
accountHandlers({
  signedOut: showAuth,
  reload: () => load().catch(() => showAuth()),
});
route();
load().catch((e) => {
  showAuth();
  if (!e.message.includes("Entre na sua conta"))
    $("#auth-error").textContent = e.message;
});
setInterval(() => {
  if (!document.hidden) poll();
}, 2000);

$("#upload-button").onclick = () => $("#library-upload").click();
