// Shared by the browser builder and the Node renderer. Keep it free of DOM and Node APIs
// so the preview and the FFmpeg export use the same limits, presets and placement math.
export const CANVAS = Object.freeze({
  format: "9:16",
  width: 720,
  height: 1280,
});
export const LIMITS = Object.freeze({
  title: 80,
  zones: 4,
  slots: 2,
  options: 20,
  phrases: 50,
  phrase: 280,
  batch: 50,
  name: 50,
  handle: 30,
  saved: 20,
  savedName: 40,
});
export const RANGES = Object.freeze({
  avatarSize: [32, 200],
  nameSize: [16, 72],
  handleSize: [12, 60],
  size: [18, 96],
  padding: [0, 160],
  spacing: [0, 160],
  strokeWidth: [1, 12],
  height: [10, 100],
  zoom: [1, 3],
  x: [0, 100],
  y: [0, 100],
});
export const FONTS = Object.freeze({
  "inter-bold": "Inter Bold",
  "inter-black": "Inter Black",
  "montserrat-extrabold": "Montserrat ExtraBold",
  anton: "Anton",
  "bebas-neue": "Bebas Neue",
});
export const LAYOUTS = Object.freeze({
  post: "Post card",
  meme: "Meme",
  viral: "Vídeo viral",
});
// The blurred background is rendered small, blurred and scaled up; the preview mirrors it.
export const BLUR = Object.freeze({ divisor: 8, radius: 4, power: 2 });
export const PRESETS = Object.freeze({
  single: { label: "1 vídeo (padrão)", zones: [[100, ["video"]]] },
  blur: {
    label: "1 vídeo com fundo blur",
    zones: [[100, ["video"]]],
    background: "blur",
    fit: "contain",
  },
  stacked: {
    label: "2 vídeos empilhados",
    zones: [
      [50, ["video"]],
      [50, ["video"]],
    ],
  },
  "image-video": {
    label: "Imagem fixa + vídeo",
    zones: [
      [40, ["image"]],
      [60, ["video"]],
    ],
  },
  "video-images": {
    label: "Vídeo + 2 imagens lado a lado",
    zones: [
      [60, ["video"]],
      [40, ["image", "image"]],
    ],
  },
});
export function makeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}
const defaults = {
  post: {
    profile: {
      avatar: true,
      verified: true,
      showName: true,
      showHandle: true,
      align: "left",
      theme: "light",
      order: "profile-top",
      avatarSize: 76,
      nameSize: 30,
      handleSize: 26,
    },
    style: {
      font: "inter-bold",
      color: "#111111",
      size: 40,
      padding: 40,
      spacing: 36,
    },
    preset: "single",
  },
  meme: {
    profile: {
      avatar: true,
      verified: false,
      showName: true,
      showHandle: true,
      align: "center",
      theme: "dark",
      order: "text-top",
      avatarSize: 60,
      nameSize: 26,
      handleSize: 22,
    },
    style: {
      font: "inter-black",
      color: "#ffffff",
      size: 50,
      padding: 36,
      spacing: 34,
    },
    preset: "single",
  },
  viral: {
    profile: {
      avatar: false,
      verified: false,
      showName: false,
      showHandle: false,
      align: "center",
      theme: "dark",
      order: "profile-top",
      avatarSize: 60,
      nameSize: 26,
      handleSize: 22,
    },
    style: {
      font: "montserrat-extrabold",
      color: "#ffffff",
      size: 44,
      padding: 32,
      spacing: 26,
    },
    zones: [
      [50, ["video"]],
      [50, ["image"]],
    ],
  },
};
export function defaultTemplate(layout, displayName = "") {
  const base = defaults[layout] || defaults.post;
  const template = {
    kind: "template",
    version: 2,
    name: "Meu " + (LAYOUTS[layout] || LAYOUTS.post).toLowerCase(),
    layout: Object.hasOwn(defaults, layout) ? layout : "post",
    format: CANVAS.format,
    background: "black",
    mute: false,
    profile: {
      ...base.profile,
      avatarAssetId: null,
      name: String(displayName).slice(0, LIMITS.name),
      handle: "",
    },
    style: {
      stroke: false,
      strokeWidth: 3,
      strokeColor: "#000000",
      ...base.style,
    },
    zones: [],
    media: {},
    phrases: [],
    selection: { media: {}, phrases: [] },
  };
  return base.zones
    ? { ...template, zones: buildZones(base.zones, "cover", {}) }
    : applyPreset(template, base.preset);
}
function buildZones(spec, fit, pool) {
  return spec.map(([height, types]) => ({
    id: makeId(),
    height,
    slots: types.map((type) => ({
      id: pool[type]?.shift() || makeId(),
      type,
      fit,
    })),
  }));
}
// Reuses existing slot ids of the same type, in order, so uploaded options survive a preset change.
export function applyPreset(template, key) {
  const preset = PRESETS[key];
  if (!preset) return template;
  const pool = { video: [], image: [] };
  for (const slot of slotList(template)) pool[slot.type].push(slot.id);
  return prune({
    ...template,
    background: preset.background || "black",
    zones: buildZones(preset.zones, preset.fit || "cover", pool),
  });
}
// Drops media options and selections that point at slots or phrases that no longer exist.
export function prune(template) {
  const slots = new Map(slotList(template).map((s) => [s.id, s]));
  const media = {},
    selected = {};
  for (const [id, options] of Object.entries(template.media || {}))
    if (slots.has(id)) {
      media[id] = options;
      const ids = new Set(options.map((o) => o.id));
      selected[id] = (template.selection?.media?.[id] || []).filter((o) =>
        ids.has(o),
      );
    }
  const phrases = new Set((template.phrases || []).map((p) => p.id));
  return {
    ...template,
    media,
    selection: {
      media: selected,
      phrases: (template.selection?.phrases || []).filter((p) =>
        phrases.has(p),
      ),
    },
  };
}
export function slotList(template) {
  const list = [];
  (template.zones || []).forEach((zone, z) =>
    zone.slots.forEach((slot, s) =>
      list.push({
        ...slot,
        zoneId: zone.id,
        label:
          `Zona ${z + 1}` +
          (zone.slots.length > 1 ? (s ? " · direita" : " · esquerda") : ""),
      }),
    ),
  );
  return list;
}
export function variationCount(template) {
  const slots = slotList(template);
  if (!slots.some((s) => s.type === "video")) return 0;
  let count = (template.selection?.phrases || []).length;
  for (const slot of slots)
    count *= (template.selection?.media?.[slot.id] || []).length;
  return count;
}
// Places a source of sw×sh inside a cell of cw×ch. x/y (0–100) choose which part of the
// overflow (cover/zoom) or of the free space (contain) is used. `source` is the visible
// rectangle in source pixels, used by FFmpeg; the preview positions the element directly.
export function placement(
  sw,
  sh,
  cw,
  ch,
  fit = "cover",
  zoom = 1,
  x = 50,
  y = 50,
) {
  const base =
    fit === "contain" ? Math.min(cw / sw, ch / sh) : Math.max(cw / sw, ch / sh);
  const scale = base * zoom,
    width = sw * scale,
    height = sh * scale,
    left = (cw - width) * (x / 100),
    top = (ch - height) * (y / 100);
  const vx = Math.max(0, left),
    vy = Math.max(0, top),
    vw = Math.min(cw, left + width) - vx,
    vh = Math.min(ch, top + height) - vy;
  return {
    scale,
    x: left,
    y: top,
    width,
    height,
    visible: { x: vx, y: vy, width: vw, height: vh },
    source: {
      x: (vx - left) / scale,
      y: (vy - top) / scale,
      width: vw / scale,
      height: vh / scale,
    },
  };
}
