import {
  CANVAS,
  LIMITS,
  RANGES,
  FONTS,
  PRESETS,
  BLUR,
  makeId,
  defaultTemplate,
  applyPreset,
  prune,
  slotList,
  variationCount,
  placement,
} from "./template-core.js";
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") e.className = value;
    else if (key === "text") e.textContent = value;
    else if (key.startsWith("on")) e.addEventListener(key.slice(2), value);
    else if (value === true) e.setAttribute(key, "");
    else if (value !== false && value != null) e.setAttribute(key, value);
  }
  e.append(...children.filter((c) => c != null));
  return e;
}
async function api(path, method = "GET", data) {
  const res = await fetch("/api" + path, {
    method,
    headers: {
      "X-ViceClipz": "studio",
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const value = await res
    .json()
    .catch(() => ({ error: "Não foi possível conectar ao servidor." }));
  if (!res.ok)
    throw Object.assign(
      new Error(value.error || "Não foi possível concluir."),
      {
        status: res.status,
      },
    );
  return value;
}
const STEPS = [
  ["profile", "Perfil", "Salvar perfil e continuar"],
  ["zones", "Zonas", "Salvar zonas e continuar"],
  ["phrases", "Frases", "Salvar frases e continuar"],
  ["media", "Mídia", "Salvar mídia e continuar"],
  ["style", "Estilo", "Salvar estilo e continuar"],
  ["variations", "Variações", "Salvar seleção e continuar"],
  ["generate", "Gerar", ""],
];
const GALLERY = [
  {
    layout: "post",
    copy: "Cartão no estilo post com avatar, nome, selo e @. A frase fica logo abaixo e o vídeo ocupa o resto.",
  },
  {
    layout: "meme",
    copy: "Faixa preta com a frase em destaque no topo, vídeo no meio e o perfil na faixa de baixo.",
  },
  {
    layout: "viral",
    copy: "Duas áreas de mídia empilhadas, vídeo em cima e imagem embaixo, com a frase entre elas.",
  },
];
const TITLES = { post: "Post card", meme: "Meme", viral: "Vídeo viral" };
const SWATCHES = [
  "#ffffff",
  "#111111",
  "#ff4fa3",
  "#ffa94d",
  "#c9a7ff",
  "#ffe066",
  "#4dd4ff",
  "#3ac47d",
];
const ITEM_STATES = {
  queued: "Aguardando na fila",
  running: "Montando vídeo…",
  cancelling: "Cancelando…",
  done: "Pronto",
  failed: "Falhou",
  cancelled: "Cancelada",
};
const PLACEHOLDER = "Sua frase aparece aqui. Adicione frases na etapa 3.";
const THEME_TEXT = { light: "#111111", dark: "#ffffff" };
// Box blur radius r with power p approximates a Gaussian with this deviation.
const BLUR_SIGMA = Math.sqrt(
  (BLUR.power * ((2 * BLUR.radius + 1) ** 2 - 1)) / 12,
);
const state = {
  user: null,
  project: null,
  template: null,
  assets: [],
  saved: { profiles: [], styles: [] },
  limits: null,
  dirty: false,
  saving: null,
  step: "profile",
  layout: null,
  previewSeq: 0,
  activeSlot: null,
  activeOption: {},
  activePhrase: null,
  editingPhrase: null,
  mediaView: "grid",
  batches: [],
  batch: null,
  batchKey: null,
  pendingAsset: null,
  uploading: false,
};
let previewTimer,
  pollTimer,
  autosaveTimer,
  frame,
  playing = false;
const assetById = (id) => state.assets.find((a) => a.id === id);
const media = (slotId) => state.template.media[slotId] || [];
const fmt = (n) => Number(n).toFixed(1).replace(".", ",");
const bytes = (n) =>
  n >= 1024 ** 3
    ? (n / 1024 ** 3).toFixed(2) + " GB"
    : (n / 1024 ** 2).toFixed(1) + " MB";
function notifyProjects() {
  window.dispatchEvent(new Event("viceclipz:projects-changed"));
}
function setStatus(text) {
  $("#builder-status").textContent = text;
}
function setError(text = "") {
  $("#builder-error").textContent = text;
}
// ---------- Gallery ----------
function schematic(layout) {
  const lines = (n, cls = "") =>
    el(
      "span",
      { class: "s-lines " + cls },
      ...Array.from({ length: n }, () => el("i")),
    );
  const profile = (dark) =>
    el(
      "span",
      { class: "s-profile" + (dark ? " dark" : "") },
      el("b"),
      lines(2),
    );
  const zone = (kind) =>
    el(
      "span",
      { class: "s-zone " + kind },
      el("em", { text: kind === "image" ? "IMAGEM" : "▶ VÍDEO" }),
    );
  const parts = {
    post: [
      el("span", { class: "s-band light" }, profile(false), lines(3, "text")),
      zone("video"),
    ],
    meme: [
      el("span", { class: "s-band dark" }, lines(2, "text center")),
      zone("video"),
      el("span", { class: "s-band dark" }, profile(true)),
    ],
    viral: [
      zone("video"),
      el("span", { class: "s-band dark" }, lines(2, "text center")),
      zone("image"),
    ],
  }[layout];
  return el("span", { class: "schematic", "aria-hidden": "true" }, ...parts);
}
function galleryCard(item) {
  return el(
    "article",
    { class: "layout-card" },
    el("div", { class: "layout-art" }, schematic(item.layout)),
    el(
      "div",
      { class: "layout-info" },
      el(
        "div",
        {},
        el("h3", { text: TITLES[item.layout] }),
        el("p", { text: item.copy }),
      ),
      el("span", { class: "format-chip", text: "9:16" }),
    ),
    el("button", {
      type: "button",
      class: "primary",
      text: "Usar este template",
      "aria-label": "Usar o template " + TITLES[item.layout],
      onclick: (e) => createTemplate(item.layout, e.currentTarget),
    }),
  );
}
export function renderGallery() {
  for (const target of [$("#all-templates"), $("#featured-templates")])
    target?.replaceChildren(...GALLERY.map(galleryCard));
}
export function useAssetInTemplate(asset) {
  state.pendingAsset = asset;
  $("#gallery-status").textContent =
    `Escolha um template para usar “${asset.name}”.`;
  location.hash = "templates";
}
function newOption(asset) {
  const option = { id: makeId(), assetId: asset.id, zoom: 1, x: 50, y: 50 };
  if (asset.kind === "video")
    Object.assign(option, {
      start: 0,
      end: Math.floor(Math.min(asset.duration, 120) * 100) / 100,
    });
  return option;
}
function addOption(template, slot, asset) {
  const option = newOption(asset);
  template.media[slot.id] = [...(template.media[slot.id] || []), option];
  template.selection.media[slot.id] = [
    ...(template.selection.media[slot.id] || []),
    option.id,
  ];
  return option;
}
async function createTemplate(layout, button) {
  button.disabled = true;
  $("#gallery-status").textContent = "Criando template…";
  try {
    const template = defaultTemplate(layout, state.user?.name || "");
    const asset = state.pendingAsset,
      slot = asset && slotList(template).find((s) => s.type === asset.kind);
    if (slot) addOption(template, slot, asset);
    const project = await api("/projects", "POST", template);
    state.pendingAsset = null;
    $("#gallery-status").textContent = "";
    notifyProjects();
    location.hash = "builder/" + project.id;
  } catch (e) {
    $("#gallery-status").textContent = e.message;
  } finally {
    button.disabled = false;
  }
}
// ---------- Session and routing ----------
export function setTemplateSession(user) {
  state.user = user;
  if (!user) {
    stopPlayback();
    clearInterval(pollTimer);
    clearTimeout(autosaveTimer);
    Object.assign(state, {
      project: null,
      template: null,
      dirty: false,
      batch: null,
      batches: [],
    });
    return;
  }
  route();
}
export function templateEditing() {
  return state.project?.id || null;
}
function route() {
  const [page, id] = location.hash.slice(1).split("/");
  if (page !== "builder") {
    leave();
    return;
  }
  if (!state.user) return;
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) {
    showEmpty();
    return;
  }
  if (id !== state.project?.id) open(id);
}
function leave() {
  stopPlayback();
  clearInterval(pollTimer);
  if (state.dirty && state.project)
    save().catch((e) => setStatus("Não foi possível salvar: " + e.message));
}
function showEmpty() {
  $("#builder-empty").hidden = false;
  $("#builder-body").hidden = true;
  $(".stepbar").hidden = true;
}
const strip = ({ id, revision, updatedAt, ...data }) => structuredClone(data);
async function open(id) {
  stopPlayback();
  clearTimeout(autosaveTimer);
  setStatus("Carregando template…");
  setError();
  try {
    const [project, assets, profiles, styles, limits] = await Promise.all([
      api("/projects/" + id),
      api("/assets"),
      api("/profiles"),
      api("/styles"),
      api("/templates/limits"),
    ]);
    if (project.kind !== "template") {
      location.hash = "projects";
      return;
    }
    Object.assign(state, {
      project,
      template: strip(project),
      assets,
      saved: { profiles, styles },
      limits,
      dirty: false,
      layout: null,
      activeOption: {},
      activeSlot: null,
      activePhrase: project.phrases[0]?.id || null,
      editingPhrase: null,
      batch: null,
      batchKey: null,
    });
    $("#builder-empty").hidden = true;
    $("#builder-body").hidden = false;
    $(".stepbar").hidden = false;
    $("#stage-cells").replaceChildren();
    $("#stage-overlay").hidden = true;
    renderAll();
    showStep("profile");
    schedulePreview(0);
    setStatus("Tudo salvo");
    loadBatches().catch(() => {});
  } catch (e) {
    showEmpty();
    $("#builder-empty p").textContent = e.message;
  }
}
// ---------- Saving ----------
function markDirty() {
  state.dirty = true;
  state.batchKey = null;
  setStatus("Alterações não salvas");
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (state.dirty && state.project)
      save().catch((e) => setStatus("Não salvo: " + e.message));
  }, 1500);
}
async function save() {
  if (state.saving) return state.saving;
  state.saving = (async () => {
    setStatus("Salvando…");
    const sent = JSON.stringify(state.template);
    try {
      const saved = await api("/projects/" + state.project.id, "PUT", {
        ...state.template,
        revision: state.project.revision,
      });
      // The working copy is kept: controls hold references into it. Edits made while
      // the request was in flight stay pending for the next save.
      const pending = JSON.stringify(state.template) !== sent;
      state.project = saved;
      state.dirty = pending;
      if (pending) markDirty();
      setStatus(pending ? "Alterações não salvas" : "Tudo salvo");
      notifyProjects();
    } catch (e) {
      setStatus("Não salvo");
      if (e.status === 409)
        throw new Error(
          "Este template foi alterado em outra aba. Recarregue a página para continuar.",
        );
      throw e;
    } finally {
      state.saving = null;
    }
  })();
  return state.saving;
}
// ---------- Steps ----------
function lockReason(step) {
  const t = state.template,
    slots = slotList(t);
  if (step === "variations" || step === "generate") {
    if (!slots.some((s) => s.type === "video"))
      return "Adicione uma zona de vídeo na etapa Zonas.";
    const missing = slots.find((s) => !media(s.id).length);
    if (missing) return `Envie mídia para ${missing.label} na etapa Mídia.`;
    if (!t.phrases.length)
      return "Adicione ao menos uma frase na etapa Frases.";
  }
  if (step === "generate") {
    if (t.profile.showName && !t.profile.name.trim())
      return "Informe o nome na etapa Perfil ou desative a exibição do nome.";
    if (t.profile.showHandle && !t.profile.handle)
      return "Informe o @ na etapa Perfil ou desative a exibição do @.";
    const count = variationCount(t);
    if (!count && !state.batches.length)
      return "Selecione ao menos uma mídia por zona e uma frase na etapa Variações.";
    if (count > LIMITS.batch && !state.batches.length)
      return `Reduza a seleção para até ${LIMITS.batch} variações na etapa Variações.`;
  }
  return "";
}
function renderSteps() {
  $("#builder-steps").replaceChildren(
    ...STEPS.map(([key, label], i) => {
      const reason = lockReason(key),
        button = el("button", {
          type: "button",
          class: "step-button" + (reason ? " locked" : ""),
          "aria-current": key === state.step ? "step" : null,
          "aria-disabled": reason ? "true" : null,
          title: reason || null,
          onclick: () => goTo(key),
        });
      button.append(el("span", { text: String(i + 1) }), label);
      return el("li", {}, button);
    }),
  );
}
async function goTo(step) {
  const reason = lockReason(step);
  if (reason) {
    $("#step-lock").textContent =
      `${STEPS.find((s) => s[0] === step)[1]}: ${reason}`;
    return;
  }
  $("#step-lock").textContent = "";
  if (state.dirty) {
    try {
      await save();
    } catch (e) {
      setError(e.message);
      return;
    }
  }
  showStep(step);
}
function showStep(step) {
  state.step = step;
  for (const fieldset of $$("#builder-form .step"))
    fieldset.hidden = fieldset.dataset.step !== step;
  const index = STEPS.findIndex((s) => s[0] === step);
  $("#builder-next").hidden = !STEPS[index][2];
  $("#builder-next").textContent = STEPS[index][2];
  $("#builder-back").hidden = index === 0;
  setError();
  renderSteps();
  if (step === "variations") renderVariations();
  if (step === "generate") {
    renderGenerate();
    refreshLimits();
  }
  if (step === "media") renderMedia();
  stopPlayback();
  if (step === "style") startPlayback(true);
  $("#builder-steps [aria-current]")?.scrollIntoView({
    block: "nearest",
    inline: "center",
  });
}
function renderAll() {
  $("#builder-name").value = state.template.name;
  renderAI();
  fillInputs();
  renderAvatar();
  renderSaved();
  renderZones();
  renderPhrases();
  renderMedia();
  renderStyle();
  renderVariations();
  renderSteps();
}
// ---------- Generic bound inputs ----------
const getPath = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split("."),
    last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}
function formatValue(input) {
  const v = Number(input.value),
    unit = input.dataset.unit || "";
  if (unit === "×") return v.toFixed(2).replace(".", ",") + "×";
  return unit === "%" ? `${Math.round(v)}%` : `${Math.round(v)} ${unit}`.trim();
}
function syncOutputs() {
  for (const input of $$("#builder input[type=range]:not([data-share])")) {
    const out = input.closest("label")?.querySelector("output");
    if (out) out.textContent = formatValue(input);
  }
}
function fillInputs() {
  for (const input of $$("#builder [data-bind]")) {
    if (input === document.activeElement && input.type !== "range") continue;
    const path = input.dataset.bind,
      value = getPath(state.template, path),
      range = RANGES[path.split(".").pop()];
    if (input.type === "range" && range) [input.min, input.max] = range;
    if (input.type === "checkbox") input.checked = value === true;
    else if (input.type === "radio") input.checked = input.value === value;
    else input.value = value ?? "";
  }
  $("#style-color").value = state.template.style.color;
  $("#zone-blur").checked = state.template.background === "blur";
  syncOutputs();
}
function readInput(input) {
  if (input.type === "checkbox") return input.checked;
  if (input.type === "range") return Number(input.value);
  return input.value;
}
$("#builder-form").addEventListener("input", (e) => {
  const input = e.target;
  if (input.dataset.bind) {
    if (input.type === "radio" && !input.checked) return;
    let value = readInput(input);
    if (input.dataset.bind === "profile.handle") {
      value = value.replace(/^@/, "").replace(/[^A-Za-z0-9_.]/g, "");
      if (value !== input.value) input.value = value;
    }
    const style = state.template.style;
    // A phrase still using the old theme's default color follows the new theme.
    if (
      input.dataset.bind === "profile.theme" &&
      style.color === THEME_TEXT[value === "dark" ? "light" : "dark"]
    )
      style.color = THEME_TEXT[value];
    setPath(state.template, input.dataset.bind, value);
    markDirty();
    fillInputs();
    if (input.dataset.bind === "mute") return;
    if (["style.color", "profile.theme"].includes(input.dataset.bind))
      renderStyle();
    schedulePreview();
  } else if (input.dataset.option) {
    const option = currentOption();
    if (!option) return;
    option[input.dataset.option] = Number(input.value);
    markDirty();
    syncOutputs();
    layoutStage();
  }
});
$("#builder-name").addEventListener("input", (e) => {
  state.template.name = e.target.value;
  markDirty();
});
$("#builder-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.template.name.trim()) {
    setError("Dê um nome ao template.");
    $("#builder-name").focus();
    return;
  }
  const index = STEPS.findIndex((s) => s[0] === state.step),
    button = $("#builder-next");
  button.disabled = true;
  try {
    await save();
    setError();
    const next = STEPS[index + 1]?.[0];
    if (next) {
      const reason = lockReason(next);
      if (reason)
        $("#step-lock").textContent = `${STEPS[index + 1][1]}: ${reason}`;
      else showStep(next);
    }
  } catch (err) {
    setError(err.message);
  } finally {
    button.disabled = false;
  }
});
$("#builder-back").onclick = () => {
  const index = STEPS.findIndex((s) => s[0] === state.step);
  if (index > 0) goTo(STEPS[index - 1][0]);
};
// ---------- Uploads ----------
function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (file.size > 100 * 1024 * 1024) {
      reject(new Error(`${file.name}: escolha um arquivo de até 100 MB.`));
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
        else
          reject(
            new Error(`${file.name}: ${data.error || "falha no upload."}`),
          );
      } catch {
        reject(new Error("Resposta inválida do servidor."));
      }
    };
    xhr.onerror = () =>
      reject(new Error("Conexão interrompida. Tente enviar novamente."));
    xhr.ontimeout = () => reject(new Error("O upload excedeu o tempo limite."));
    xhr.send(file);
  });
}
const KIND_PATTERN = {
  video: /\.(mp4|mov|webm)$/i,
  image: /\.(png|jpe?g|webp)$/i,
};
async function uploadInto(files, kind, status, onAsset) {
  if (state.uploading) {
    status.textContent = "Aguarde o upload atual terminar.";
    return;
  }
  const accepted = files.filter((f) => KIND_PATTERN[kind].test(f.name)),
    rejected = files.length - accepted.length;
  if (!accepted.length) {
    status.textContent =
      kind === "video"
        ? "Esta zona aceita vídeos MP4, MOV ou WebM."
        : "Esta zona aceita imagens PNG, JPEG ou WebP.";
    return;
  }
  state.uploading = true;
  const errors = [];
  try {
    for (const [i, file] of accepted.entries()) {
      try {
        const asset = await upload(file, (n) => {
          status.textContent = `Enviando ${i + 1} de ${accepted.length}: ${file.name} · ${n === 100 ? "verificando…" : n + "%"}`;
        });
        state.assets.unshift(asset);
        if (onAsset(asset) === false) break;
      } catch (e) {
        errors.push(e.message);
      }
    }
    status.textContent = [
      `${accepted.length - errors.length} de ${accepted.length} arquivo(s) enviados.`,
      rejected ? `${rejected} ignorado(s) por tipo incompatível.` : "",
      ...errors,
    ]
      .filter(Boolean)
      .join(" ");
    window.dispatchEvent(new Event("viceclipz:assets-changed"));
    if (state.dirty) await save();
  } catch (e) {
    status.textContent = e.message;
  } finally {
    state.uploading = false;
  }
}
// ---------- Profile ----------
function renderAvatar() {
  const p = state.template.profile,
    asset = p.avatarAssetId && assetById(p.avatarAssetId);
  $("#pf-avatar-img").hidden = !asset;
  $("#pf-avatar-empty").hidden = Boolean(asset);
  if (asset) $("#pf-avatar-img").src = `/api/assets/${asset.id}/content`;
  const select = $("#pf-avatar-select");
  select.replaceChildren(
    el("option", {
      value: "",
      text: asset ? "Sem foto (inicial do nome)" : "Selecione uma imagem",
    }),
    ...state.assets
      .filter((a) => a.kind === "image")
      .map((a) => el("option", { value: a.id, text: a.name })),
  );
  select.value = asset ? asset.id : "";
}
function setAvatar(asset) {
  Object.assign(state.template.profile, {
    avatarAssetId: asset?.id || null,
    ...(asset ? { avatar: true } : {}),
  });
  markDirty();
  fillInputs();
  renderAvatar();
  schedulePreview();
}
$("#pf-avatar-select").onchange = (e) =>
  setAvatar(assetById(e.target.value) || null);
$("#pf-avatar-file").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  await uploadInto(
    files.slice(0, 1),
    "image",
    $("#pf-avatar-status"),
    (asset) => {
      setAvatar(asset);
      return false;
    },
  );
};
// ---------- Saved profiles and styles ----------
function renderSaved() {
  for (const kind of ["profiles", "styles"]) {
    const select = $(`[data-saved="${kind}"]`),
      current = select.value;
    select.replaceChildren(
      el("option", {
        value: "",
        text: state.saved[kind].length
          ? "Selecione para aplicar"
          : kind === "profiles"
            ? "Nenhum perfil salvo"
            : "Nenhum estilo salvo",
      }),
      ...state.saved[kind].map((item) =>
        el("option", { value: item.id, text: item.name }),
      ),
    );
    select.value = state.saved[kind].some((i) => i.id === current)
      ? current
      : "";
    $(`[data-delete-preset="${kind}"]`).disabled = !select.value;
  }
}
for (const kind of ["profiles", "styles"]) {
  const select = $(`[data-saved="${kind}"]`),
    row = select.closest(".saved-row"),
    name = el("input", {
      maxlength: String(LIMITS.savedName),
      autocomplete: "off",
      placeholder:
        kind === "profiles" ? "Ex.: Perfil principal" : "Ex.: Destaque amarelo",
    }),
    remove = el("button", {
      type: "button",
      class: "text-button",
      "data-delete-preset": kind,
      text: "Excluir selecionado",
    });
  row.insertBefore(
    el("label", {}, "Salvar como", name),
    row.querySelector("[data-save-preset]"),
  );
  row.append(remove);
  select.onchange = () => {
    const item = state.saved[kind].find((i) => i.id === select.value);
    remove.disabled = !item;
    if (!item) return;
    if (kind === "profiles")
      state.template.profile = structuredClone(item.data);
    else state.template.style = structuredClone(item.data);
    markDirty();
    fillInputs();
    renderAvatar();
    renderStyle();
    schedulePreview();
    setStatus(`“${item.name}” aplicado · alterações não salvas`);
  };
  $(`[data-save-preset="${kind}"]`).onclick = async (e) => {
    const button = e.currentTarget;
    if (!name.value.trim()) {
      setError("Dê um nome para salvar.");
      name.focus();
      return;
    }
    button.disabled = true;
    try {
      const item = await api("/" + kind, "POST", {
        name: name.value,
        data:
          kind === "profiles" ? state.template.profile : state.template.style,
      });
      state.saved[kind] = await api("/" + kind);
      select.value = item.id;
      renderSaved();
      name.value = "";
      setError();
      setStatus(`“${item.name}” salvo para reutilizar`);
    } catch (err) {
      setError(err.message);
    } finally {
      button.disabled = false;
    }
  };
  remove.onclick = async () => {
    const item = state.saved[kind].find((i) => i.id === select.value);
    if (!item) return;
    remove.disabled = true;
    try {
      await api(`/${kind}/${item.id}`, "DELETE");
      state.saved[kind] = state.saved[kind].filter((i) => i.id !== item.id);
      select.value = "";
      renderSaved();
      setStatus(`“${item.name}” excluído`);
    } catch (err) {
      setError(err.message);
      remove.disabled = false;
    }
  };
}
// ---------- Zones ----------
function zonesChanged(message) {
  state.template = prune(state.template);
  markDirty();
  renderZones();
  renderMedia();
  renderVariations();
  renderSteps();
  schedulePreview(0);
  if (message) setStatus(message + " · alterações não salvas");
}
function presetArt(key) {
  return el(
    "span",
    {
      class: "preset-art" + (PRESETS[key].background ? " blur" : ""),
      "aria-hidden": "true",
    },
    ...PRESETS[key].zones.map(([height, types]) =>
      el(
        "span",
        { style: `flex:${height}` },
        ...types.map((type) => el("i", { class: type })),
      ),
    ),
  );
}
$("#zone-presets").replaceChildren(
  ...Object.entries(PRESETS).map(([key, preset]) =>
    el(
      "button",
      {
        type: "button",
        class: "preset-card",
        onclick: () => {
          state.template = applyPreset(state.template, key);
          zonesChanged(`Modelo “${preset.label}” aplicado`);
          fillInputs();
        },
      },
      presetArt(key),
      el("span", { text: preset.label }),
    ),
  ),
);
$("#zone-blur").onchange = (e) => {
  state.template.background = e.target.checked ? "blur" : "black";
  markDirty();
  schedulePreview();
};
function moveZone(from, to) {
  const zones = state.template.zones;
  if (to < 0 || to >= zones.length || from === to) return;
  const [zone] = zones.splice(from, 1);
  zones.splice(to, 0, zone);
  zonesChanged(`Zona movida para a posição ${to + 1}`);
  // Keep keyboard focus on the moved zone, on the arrow that still applies.
  const buttons = $$(
    `#zone-list > li:nth-child(${to + 1}) .zone-actions button:not([disabled])`,
  );
  (
    buttons.find((b) => b.textContent === (to < from ? "↑" : "↓")) || buttons[0]
  )?.focus();
}
function renderZones() {
  const zones = state.template.zones,
    total = zones.reduce((n, z) => n + z.height, 0);
  $("#zone-add").disabled = zones.length >= LIMITS.zones;
  $("#zone-list").replaceChildren(
    ...zones.map((zone, i) => {
      const item = el("li", { class: "zone-item", draggable: "true" });
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(i));
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", () => item.classList.remove("dragging"));
      item.addEventListener("dragover", (e) => e.preventDefault());
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        moveZone(Number(e.dataTransfer.getData("text/plain")), i);
      });
      const slots = zone.slots.map((slot, j) =>
        el(
          "div",
          { class: "slot-row" },
          el(
            "label",
            {},
            zone.slots.length > 1
              ? j
                ? "Área direita"
                : "Área esquerda"
              : "Tipo",
            el(
              "select",
              {
                onchange: (e) => {
                  // A new id drops options of the old type for this area.
                  zone.slots[j] = {
                    ...slot,
                    id: makeId(),
                    type: e.target.value,
                  };
                  zonesChanged();
                },
              },
              el("option", {
                value: "video",
                text: "Vídeo",
                selected: slot.type === "video",
              }),
              el("option", {
                value: "image",
                text: "Imagem",
                selected: slot.type === "image",
              }),
            ),
          ),
          el(
            "label",
            {},
            "Enquadramento",
            el(
              "select",
              {
                onchange: (e) => {
                  slot.fit = e.target.value;
                  zonesChanged();
                },
              },
              el("option", {
                value: "cover",
                text: "Preencher",
                selected: slot.fit === "cover",
              }),
              el("option", {
                value: "contain",
                text: "Mostrar inteiro",
                selected: slot.fit === "contain",
              }),
            ),
          ),
        ),
      );
      const height = el("input", {
        type: "range",
        min: String(RANGES.height[0]),
        max: String(RANGES.height[1]),
        value: String(zone.height),
        "data-share": "",
        "aria-label": `Altura relativa da zona ${i + 1}`,
      });
      const output = el("output", {
        text: `${Math.round((zone.height / total) * 100)}% da área`,
      });
      height.oninput = () => {
        zone.height = Number(height.value);
        markDirty();
        const sum = zones.reduce((n, z) => n + z.height, 0);
        $$("#zone-list output").forEach(
          (o, k) =>
            (o.textContent = `${Math.round((zones[k].height / sum) * 100)}% da área`),
        );
        schedulePreview();
      };
      item.append(
        el(
          "div",
          { class: "zone-head" },
          el("span", {
            class: "drag-handle",
            "aria-hidden": "true",
            text: "⠿",
          }),
          el("strong", { text: `Zona ${i + 1}` }),
          el(
            "div",
            { class: "zone-actions" },
            el("button", {
              type: "button",
              class: "icon-button zone-move",
              text: "↑",
              "aria-label": `Mover zona ${i + 1} para cima`,
              disabled: i === 0,
              onclick: () => moveZone(i, i - 1),
            }),
            el("button", {
              type: "button",
              class: "icon-button",
              text: "↓",
              "aria-label": `Mover zona ${i + 1} para baixo`,
              disabled: i === zones.length - 1,
              onclick: () => moveZone(i, i + 1),
            }),
            el("button", {
              type: "button",
              class: "icon-button",
              text: "×",
              "aria-label": `Remover zona ${i + 1}`,
              disabled: zones.length === 1,
              onclick: () => {
                zones.splice(i, 1);
                zonesChanged(`Zona ${i + 1} removida`);
              },
            }),
          ),
        ),
        ...slots,
        el(
          "label",
          { class: "switch" },
          el("input", {
            type: "checkbox",
            checked: zone.slots.length > 1,
            onchange: (e) => {
              if (e.target.checked)
                zone.slots.push({ id: makeId(), type: "image", fit: "cover" });
              else zone.slots.splice(1);
              zonesChanged();
            },
          }),
          " Dividir em 2 lado a lado",
        ),
        el(
          "label",
          { class: "slider" },
          el("span", {}, "Altura relativa ", output),
          height,
        ),
      );
      return item;
    }),
  );
}
$("#zone-add").onclick = () => {
  if (state.template.zones.length >= LIMITS.zones) return;
  state.template.zones.push({
    id: makeId(),
    height: 50,
    slots: [{ id: makeId(), type: "video", fit: "cover" }],
  });
  zonesChanged("Zona adicionada");
};
// ---------- Phrases ----------
function addPhrases(texts, auto) {
  const t = state.template,
    room = LIMITS.phrases - t.phrases.length,
    added = texts
      .slice(0, Math.max(0, room))
      .map((text) => ({ id: makeId(), text, auto }));
  t.phrases.push(...added);
  t.selection.phrases.push(...added.map((p) => p.id));
  if (added.length && !state.activePhrase) state.activePhrase = added[0].id;
  markDirty();
  renderPhrases();
  renderVariations();
  renderSteps();
  schedulePreview();
  return texts.length - added.length;
}
function renderPhrases() {
  const t = state.template;
  $("#phrase-total").textContent = t.phrases.length;
  $("#phrase-add").disabled = t.phrases.length >= LIMITS.phrases;
  if (!t.phrases.length) {
    $("#phrase-list").replaceChildren(
      el("li", {
        class: "list-empty",
        text: "Nenhuma frase ainda. Gere sugestões ou escreva a sua.",
      }),
    );
    return;
  }
  $("#phrase-list").replaceChildren(
    ...t.phrases.map((phrase, i) => {
      if (state.editingPhrase === phrase.id) {
        const area = el("textarea", {
          rows: "3",
          maxlength: String(LIMITS.phrase),
          "aria-label": `Editar frase ${i + 1}`,
        });
        area.value = phrase.text;
        queueMicrotask(() => area.focus());
        return el(
          "li",
          { class: "phrase-item editing" },
          area,
          el(
            "div",
            { class: "actions" },
            el("button", {
              type: "button",
              class: "primary",
              text: "Salvar frase",
              onclick: () => {
                const text = area.value.trim();
                if (!text) return setError("A frase não pode ficar vazia.");
                phrase.text = text;
                state.editingPhrase = null;
                markDirty();
                renderPhrases();
                renderVariations();
                schedulePreview();
              },
            }),
            el("button", {
              type: "button",
              class: "secondary",
              text: "Cancelar",
              onclick: () => {
                state.editingPhrase = null;
                renderPhrases();
              },
            }),
          ),
        );
      }
      return el(
        "li",
        { class: "phrase-item" },
        el(
          "label",
          { class: "phrase-pick" },
          el("input", {
            type: "radio",
            name: "phrase-preview",
            checked: (state.activePhrase || t.phrases[0].id) === phrase.id,
            "aria-label": `Mostrar frase ${i + 1} na prévia`,
            onchange: () => {
              state.activePhrase = phrase.id;
              schedulePreview(0);
            },
          }),
          el("span", { class: "phrase-text", text: phrase.text }),
        ),
        el(
          "div",
          { class: "phrase-meta" },
          phrase.auto ? el("span", { class: "pill auto", text: "AUTO" }) : null,
          el("button", {
            type: "button",
            class: "text-button",
            text: "Editar",
            "aria-label": `Editar frase ${i + 1}`,
            onclick: () => {
              state.editingPhrase = phrase.id;
              renderPhrases();
            },
          }),
          el("button", {
            type: "button",
            class: "text-button danger-text",
            text: "Remover",
            "aria-label": `Remover frase ${i + 1}`,
            onclick: () => {
              const current = state.template;
              current.phrases = current.phrases.filter(
                (p) => p.id !== phrase.id,
              );
              if (state.activePhrase === phrase.id)
                state.activePhrase = current.phrases[0]?.id || null;
              state.template = prune(current);
              markDirty();
              renderPhrases();
              renderVariations();
              renderSteps();
              schedulePreview();
            },
          }),
        ),
      );
    }),
  );
}
$("#phrase-input").addEventListener("input", (e) => {
  $("#phrase-counter").textContent =
    `${[...e.target.value].length}/${LIMITS.phrase}`;
});
$("#phrase-add").onclick = () => {
  const text = $("#phrase-input").value.trim();
  if (!text) {
    setError("Escreva a frase antes de adicionar.");
    $("#phrase-input").focus();
    return;
  }
  setError();
  addPhrases([text], false);
  $("#phrase-input").value = "";
  $("#phrase-counter").textContent = `0/${LIMITS.phrase}`;
};
function renderAI() {
  const ai = state.limits?.ai,
    ready = Boolean(ai?.configured),
    description = $("#ai-description"),
    button = $("#ai-generate");
  description.disabled = !ready;
  $("#ai-count").disabled = !ready;
  button.disabled = !ready;
  $("#ai-status").textContent = ready
    ? `Restam ${ai.remaining} de ${ai.limit} gerações neste mês. Revise as sugestões antes de usar.`
    : ai?.reason ||
      "Geração automática indisponível no momento. Escreva suas frases abaixo.";
}
$("#ai-generate").onclick = async () => {
  const description = $("#ai-description").value.trim(),
    button = $("#ai-generate");
  if (description.length < 10) {
    setError("Descreva a ideia do vídeo com pelo menos 10 caracteres.");
    $("#ai-description").focus();
    return;
  }
  setError();
  button.disabled = true;
  $("#ai-status").textContent = "Gerando sugestões…";
  try {
    const result = await api("/phrases/generate", "POST", {
      description,
      count: Number($("#ai-count").value),
    });
    const skipped = addPhrases(result.phrases, true);
    if (state.limits?.ai) state.limits.ai.remaining = result.remaining;
    renderAI();
    $("#ai-status").textContent =
      `${result.phrases.length - skipped} sugestões adicionadas.` +
      (skipped
        ? ` ${skipped} não couberam no limite de ${LIMITS.phrases} frases.`
        : "") +
      ` Restam ${result.remaining} gerações neste mês.`;
  } catch (e) {
    $("#ai-status").textContent = e.message;
    button.disabled = false;
  }
};
// ---------- Media ----------
function currentOption() {
  const slot = state.activeSlot;
  return media(slot).find((o) => o.id === state.activeOption[slot]) || null;
}
function activeOptionFor(slotId) {
  const list = media(slotId);
  return (
    list.find((o) => o.id === state.activeOption[slotId]) || list[0] || null
  );
}
function thumb(asset) {
  if (!asset)
    return el("span", { class: "thumb missing", text: "indisponível" });
  return asset.kind === "image"
    ? el("img", {
        class: "thumb",
        src: `/api/assets/${asset.id}/content`,
        alt: "",
        loading: "lazy",
      })
    : el("video", {
        class: "thumb",
        src: `/api/assets/${asset.id}/content#t=0.5`,
        muted: true,
        preload: "metadata",
        "aria-hidden": "true",
      });
}
function renderMedia() {
  const t = state.template,
    slots = slotList(t);
  if (!slots.some((s) => s.id === state.activeSlot))
    state.activeSlot = slots[0]?.id || null;
  const slot = slots.find((s) => s.id === state.activeSlot);
  $("#media-slots").replaceChildren(
    el("legend", { text: "Zona" }),
    ...slots.map((s) =>
      el(
        "label",
        {},
        el("input", {
          type: "radio",
          name: "media-slot",
          value: s.id,
          checked: s.id === state.activeSlot,
          onchange: () => {
            state.activeSlot = s.id;
            renderMedia();
          },
        }),
        el("span", {
          text: `${s.label} · ${s.type === "video" ? "vídeo" : "imagem"} (${media(s.id).length})`,
        }),
      ),
    ),
  );
  if (!slot) return;
  const options = media(slot.id);
  if (!options.some((o) => o.id === state.activeOption[slot.id]))
    state.activeOption[slot.id] = options[0]?.id;
  $("#media-file").accept =
    slot.type === "video"
      ? "video/mp4,video/webm,video/quicktime"
      : "image/png,image/jpeg,image/webp";
  const full = options.length >= LIMITS.options;
  $("#media-file").disabled = full;
  $("#media-library").disabled = full;
  $("#media-library").replaceChildren(
    el("option", {
      value: "",
      text: full
        ? `Limite de ${LIMITS.options} opções`
        : "Selecione um arquivo",
    }),
    ...state.assets
      .filter((a) => a.kind === slot.type)
      .map((a) => el("option", { value: a.id, text: a.name })),
  );
  const grid = $("#media-grid");
  grid.className = "media-grid " + state.mediaView;
  grid.replaceChildren(
    ...(options.length
      ? options.map((option, i) => {
          const asset = assetById(option.assetId),
            selected = option.id === state.activeOption[slot.id];
          return el(
            "li",
            { class: "media-item" + (selected ? " selected" : "") },
            el(
              "button",
              {
                type: "button",
                class: "media-pick",
                "aria-pressed": String(selected),
                onclick: () => {
                  state.activeOption[slot.id] = option.id;
                  renderMedia();
                  layoutStage();
                },
              },
              thumb(asset),
              el(
                "span",
                { class: "media-meta" },
                el("strong", { text: `Opção ${i + 1}` }),
                el("small", { text: asset?.name || "Arquivo removido" }),
                el("small", {
                  "data-trim-label": option.id,
                  text:
                    slot.type === "video"
                      ? `${fmt(option.start)}s – ${fmt(option.end)}s de ${fmt(asset?.duration || 0)}s`
                      : asset
                        ? `${asset.width} × ${asset.height}`
                        : "",
                }),
                selected
                  ? el("span", { class: "pill", text: "selecionado" })
                  : null,
              ),
            ),
            el("button", {
              type: "button",
              class: "text-button danger-text",
              text: "Remover",
              "aria-label": `Remover opção ${i + 1} de ${slot.label}`,
              onclick: () => {
                const current = state.template;
                current.media[slot.id] = media(slot.id).filter(
                  (o) => o.id !== option.id,
                );
                state.template = prune(current);
                markDirty();
                renderMedia();
                renderVariations();
                renderSteps();
                layoutStage();
              },
            }),
          );
        })
      : [
          el("li", {
            class: "list-empty",
            text: `Nenhuma mídia em ${slot.label}. Envie arquivos ou escolha da biblioteca.`,
          }),
        ]),
  );
  renderOptionEditor(slot);
}
function renderOptionEditor(slot) {
  const option = currentOption(),
    asset = option && assetById(option.assetId);
  $("#media-editor").hidden = !option;
  if (!option) return;
  $("#trim-box").hidden = slot.type !== "video";
  if (slot.type === "video") {
    const duration = asset?.duration || option.end;
    for (const id of ["#trim-start", "#trim-end"]) {
      $(id).min = "0";
      $(id).max = String(duration);
    }
    $("#trim-start").value = String(option.start);
    $("#trim-end").value = String(option.end);
    updateTrim(duration);
  }
  for (const input of $$("[data-option]"))
    input.value = String(option[input.dataset.option]);
  syncOutputs();
}
function updateTrim(duration) {
  const option = currentOption();
  if (!option) return;
  $("#trim-readout").textContent =
    `${fmt(option.start)}s – ${fmt(option.end)}s (${fmt(option.end - option.start)}s)`;
  $("#trim-fill").style.left = (option.start / duration) * 100 + "%";
  $("#trim-fill").style.right = 100 - (option.end / duration) * 100 + "%";
}
function onTrim(which) {
  const option = currentOption(),
    asset = option && assetById(option.assetId);
  if (!option || !asset) return;
  const duration = asset.duration;
  let start = Number($("#trim-start").value),
    end = Number($("#trim-end").value);
  if (which === "start") {
    start = Math.min(start, end - 0.25);
    if (end - start > 120) end = start + 120;
  } else {
    end = Math.max(end, start + 0.25);
    if (end - start > 120) start = end - 120;
  }
  option.start = Math.max(0, Math.round(start * 100) / 100);
  option.end = Math.min(
    Math.floor(duration * 100) / 100,
    Math.round(end * 100) / 100,
  );
  $("#trim-start").value = String(option.start);
  $("#trim-end").value = String(option.end);
  updateTrim(duration);
  const label = $(`[data-trim-label="${option.id}"]`);
  if (label)
    label.textContent = `${fmt(option.start)}s – ${fmt(option.end)}s de ${fmt(duration)}s`;
  markDirty();
  const video = $(`#stage-cells [data-slot="${state.activeSlot}"] video`);
  if (video && !playing)
    video.currentTime = which === "start" ? option.start : option.end;
  renderGenerateSummary();
}
$("#trim-start").addEventListener("input", () => onTrim("start"));
$("#trim-end").addEventListener("input", () => onTrim("end"));
$("#media-center").onclick = () => {
  const option = currentOption();
  if (!option) return;
  Object.assign(option, { zoom: 1, x: 50, y: 50 });
  markDirty();
  renderOptionEditor(
    slotList(state.template).find((s) => s.id === state.activeSlot),
  );
  layoutStage();
};
$("#media-library").onchange = (e) => {
  const asset = assetById(e.target.value),
    slot = slotList(state.template).find((s) => s.id === state.activeSlot);
  e.target.value = "";
  if (!asset || !slot) return;
  const option = addOption(state.template, slot, asset);
  state.activeOption[slot.id] = option.id;
  markDirty();
  renderMedia();
  renderVariations();
  renderSteps();
  layoutStage();
};
$("#media-file").onchange = async (e) => {
  const files = [...e.target.files],
    slot = slotList(state.template).find((s) => s.id === state.activeSlot);
  e.target.value = "";
  if (!slot) return;
  await uploadInto(files, slot.type, $("#media-status"), (asset) => {
    if (media(slot.id).length >= LIMITS.options) return false;
    const option = addOption(state.template, slot, asset);
    state.activeOption[slot.id] = option.id;
    markDirty();
    renderMedia();
    renderVariations();
    renderSteps();
    layoutStage();
  });
};
for (const button of $$("[data-view]"))
  button.onclick = () => {
    state.mediaView = button.dataset.view;
    $$("[data-view]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b === button)),
    );
    renderMedia();
  };
// ---------- Style ----------
$("#style-font").replaceChildren(
  ...Object.entries(FONTS).map(([value, text]) =>
    el("option", { value, text }),
  ),
);
function renderStyle() {
  const current = state.template.style.color;
  $("#style-swatches").replaceChildren(
    ...SWATCHES.map((color) =>
      el("button", {
        type: "button",
        class: "swatch",
        style: `--swatch:${color}`,
        "aria-label": `Usar cor ${color}`,
        "aria-pressed": String(color === current),
        onclick: () => {
          state.template.style.color = color;
          markDirty();
          fillInputs();
          renderStyle();
          schedulePreview();
        },
      }),
    ),
  );
}
$("#style-color").addEventListener("input", (e) => {
  const value = e.target.value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return;
  state.template.style.color = value.toLowerCase();
  markDirty();
  renderStyle();
  schedulePreview();
});
$("#style-color").addEventListener(
  "blur",
  (e) => (e.target.value = state.template.style.color),
);
// ---------- Variations ----------
function renderVariations() {
  const t = state.template,
    slots = slotList(t),
    count = variationCount(t),
    left = state.limits
      ? state.limits.renders.limit - state.limits.renders.used
      : null;
  $("#variation-count").textContent = count;
  $("#variation-help").textContent =
    count > LIMITS.batch
      ? `Cada lote gera até ${LIMITS.batch} variações. Desmarque mídias ou frases.`
      : left !== null && count > left
        ? `Seu plano tem ${Math.max(0, left)} exportações restantes neste mês.`
        : `Até ${LIMITS.batch} variações por lote.` +
          (left !== null ? ` Restam ${left} exportações neste mês.` : "");
  $("#variation-help").classList.toggle(
    "error",
    count > LIMITS.batch || (left !== null && count > left),
  );
  $("#variation-slots").replaceChildren(
    ...slots.map((slot) => {
      const options = media(slot.id),
        selected = new Set(t.selection.media[slot.id] || []);
      return el(
        "fieldset",
        { class: "check-group" },
        el("legend", {
          text: `${slot.label} · ${selected.size}/${options.length} selecionadas`,
        }),
        el(
          "div",
          { class: "check-actions" },
          el("button", {
            type: "button",
            class: "text-button",
            text: "Selecionar todas",
            onclick: () =>
              setSelection(
                slot.id,
                options.map((o) => o.id),
              ),
          }),
          el("button", {
            type: "button",
            class: "text-button",
            text: "Limpar",
            onclick: () => setSelection(slot.id, []),
          }),
        ),
        el(
          "ul",
          { class: "check-grid" },
          ...options.map((option, i) =>
            el(
              "li",
              {},
              el(
                "label",
                {},
                el("input", {
                  type: "checkbox",
                  checked: selected.has(option.id),
                  onchange: (e) =>
                    setSelection(
                      slot.id,
                      options
                        .filter((o) =>
                          o.id === option.id
                            ? e.target.checked
                            : selected.has(o.id),
                        )
                        .map((o) => o.id),
                    ),
                }),
                thumb(assetById(option.assetId)),
                el("span", { text: `Opção ${i + 1}` }),
              ),
            ),
          ),
        ),
      );
    }),
  );
  const chosen = new Set(t.selection.phrases);
  $("#variation-phrases-title").textContent =
    `Frases · ${chosen.size}/${t.phrases.length} selecionadas`;
  $("#variation-phrases").replaceChildren(
    ...t.phrases.map((phrase) =>
      el(
        "li",
        {},
        el(
          "label",
          {},
          el("input", {
            type: "checkbox",
            checked: chosen.has(phrase.id),
            onchange: (e) => {
              const current = state.template;
              current.selection.phrases = current.phrases
                .filter((p) =>
                  p.id === phrase.id ? e.target.checked : chosen.has(p.id),
                )
                .map((p) => p.id);
              markDirty();
              renderVariations();
              renderSteps();
            },
          }),
          el("span", { text: phrase.text }),
          phrase.auto ? el("span", { class: "pill auto", text: "AUTO" }) : null,
        ),
      ),
    ),
  );
}
function setSelection(slotId, ids) {
  state.template.selection.media[slotId] = ids;
  markDirty();
  renderVariations();
  renderSteps();
}
$("[data-all='phrases']").onclick = () => {
  state.template.selection.phrases = state.template.phrases.map((p) => p.id);
  markDirty();
  renderVariations();
  renderSteps();
};
$("[data-none='phrases']").onclick = () => {
  state.template.selection.phrases = [];
  markDirty();
  renderVariations();
  renderSteps();
};
// ---------- Generate and batches ----------
function primaryDuration() {
  const slot = slotList(state.template).find((s) => s.type === "video"),
    ids = slot ? state.template.selection.media[slot.id] || [] : [],
    options = media(slot?.id).filter((o) => ids.includes(o.id));
  if (!options.length) return null;
  const lengths = options.map((o) => o.end - o.start);
  return [Math.min(...lengths), Math.max(...lengths)];
}
function renderGenerateSummary() {
  const count = variationCount(state.template),
    range = primaryDuration();
  $("#generate-summary").textContent = count
    ? `${count} ${count === 1 ? "variação" : "variações"} · ${range ? (range[0] === range[1] ? fmt(range[0]) + " s" : `${fmt(range[0])}–${fmt(range[1])} s`) : ""} cada · MP4 720 × 1280`
    : "Nenhuma variação selecionada.";
  const button = $("#generate-start"),
    limits = state.limits,
    left = limits ? limits.renders.limit - limits.renders.used : Infinity;
  // One active batch per template at a time avoids accidental duplicates.
  const running =
    state.batch?.active && state.batch.projectId === state.project?.id;
  button.textContent = running
    ? "Lote em andamento…"
    : `Gerar ${count} ${count === 1 ? "variação" : "variações"}`;
  button.disabled = running || !count || count > LIMITS.batch || count > left;
}
function renderGenerate() {
  renderGenerateSummary();
  const limits = state.limits;
  $("#generate-quota").textContent = limits
    ? `${limits.renders.used} de ${limits.renders.limit} exportações usadas neste mês · ${limits.active} de ${limits.maxActive} operações em andamento. Cada variação conta como uma exportação; falhas e cancelamentos devolvem a cota.`
    : "";
  const picker = $("#batch-picker");
  picker.hidden = state.batches.length < 2;
  $("#batch-select").replaceChildren(
    ...state.batches.map((b) =>
      el("option", {
        value: b.id,
        text: `${new Date(b.created).toLocaleString("pt-BR")} · ${b.total} variações`,
        selected: b.id === state.batch?.id,
      }),
    ),
  );
  renderBatch();
}
async function refreshLimits() {
  try {
    state.limits = await api("/templates/limits");
    renderAI();
    renderVariations();
    if (state.step === "generate") renderGenerate();
  } catch {}
}
async function loadBatches(selectId) {
  if (!state.project) return;
  state.batches = await api("/batches?projectId=" + state.project.id);
  const id = selectId || state.batch?.id || state.batches[0]?.id;
  state.batch = id ? await api("/batches/" + id) : null;
  renderSteps();
  if (state.step === "generate") renderGenerate();
  schedulePoll();
}
function schedulePoll() {
  clearInterval(pollTimer);
  if (!state.batch?.active) return;
  pollTimer = setInterval(async () => {
    if (document.hidden || !state.batch) return;
    try {
      const previous = state.batch;
      state.batch = await api("/batches/" + previous.id);
      const entry = state.batches.find((b) => b.id === previous.id);
      if (entry)
        Object.assign(entry, {
          counts: state.batch.counts,
          active: state.batch.active,
        });
      if (state.step === "generate") {
        renderBatch();
        renderGenerateSummary();
      }
      if (!state.batch.active) {
        clearInterval(pollTimer);
        refreshLimits();
        window.dispatchEvent(new Event("viceclipz:projects-changed"));
      }
    } catch (e) {
      $("#batch-status").textContent = e.message;
    }
  }, 2000);
}
function eta(seconds) {
  if (seconds == null)
    return "estimativa disponível após a primeira renderização deste servidor";
  if (seconds < 60) return "menos de 1 min";
  return `cerca de ${Math.round(seconds / 60)} min`;
}
function itemDetail(item) {
  if (item.state === "running")
    return `${ITEM_STATES.running} ${item.progress}%`;
  if (item.state === "queued")
    return `${ITEM_STATES.queued} · posição ${item.position ?? "–"} · ${eta(item.eta)}`;
  if (item.state === "failed") return item.error || ITEM_STATES.failed;
  if (item.state === "done") return `${ITEM_STATES.done} · ${bytes(item.size)}`;
  return ITEM_STATES[item.state] || item.state;
}
function itemCard(item) {
  const card = el("li", {
    class: "batch-card " + item.state,
    "data-id": item.id,
    "data-state": item.state,
  });
  card.append(
    el(
      "div",
      { class: "batch-card-head" },
      el("strong", { text: "#" + String(item.index).padStart(2, "0") }),
      el("span", {
        class: "batch-state",
        text: ITEM_STATES[item.state] || item.state,
      }),
    ),
    el("p", { class: "batch-phrase", text: item.phrase }),
  );
  if (item.state === "done")
    card.append(
      el("video", {
        class: "batch-video",
        controls: true,
        preload: "metadata",
        playsinline: true,
        src: `/api/jobs/${item.id}/download?inline=1#t=0.1`,
        "aria-label": `Prévia da variação ${item.index}`,
      }),
    );
  card.append(
    el(
      "div",
      {
        class: "job-progress",
        hidden: !["running", "queued", "cancelling"].includes(item.state),
      },
      el("i", { style: `width:${item.progress}%` }),
    ),
    el("p", { class: "batch-detail", text: itemDetail(item) }),
  );
  const actions = el("div", { class: "actions" });
  if (item.state === "done")
    actions.append(
      el("a", {
        class: "download-link",
        href: `/api/jobs/${item.id}/download`,
        download: `variacao-${item.index}.mp4`,
        text: "Baixar ↓",
      }),
    );
  if (["queued", "running"].includes(item.state))
    actions.append(itemButton("Cancelar", `/jobs/${item.id}/cancel`));
  if (["failed", "cancelled"].includes(item.state) && item.attempts < 3)
    actions.append(itemButton("Tentar novamente", `/jobs/${item.id}/retry`));
  card.append(actions);
  return card;
}
function itemButton(text, path) {
  return el("button", {
    type: "button",
    class: "secondary",
    text,
    onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api(path, "POST");
        await loadBatches(state.batch.id);
        refreshLimits();
      } catch (err) {
        $("#batch-status").textContent = err.message;
      }
    },
  });
}
function renderBatch() {
  const batch = state.batch,
    grid = $("#batch-grid");
  $("#batch-toolbar").hidden = !batch;
  if (!batch) {
    grid.replaceChildren();
    $("#batch-status").textContent = state.batches.length
      ? ""
      : "Nenhum lote gerado para este template ainda.";
    return;
  }
  const items = batch.items || [],
    counts = batch.counts,
    waiting = items.filter((i) => ["queued", "running"].includes(i.state)),
    last = waiting.reduce((n, i) => Math.max(n, i.eta ?? 0), 0),
    unknown = waiting.some((i) => i.state === "queued" && i.eta == null);
  $("#batch-status").textContent =
    `${counts.done || 0} de ${batch.total} prontas` +
    (counts.failed ? ` · ${counts.failed} com falha` : "") +
    (counts.cancelled ? ` · ${counts.cancelled} canceladas` : "") +
    (waiting.length
      ? ` · conclusão do lote: ${unknown ? eta(null) : eta(last)}`
      : "");
  $("#batch-cancel").disabled = !batch.active;
  $("#batch-retry").disabled = !items.some(
    (i) => ["failed", "cancelled"].includes(i.state) && i.attempts < 3,
  );
  $("#batch-remove").disabled = batch.active;
  const zip = $("#batch-zip");
  zip.hidden = !counts.done;
  zip.href = `/api/batches/${batch.id}/archive`;
  // Keyed update keeps finished videos (and their playback) in place between polls.
  const existing = new Map(
    $$(".batch-card", grid).map((c) => [c.dataset.id, c]),
  );
  const cards = items.map((item) => {
    const card = existing.get(item.id);
    if (card && card.dataset.state === item.state && item.state === "done")
      return card;
    if (
      card &&
      card.dataset.state === item.state &&
      ["queued", "running", "cancelling"].includes(item.state)
    ) {
      $(".job-progress i", card).style.width = item.progress + "%";
      $(".batch-detail", card).textContent = itemDetail(item);
      return card;
    }
    return itemCard(item);
  });
  if (
    cards.length !== existing.size ||
    cards.some((c, i) => grid.children[i] !== c)
  )
    grid.replaceChildren(...cards);
}
$("#batch-select").onchange = (e) =>
  loadBatches(e.target.value).catch(
    (err) => ($("#batch-status").textContent = err.message),
  );
$("#generate-start").onclick = async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  setError();
  try {
    if (state.dirty) await save();
    state.batchKey ||= crypto.randomUUID();
    const batch = await api(`/templates/${state.project.id}/batches`, "POST", {
      requestKey: state.batchKey,
      revision: state.project.revision,
    });
    state.batchKey = null;
    await loadBatches(batch.id);
    await refreshLimits();
    $("#batch-grid").scrollIntoView({ block: "nearest" });
  } catch (err) {
    setError(err.message);
  } finally {
    renderGenerateSummary();
  }
};
async function batchAction(button, path, method = "POST") {
  button.disabled = true;
  try {
    await api(path, method);
    await refreshLimits();
  } catch (err) {
    $("#batch-status").textContent = err.message;
  } finally {
    await loadBatches(method === "DELETE" ? undefined : state.batch?.id).catch(
      () => {},
    );
  }
}
$("#batch-cancel").onclick = (e) =>
  batchAction(e.currentTarget, `/batches/${state.batch.id}/cancel`);
$("#batch-retry").onclick = (e) =>
  batchAction(e.currentTarget, `/batches/${state.batch.id}/retry`);
$("#batch-remove").onclick = (e) => {
  const id = state.batch.id;
  state.batch = null;
  batchAction(e.currentTarget, `/batches/${id}`, "DELETE");
};
// ---------- Live preview ----------
function previewPayload() {
  const t = state.template,
    phrase = t.phrases.find((p) => p.id === state.activePhrase) || t.phrases[0];
  return {
    layout: t.layout,
    background: t.background,
    profile: t.profile,
    style: t.style,
    zones: t.zones,
    phrase: phrase ? phrase.text : PLACEHOLDER,
  };
}
function schedulePreview(delay = 180) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, delay);
}
async function renderPreview() {
  if (!state.template) return;
  const seq = ++state.previewSeq;
  try {
    const result = await api("/templates/preview", "POST", previewPayload());
    if (seq !== state.previewSeq) return;
    state.layout = result.layout;
    $("#stage-overlay").src = result.image;
    $("#stage-overlay").hidden = false;
    $("#stage-status").textContent =
      "A prévia usa a mesma geometria e o mesmo cartão do MP4.";
    layoutStage();
  } catch (e) {
    if (seq === state.previewSeq) $("#stage-status").textContent = e.message;
  }
}
function sourceSize(element, asset) {
  return element.tagName === "VIDEO"
    ? [element.videoWidth || asset.width, element.videoHeight || asset.height]
    : [
        element.naturalWidth || asset.width,
        element.naturalHeight || asset.height,
      ];
}
function createMedia(asset) {
  const url = `/api/assets/${asset.id}/content`;
  const element =
    asset.kind === "image"
      ? el("img", { src: url, alt: "" })
      : el("video", {
          src: url,
          playsinline: true,
          preload: "auto",
          muted: true,
        });
  element.className = "stage-media";
  element.dataset.asset = asset.id;
  if (asset.kind === "video") {
    element.muted = true;
    element.addEventListener("loadedmetadata", layoutStage);
    element.addEventListener("loadeddata", drawBlur);
    element.addEventListener("seeked", drawBlur);
    element.addEventListener("error", () => {
      $("#stage-status").textContent =
        "Este navegador não reproduz um dos vídeos. A exportação MP4 ainda pode convertê-lo.";
    });
  } else element.addEventListener("load", layoutStage);
  return element;
}
function layoutStage() {
  const layout = state.layout;
  if (!layout || !state.template) return;
  const stage = $("#stage"),
    k = stage.clientWidth / CANVAS.width,
    container = $("#stage-cells"),
    slots = slotList(state.template),
    seen = new Set();
  for (const cell of layout.zones.flatMap((z) => z.cells)) {
    const slot = slots.find((s) => s.id === cell.slotId);
    if (!slot) continue;
    seen.add(cell.slotId);
    let box = container.querySelector(`[data-slot="${cell.slotId}"]`);
    if (!box) {
      box = el("div", { class: "stage-cell", "data-slot": cell.slotId });
      container.append(box);
    }
    Object.assign(box.style, {
      left: cell.x * k + "px",
      top: cell.y * k + "px",
      width: cell.width * k + "px",
      height: cell.height * k + "px",
    });
    const option = activeOptionFor(cell.slotId),
      asset = option && assetById(option.assetId);
    let element = box.querySelector(".stage-media");
    box.dataset.label = asset
      ? ""
      : `${slot.label} · ${slot.type === "video" ? "vídeo" : "imagem"}`;
    if (!asset) {
      element?.remove();
      continue;
    }
    if (!element || element.dataset.asset !== asset.id) {
      element?.remove();
      element = createMedia(asset);
      box.append(element);
      if (element.tagName === "VIDEO")
        element.addEventListener(
          "loadedmetadata",
          () =>
            (element.currentTime = activeOptionFor(cell.slotId)?.start || 0),
          { once: true },
        );
    }
    const [sw, sh] = sourceSize(element, asset),
      p = placement(
        sw,
        sh,
        cell.width,
        cell.height,
        cell.fit,
        option.zoom,
        option.x,
        option.y,
      );
    Object.assign(element.style, {
      left: p.x * k + "px",
      top: p.y * k + "px",
      width: p.width * k + "px",
      height: p.height * k + "px",
    });
  }
  for (const box of $$(".stage-cell", container))
    if (!seen.has(box.dataset.slot)) box.remove();
  const blur = state.template.background === "blur";
  $("#stage-blur").hidden = !blur;
  if (blur) drawBlur();
}
function stageVideos() {
  return slotList(state.template)
    .filter((s) => s.type === "video")
    .map((slot) => ({
      slot,
      option: activeOptionFor(slot.id),
      element: $(`#stage-cells [data-slot="${slot.id}"] video`),
    }))
    .filter((v) => v.option && v.element);
}
function drawBlur() {
  if (state.template?.background !== "blur") return;
  const primary = stageVideos()[0]?.element;
  if (!primary || primary.readyState < 2 || !primary.videoWidth) return;
  const canvas = $("#stage-blur"),
    w = canvas.width,
    h = canvas.height,
    p = placement(
      primary.videoWidth,
      primary.videoHeight,
      w,
      h,
      "cover",
      1,
      50,
      50,
    );
  canvas
    .getContext("2d")
    .drawImage(
      primary,
      p.source.x,
      p.source.y,
      p.source.width,
      p.source.height,
      0,
      0,
      w,
      h,
    );
  canvas.style.filter = `blur(${((BLUR_SIGMA * $("#stage").clientWidth) / w).toFixed(1)}px)`;
}
async function startPlayback(styleLoop = false) {
  const list = stageVideos();
  if (!list.length) {
    if (!styleLoop)
      $("#stage-status").textContent =
        "Adicione um vídeo na etapa Mídia para reproduzir.";
    return;
  }
  for (const [i, v] of list.entries()) {
    v.element.currentTime = v.option.start;
    v.element.muted = styleLoop || i > 0 || state.template.mute;
  }
  playing = true;
  $("#stage-play").textContent = "Ⅱ Pausar";
  await Promise.all(list.map((v) => v.element.play().catch(() => {})));
  tick();
}
function stopPlayback() {
  playing = false;
  cancelAnimationFrame(frame);
  $("#stage-play").textContent = "▶ Reproduzir";
  for (const video of $$("#stage-cells video")) video.pause();
}
// Mirrors the export: the primary trim sets the length; shorter videos hold their last frame.
function tick() {
  if (!playing) return;
  const list = stageVideos(),
    primary = list[0];
  if (!primary) return stopPlayback();
  const end =
      state.step === "style"
        ? Math.min(primary.option.end, primary.option.start + 3)
        : primary.option.end,
    elapsed = primary.element.currentTime - primary.option.start;
  if (primary.element.currentTime >= end - 0.04 || primary.element.ended) {
    for (const v of list) {
      v.element.currentTime = v.option.start;
      v.element.play().catch(() => {});
    }
  }
  for (const v of list.slice(1))
    if (v.element.currentTime >= v.option.end - 0.04 && !v.element.paused)
      v.element.pause();
  drawBlur();
  $("#stage-time").textContent =
    `${fmt(Math.max(0, elapsed))} s / ${fmt(end - primary.option.start)} s`;
  frame = requestAnimationFrame(tick);
}
$("#stage-play").onclick = () =>
  playing ? stopPlayback() : startPlayback(false);
new ResizeObserver(() => layoutStage()).observe($("#stage"));
window.addEventListener("hashchange", route);
window.addEventListener("viceclipz:assets-changed", async () => {
  if (!state.template) return;
  try {
    state.assets = await api("/assets");
    renderAvatar();
    renderMedia();
  } catch {}
});
renderGallery();
