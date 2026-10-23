import {
  CANVAS,
  LIMITS,
  RANGES,
  FONTS,
  LAYOUTS,
  slotList,
} from "../dist/template-core.js";
import { InputError } from "./composition.mjs";
import { MAX_EXPORT } from "./config.mjs";
const ID = /^[a-z0-9]{1,16}$/,
  HEX = /^#[0-9a-f]{6}$/i,
  HANDLE = /^[A-Za-z0-9_.]*$/;
const fail = (message) => {
  throw new InputError(message);
};
const isObject = (v) =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
function pick(value, options, label) {
  if (!options.includes(value)) fail(label + " inválido.");
  return value;
}
function integer(value, key, label) {
  const [min, max] = RANGES[key],
    n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`${label}: use um número inteiro entre ${min} e ${max}.`);
  return n;
}
function decimal(value, key, label, places = 2) {
  const [min, max] = RANGES[key],
    n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    fail(`${label}: use um valor entre ${min} e ${max}.`);
  return round(n, places);
}
function color(value, label) {
  if (typeof value !== "string" || !HEX.test(value))
    fail(label + ": use uma cor hexadecimal, como #ff4fa3.");
  return value.toLowerCase();
}
// Normalizes user text for the canvas renderer. Returns null when it is too long.
export function cleanText(value, max, { lines = 0 } = {}) {
  let text = String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n");
  if (lines)
    text = text
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  else text = text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  if ([...text].length > max || (lines && text.split("\n").length > lines))
    return null;
  return text;
}
export function validateProfile(raw, findAsset) {
  if (!isObject(raw)) fail("Perfil inválido.");
  const name = cleanText(raw.name, LIMITS.name),
    handle = String(raw.handle ?? "")
      .trim()
      .replace(/^@/, "");
  if (name === null) fail(`Use um nome de até ${LIMITS.name} caracteres.`);
  if (handle.length > LIMITS.handle || !HANDLE.test(handle))
    fail(
      `Use um @ de até ${LIMITS.handle} letras, números, pontos ou sublinhados.`,
    );
  let avatarAssetId = null;
  if (raw.avatarAssetId) {
    const asset = findAsset(String(raw.avatarAssetId));
    if (asset.kind !== "image") fail("O avatar precisa ser uma imagem.");
    avatarAssetId = asset.id;
  }
  return {
    avatar: raw.avatar === true,
    avatarAssetId,
    verified: raw.verified === true,
    showName: raw.showName === true,
    showHandle: raw.showHandle === true,
    name,
    handle,
    align: pick(raw.align, ["left", "center", "right"], "Alinhamento"),
    theme: pick(raw.theme, ["light", "dark"], "Tema do cartão"),
    order: pick(raw.order, ["profile-top", "text-top"], "Posição do perfil"),
    avatarSize: integer(raw.avatarSize, "avatarSize", "Tamanho do avatar"),
    nameSize: integer(raw.nameSize, "nameSize", "Tamanho do nome"),
    handleSize: integer(raw.handleSize, "handleSize", "Tamanho do @"),
  };
}
export function validateStyle(raw) {
  if (!isObject(raw)) fail("Estilo inválido.");
  return {
    font: pick(raw.font, Object.keys(FONTS), "Fonte"),
    color: color(raw.color, "Cor da frase"),
    stroke: raw.stroke === true,
    strokeWidth: integer(
      raw.strokeWidth,
      "strokeWidth",
      "Espessura do contorno",
    ),
    strokeColor: color(raw.strokeColor, "Cor do contorno"),
    size: integer(raw.size, "size", "Tamanho da frase"),
    padding: integer(raw.padding, "padding", "Margem lateral"),
    spacing: integer(raw.spacing, "spacing", "Espaçamento externo"),
  };
}
function validateZones(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > LIMITS.zones)
    fail(`Use de 1 a ${LIMITS.zones} zonas de mídia.`);
  const ids = new Set();
  const unique = (id) => {
    if (typeof id !== "string" || !ID.test(id) || ids.has(id))
      fail("Identificador de zona inválido.");
    ids.add(id);
    return id;
  };
  return raw.map((zone) => {
    if (
      !isObject(zone) ||
      !Array.isArray(zone.slots) ||
      zone.slots.length < 1 ||
      zone.slots.length > LIMITS.slots
    )
      fail("Cada zona deve ter uma ou duas áreas de mídia.");
    return {
      id: unique(zone.id),
      height: integer(zone.height, "height", "Altura da zona"),
      slots: zone.slots.map((slot) => {
        if (!isObject(slot)) fail("Área de mídia inválida.");
        return {
          id: unique(slot.id),
          type: pick(slot.type, ["video", "image"], "Tipo de mídia"),
          fit: pick(slot.fit ?? "cover", ["cover", "contain"], "Enquadramento"),
        };
      }),
    };
  });
}
function validateOption(raw, slot, findAsset, ids) {
  if (
    !isObject(raw) ||
    typeof raw.id !== "string" ||
    !ID.test(raw.id) ||
    ids.has(raw.id)
  )
    fail("Opção de mídia inválida.");
  ids.add(raw.id);
  const asset = findAsset(String(raw.assetId || ""));
  if (asset.kind !== slot.type)
    fail(
      slot.type === "video"
        ? `${slot.label} aceita apenas vídeos.`
        : `${slot.label} aceita apenas imagens.`,
    );
  const option = {
    id: raw.id,
    assetId: asset.id,
    zoom: decimal(raw.zoom ?? 1, "zoom", "Zoom"),
    x: decimal(raw.x ?? 50, "x", "Posição horizontal", 1),
    y: decimal(raw.y ?? 50, "y", "Posição vertical", 1),
  };
  if (slot.type === "video") {
    const start = round(Number(raw.start ?? 0)),
      end = round(
        Number(
          raw.end ??
            Math.floor(Math.min(asset.duration, MAX_EXPORT) * 100) / 100,
        ),
      );
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end - start < 0.25 ||
      end - start > MAX_EXPORT + 0.01 ||
      end > asset.duration + 0.05
    )
      fail(
        `Escolha um corte entre 0,25 e ${MAX_EXPORT} segundos, dentro da duração do vídeo.`,
      );
    Object.assign(option, { start, end });
  }
  return option;
}
function validatePhrases(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > LIMITS.phrases)
    fail(`Use até ${LIMITS.phrases} frases por template.`);
  const ids = new Set();
  return raw.map((phrase) => {
    if (
      !isObject(phrase) ||
      typeof phrase.id !== "string" ||
      !ID.test(phrase.id) ||
      ids.has(phrase.id)
    )
      fail("Frase inválida.");
    ids.add(phrase.id);
    const text = cleanText(phrase.text, LIMITS.phrase, { lines: 8 });
    if (!text)
      fail(
        `Cada frase deve ter de 1 a ${LIMITS.phrase} caracteres e até 8 linhas.`,
      );
    return { id: phrase.id, text, auto: phrase.auto === true };
  });
}
function subset(raw, allowed) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((id) => !allowed.has(id)))
    fail("Seleção de variações inválida.");
  return [...new Set(raw)];
}
// Draft validation: structure and ownership are strict, completeness is checked by
// buildVariations so a template can be saved step by step.
export function validateTemplate(raw, findAsset) {
  if (!isObject(raw) || raw.kind !== "template") fail("Template inválido.");
  const name = cleanText(raw.name, LIMITS.title);
  if (!name) fail(`Dê um nome ao template (até ${LIMITS.title} caracteres).`);
  if (raw.format !== CANVAS.format) fail("Os templates exportam em 9:16.");
  const assets = new Map(),
    lookup = (id) => {
      if (!assets.has(id)) assets.set(id, findAsset(id));
      return assets.get(id);
    };
  const zones = validateZones(raw.zones),
    slots = slotList({ zones }),
    media = {},
    optionIds = new Set();
  if (raw.media !== undefined && !isObject(raw.media))
    fail("Mídias inválidas.");
  for (const [slotId, options] of Object.entries(raw.media || {})) {
    const slot = slots.find((s) => s.id === slotId);
    if (!slot) fail("Mídia associada a uma zona inexistente.");
    if (!Array.isArray(options) || options.length > LIMITS.options)
      fail(`Use até ${LIMITS.options} mídias por zona.`);
    media[slotId] = options.map((o) =>
      validateOption(o, slot, lookup, optionIds),
    );
  }
  const phrases = validatePhrases(raw.phrases),
    selection = isObject(raw.selection) ? raw.selection : {};
  if (selection.media !== undefined && !isObject(selection.media))
    fail("Seleção de variações inválida.");
  const selectedMedia = {};
  for (const [slotId, ids] of Object.entries(selection.media || {})) {
    if (!media[slotId]) fail("Seleção de variações inválida.");
    selectedMedia[slotId] = subset(
      ids,
      new Set(media[slotId].map((o) => o.id)),
    );
  }
  return {
    kind: "template",
    version: 2,
    name,
    layout: pick(raw.layout, Object.keys(LAYOUTS), "Layout"),
    format: CANVAS.format,
    background: pick(raw.background ?? "black", ["black", "blur"], "Fundo"),
    mute: raw.mute === true,
    profile: validateProfile(raw.profile, lookup),
    style: validateStyle(raw.style),
    zones,
    media,
    phrases,
    selection: {
      media: selectedMedia,
      phrases: subset(selection.phrases, new Set(phrases.map((p) => p.id))),
    },
  };
}
// Only the parts that change the overlay and zone geometry; media files are not needed.
export function validatePreview(raw, findAsset) {
  if (!isObject(raw)) fail("Prévia inválida.");
  const phrase = cleanText(raw.phrase, LIMITS.phrase, { lines: 8 });
  if (phrase === null) fail(`Use até ${LIMITS.phrase} caracteres e 8 linhas.`);
  return {
    layout: pick(raw.layout, Object.keys(LAYOUTS), "Layout"),
    background: pick(raw.background ?? "black", ["black", "blur"], "Fundo"),
    profile: validateProfile(raw.profile, findAsset),
    style: validateStyle(raw.style),
    zones: validateZones(raw.zones),
    phrase,
  };
}
// Primary video: the first video area, top to bottom and left to right. Its trim sets the
// output duration and only its audio is kept. Shorter secondary videos hold their last frame.
export function buildVariations(template) {
  const slots = slotList(template),
    primary = slots.find((s) => s.type === "video"),
    profile = template.profile;
  if (!primary)
    fail("Adicione ao menos uma zona de vídeo para gerar variações.");
  if (profile.showName && !profile.name)
    fail("Informe o nome do perfil ou desative a exibição do nome.");
  if (profile.showHandle && !profile.handle)
    fail("Informe o @ do perfil ou desative a exibição do @.");
  const phrases = template.selection.phrases.map((id) =>
    template.phrases.find((p) => p.id === id),
  );
  if (!phrases.length) fail("Selecione ao menos uma frase.");
  const choices = slots.map((slot) => {
    const ids = template.selection.media[slot.id] || [];
    if (!ids.length) fail(`Selecione ao menos uma mídia para ${slot.label}.`);
    return ids.map((id) => template.media[slot.id].find((o) => o.id === id));
  });
  const total = choices.reduce((n, c) => n * c.length, phrases.length);
  if (total > LIMITS.batch)
    fail(
      `Cada lote gera até ${LIMITS.batch} variações e esta seleção gera ${total}. Selecione menos mídias ou frases.`,
    );
  let combos = [[]];
  for (const options of choices)
    combos = combos.flatMap((combo) => options.map((o) => [...combo, o]));
  const variations = [];
  for (const phrase of phrases)
    for (const combo of combos) {
      const cells = {};
      slots.forEach((slot, i) => {
        const o = combo[i];
        cells[slot.id] = {
          type: slot.type,
          assetId: o.assetId,
          zoom: o.zoom,
          x: o.x,
          y: o.y,
          ...(slot.type === "video" ? { start: o.start, end: o.end } : {}),
        };
      });
      const lead = cells[primary.id],
        index = variations.length + 1;
      variations.push({
        version: 2,
        kind: "variation",
        index,
        name: `${template.name} · Variação ${index}`,
        format: template.format,
        layout: template.layout,
        background: template.background,
        mute: template.mute,
        profile,
        style: template.style,
        zones: template.zones,
        primary: primary.id,
        cells,
        phrase: phrase.text,
        duration: round(lead.end - lead.start),
      });
    }
  return variations;
}
// Every asset a project, template or job snapshot depends on.
export function referencedAssets(data) {
  const ids = new Set();
  if (data.assetId) ids.add(data.assetId);
  if (data.profile?.avatarAssetId) ids.add(data.profile.avatarAssetId);
  for (const options of Object.values(data.media || {}))
    for (const o of options) ids.add(o.assetId);
  for (const cell of Object.values(data.cells || {})) ids.add(cell.assetId);
  return ids;
}
