import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CANVAS, BLUR, placement } from "../dist/template-core.js";
import { ROOT, assetPath } from "./config.mjs";
const FONT_FILES = {
  "inter-regular": "Inter-Regular.ttf",
  "inter-bold": "Inter-Bold.ttf",
  "inter-black": "Inter-Black.ttf",
  "montserrat-extrabold": "Montserrat-ExtraBold.ttf",
  anton: "Anton-Regular.ttf",
  "bebas-neue": "BebasNeue-Regular.ttf",
};
export const missingFonts = Object.entries(FONT_FILES)
  .filter(
    ([key, file]) =>
      !GlobalFonts.registerFromPath(
        path.join(ROOT, "fonts", file),
        "VC " + key,
      ),
  )
  .map(([key]) => key);
// A missing or unreadable avatar falls back to the initial-letter placeholder.
export async function loadAvatar(assetId) {
  if (!assetId) return null;
  try {
    return await loadImage(await readFile(assetPath(assetId)));
  } catch {
    return null;
  }
}
const font = (key, size) => `${size}px "VC ${key}"`;
const THEMES = {
  light: {
    band: "#ffffff",
    glass: "rgba(255,255,255,0.78)",
    name: "#111111",
    handle: "#5f5f6b",
  },
  dark: {
    band: "#000000",
    glass: "rgba(0,0,0,0.5)",
    name: "#ffffff",
    handle: "#a7a7b3",
  },
};
// Verified badge fill: the blue X uses for its checkmark (rgb 29, 155, 240). Only the
// color matches; the round badge with a white check is ViceClipz's own drawing.
const BADGE = "#1d9bf0",
  AVATAR = "#c9a7ff",
  // Bands never take more than this share of the height; the phrase shrinks first.
  MAX_BANDS = 0.6,
  MIN_SIZE = 16;
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
function ellipsize(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  const chars = [...text];
  while (chars.length && ctx.measureText(chars.join("") + "…").width > width)
    chars.pop();
  return chars.length ? chars.join("") + "…" : "";
}
function wrap(ctx, text, width) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (!word) continue;
      const candidate = line ? line + " " + word : word;
      if (ctx.measureText(candidate).width <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const char of word) {
        if (line && ctx.measureText(line + char).width > width) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}
function measureProfile(ctx, p, maxWidth) {
  if (!p.avatar && !(p.showName && p.name) && !(p.showHandle && p.handle))
    return null;
  const gap = p.avatar ? Math.max(12, Math.round(p.avatarSize * 0.22)) : 0,
    textMax = maxWidth - (p.avatar ? p.avatarSize + gap : 0),
    badge = p.verified ? Math.round(p.nameSize * 0.9) : 0;
  ctx.font = font("inter-bold", p.nameSize);
  const name =
    p.showName && p.name
      ? ellipsize(ctx, p.name, textMax - (badge ? badge + 8 : 0))
      : "";
  const nameWidth = name ? ctx.measureText(name).width : 0;
  ctx.font = font("inter-regular", p.handleSize);
  const handle =
    p.showHandle && p.handle
      ? ellipsize(
          ctx,
          "@" + p.handle,
          textMax - (!name && badge ? badge + 8 : 0),
        )
      : "";
  const handleWidth = handle ? ctx.measureText(handle).width : 0,
    nameHeight = name ? Math.round(p.nameSize * 1.2) : 0,
    handleHeight = handle ? Math.round(p.handleSize * 1.25) : 0,
    between = name && handle ? Math.round(p.handleSize * 0.15) : 0,
    textHeight = nameHeight + between + handleHeight,
    textWidth = Math.max(
      nameWidth + (name && badge ? badge + 8 : 0),
      handleWidth + (!name && handle && badge ? badge + 8 : 0),
    );
  return {
    name,
    handle,
    badge,
    gap: textWidth ? gap : 0,
    nameWidth,
    handleWidth,
    nameHeight,
    between,
    textHeight,
    width: (p.avatar ? p.avatarSize + (textWidth ? gap : 0) : 0) + textWidth,
    height: Math.max(p.avatar ? p.avatarSize : 0, textHeight),
  };
}
// Ordered blocks from top to bottom; zones receive the height left by the bands.
function arrange(spec, row, textHeight, size) {
  const spacing = spec.style.spacing,
    zones = spec.zones.map((zone, index) => ({ kind: "zone", index })),
    profile = row
      ? { kind: "profile", height: even(row.height + 2 * spacing) }
      : null,
    phrase = textHeight
      ? { kind: "phrase", height: even(textHeight + 2 * spacing) }
      : null,
    profileTop = spec.profile.order === "profile-top";
  let blocks;
  if (spec.layout === "post") {
    const gap = row && textHeight ? Math.round(Math.max(12, size * 0.45)) : 0,
      content = (row?.height || 0) + gap + textHeight;
    blocks = [
      content
        ? { kind: "card", height: even(content + 2 * spacing), gap }
        : null,
      ...zones,
    ];
  } else if (spec.layout === "meme")
    blocks = profileTop
      ? [profile, ...zones, phrase]
      : [phrase, ...zones, profile];
  else
    blocks = [
      profileTop ? profile : null,
      zones[0],
      phrase,
      ...zones.slice(1),
      profileTop ? null : profile,
    ];
  return blocks.filter(Boolean);
}
function place(spec, blocks) {
  const { width: W, height: H } = CANVAS,
    bands = blocks
      .filter((b) => b.kind !== "zone")
      .reduce((n, b) => n + b.height, 0),
    free = H - bands,
    weights = spec.zones.reduce((n, z) => n + z.height, 0);
  let y = 0,
    left = free,
    remaining = weights;
  const layout = { width: W, height: H, bands: [], zones: [] };
  for (const block of blocks) {
    if (block.kind !== "zone") {
      layout.bands.push({ ...block, y });
      y += block.height;
      continue;
    }
    const zone = spec.zones[block.index],
      height =
        remaining === zone.height
          ? left
          : even((left * zone.height) / remaining);
    left -= height;
    remaining -= zone.height;
    const half = even(W / 2);
    layout.zones.push({
      id: zone.id,
      y,
      height,
      cells: zone.slots.map((slot, i) => ({
        slotId: slot.id,
        type: slot.type,
        fit: slot.fit,
        x: zone.slots.length > 1 && i ? half : 0,
        y,
        width: zone.slots.length > 1 ? (i ? W - half : half) : W,
        height,
      })),
    });
    y += height;
  }
  return layout;
}
function drawBadge(ctx, x, y, size) {
  const r = size / 2,
    cx = x + r,
    cy = y + r;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = BADGE;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.45, cy + r * 0.02);
  ctx.lineTo(cx - r * 0.1, cy + r * 0.36);
  ctx.lineTo(cx + r * 0.48, cy - r * 0.3);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(2, r * 0.24);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}
function drawAvatar(ctx, p, image, x, y) {
  const size = p.avatarSize,
    r = size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
  ctx.clip();
  if (image) {
    const s = Math.max(size / image.width, size / image.height),
      w = image.width * s,
      h = image.height * s;
    ctx.drawImage(image, x + (size - w) / 2, y + (size - h) / 2, w, h);
  } else {
    ctx.fillStyle = AVATAR;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#1e0a28";
    ctx.font = font("inter-bold", Math.round(size * 0.45));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(([...(p.name || "")][0] || "V").toUpperCase(), x + r, y + r);
  }
  ctx.restore();
}
function drawProfile(ctx, p, row, image, top, theme, padding) {
  const { width: W } = CANVAS,
    x =
      p.align === "center"
        ? Math.round((W - row.width) / 2)
        : p.align === "right"
          ? W - padding - row.width
          : padding;
  if (p.avatar)
    drawAvatar(
      ctx,
      p,
      image,
      x,
      top + Math.round((row.height - p.avatarSize) / 2),
    );
  const tx = x + (p.avatar ? p.avatarSize + row.gap : 0),
    ty = top + Math.round((row.height - row.textHeight) / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  if (row.name) {
    ctx.font = font("inter-bold", p.nameSize);
    ctx.fillStyle = theme.name;
    ctx.fillText(row.name, tx, ty + Math.round(p.nameSize * 0.1));
    if (row.badge)
      drawBadge(
        ctx,
        tx + row.nameWidth + 8,
        ty + Math.round((row.nameHeight - row.badge) / 2),
        row.badge,
      );
  }
  if (row.handle) {
    const hy = ty + row.nameHeight + row.between;
    ctx.font = font("inter-regular", p.handleSize);
    ctx.fillStyle = theme.handle;
    ctx.fillText(row.handle, tx, hy + Math.round(p.handleSize * 0.12));
    if (!row.name && row.badge)
      drawBadge(
        ctx,
        tx + row.handleWidth + 8,
        hy + Math.round((Math.round(p.handleSize * 1.25) - row.badge) / 2),
        row.badge,
      );
  }
}
function drawPhrase(ctx, spec, lines, size, top) {
  const { width: W } = CANVAS,
    s = spec.style,
    lineHeight = Math.round(size * 1.25),
    align = spec.profile.align;
  ctx.font = font(s.font, size);
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  const x =
    align === "center" ? W / 2 : align === "right" ? W - s.padding : s.padding;
  lines.forEach((line, i) => {
    const y = top + i * lineHeight + Math.round((lineHeight - size) / 2);
    if (s.stroke) {
      ctx.lineWidth = s.strokeWidth * 2;
      ctx.strokeStyle = s.strokeColor;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = s.color;
    ctx.fillText(line, x, y);
  });
}
// Draws the profile card and phrase bands on a transparent canvas and returns the exact
// geometry of every band and media cell. The editor preview uses both unchanged.
export function renderOverlay(spec, phrase, avatar = null) {
  const { width: W, height: H } = CANVAS,
    canvas = createCanvas(W, H),
    ctx = canvas.getContext("2d"),
    s = spec.style,
    inner = W - 2 * s.padding - (s.stroke ? s.strokeWidth * 2 : 0),
    row = measureProfile(ctx, spec.profile, W - 2 * s.padding);
  let size = s.size,
    lines,
    blocks;
  const bandsHeight = () =>
    blocks.filter((b) => b.kind !== "zone").reduce((n, b) => n + b.height, 0);
  for (;;) {
    ctx.font = font(s.font, size);
    lines = phrase ? wrap(ctx, phrase, inner) : [];
    blocks = arrange(spec, row, lines.length * Math.round(size * 1.25), size);
    if (bandsHeight() <= H * MAX_BANDS || size <= MIN_SIZE) break;
    size -= 2;
  }
  while (bandsHeight() > H * MAX_BANDS && lines.length > 1) {
    lines.pop();
    lines[lines.length - 1] = ellipsize(ctx, lines.at(-1) + "…", inner);
    blocks = arrange(spec, row, lines.length * Math.round(size * 1.25), size);
  }
  const layout = place(spec, blocks),
    theme = THEMES[spec.profile.theme],
    textHeight = lines.length * Math.round(size * 1.25);
  for (const band of layout.bands) {
    ctx.fillStyle = spec.background === "blur" ? theme.glass : theme.band;
    ctx.fillRect(0, band.y, W, band.height);
    const content =
        band.kind === "profile"
          ? row.height
          : band.kind === "phrase"
            ? textHeight
            : (row?.height || 0) + band.gap + textHeight,
      top = band.y + Math.round((band.height - content) / 2);
    if (band.kind === "profile")
      drawProfile(ctx, spec.profile, row, avatar, top, theme, s.padding);
    else if (band.kind === "phrase") drawPhrase(ctx, spec, lines, size, top);
    else {
      const profileFirst = spec.profile.order === "profile-top",
        rowTop = profileFirst ? top : top + textHeight + band.gap,
        textTop = profileFirst ? top + (row ? row.height + band.gap : 0) : top;
      if (row)
        drawProfile(ctx, spec.profile, row, avatar, rowTop, theme, s.padding);
      if (lines.length) drawPhrase(ctx, spec, lines, size, textTop);
    }
  }
  return {
    image: canvas.toBuffer("image/png"),
    layout: {
      ...layout,
      bands: layout.bands.map(({ kind, y, height }) => ({ kind, y, height })),
      phraseSize: size,
      lines: lines.length,
    },
  };
}
const evenFloor = (n) => Math.floor(n / 2) * 2;
// Builds the FFmpeg command for one variation. `sources` maps each slot to the stored file
// and its upright size. Crop happens in source pixels before scaling to keep 1-vCPU renders cheap.
export function variationArgs({ spec, layout, sources, overlay, output }) {
  const { width: W, height: H } = CANVAS,
    D = spec.duration,
    cells = layout.zones.flatMap((z) => z.cells),
    primary = cells.find((c) => c.slotId === spec.primary),
    order = [primary, ...cells.filter((c) => c !== primary)],
    args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-protocol_whitelist",
      "file,pipe",
    ],
    graph = [],
    label = new Map();
  order.forEach((cell, i) => {
    const media = spec.cells[cell.slotId],
      file = sources[cell.slotId].path;
    if (cell.type === "video") {
      const length =
        cell === primary ? D : Math.min(D, media.end - media.start);
      args.push(
        "-ss",
        String(media.start),
        "-t",
        length.toFixed(3),
        "-i",
        file,
      );
    } else
      args.push("-loop", "1", "-framerate", "30", "-t", String(D), "-i", file);
    label.set(cell.slotId, i);
  });
  args.push("-loop", "1", "-framerate", "30", "-t", String(D), "-i", overlay);
  order.forEach((cell, i) => {
    const media = spec.cells[cell.slotId],
      src = sources[cell.slotId],
      p = placement(
        src.width,
        src.height,
        cell.width,
        cell.height,
        cell.fit,
        media.zoom,
        media.x,
        media.y,
      ),
      sx = Math.min(src.width - 2, Math.max(0, Math.floor(p.source.x))),
      sy = Math.min(src.height - 2, Math.max(0, Math.floor(p.source.y))),
      sw = Math.max(2, Math.min(src.width - sx, Math.round(p.source.width))),
      sh = Math.max(2, Math.min(src.height - sy, Math.round(p.source.height))),
      vx = Math.min(cell.width - 2, evenFloor(p.visible.x)),
      vy = Math.min(cell.height - 2, evenFloor(p.visible.y)),
      vw = Math.max(2, Math.min(cell.width - vx, even(p.visible.width))),
      vh = Math.max(2, Math.min(cell.height - vy, even(p.visible.height)));
    let input = `[${i}:v:0]setpts=PTS-STARTPTS,fps=30`;
    if (cell.type === "video")
      input += `,tpad=stop_mode=clone:stop_duration=${D}`;
    if (cell === primary && spec.background === "blur") {
      const bw = W / BLUR.divisor,
        bh = H / BLUR.divisor;
      graph.push(
        `${input},split=2[src${i}][blur]`,
        `[blur]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=${BLUR.radius}:${BLUR.power},scale=${W}:${H},setsar=1,format=yuv420p[base0]`,
      );
      input = `[src${i}]`;
    } else {
      graph.push(`${input}[src${i}]`);
      input = `[src${i}]`;
    }
    let chain = `${input}crop=${sw}:${sh}:${sx}:${sy},scale=${vw}:${vh},setsar=1,format=yuva420p`;
    if (vw !== cell.width || vh !== cell.height)
      chain += `,pad=${cell.width}:${cell.height}:${vx}:${vy}:color=black@0`;
    graph.push(`${chain}[cell${i}]`);
  });
  if (spec.background !== "blur")
    graph.push(`color=c=black:s=${W}x${H}:r=30:d=${D},format=yuv420p[base0]`);
  const zoneLabels = layout.zones.map((zone, z) => {
    const parts = zone.cells.map((c) => `[cell${label.get(c.slotId)}]`);
    if (parts.length === 1) return parts[0];
    graph.push(`${parts.join("")}hstack=inputs=${parts.length}[zone${z}]`);
    return `[zone${z}]`;
  });
  const groups = [];
  layout.zones.forEach((zone, z) => {
    const last = groups.at(-1);
    if (last && last.end === zone.y) {
      last.labels.push(zoneLabels[z]);
      last.end = zone.y + zone.height;
    } else
      groups.push({
        y: zone.y,
        end: zone.y + zone.height,
        labels: [zoneLabels[z]],
      });
  });
  let base = "[base0]";
  groups.forEach((group, g) => {
    let source = group.labels[0];
    if (group.labels.length > 1) {
      graph.push(
        `${group.labels.join("")}vstack=inputs=${group.labels.length}[group${g}]`,
      );
      source = `[group${g}]`;
    }
    graph.push(`${base}${source}overlay=0:${group.y}[base${g + 1}]`);
    base = `[base${g + 1}]`;
  });
  graph.push(
    `[${order.length}:v:0]format=rgba[bands]`,
    `${base}[bands]overlay=0:0,format=yuv420p[v]`,
  );
  args.push("-filter_complex", graph.join(";"), "-map", "[v]");
  if (!spec.mute)
    args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-af", "apad");
  else args.push("-an");
  args.push(
    "-t",
    String(D),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-maxrate",
    "4M",
    "-bufsize",
    "8M",
    "-threads",
    "2",
    "-filter_complex_threads",
    "1",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    output,
  );
  return args;
}
