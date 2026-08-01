import "server-only";

import { createHash } from "node:crypto";
import {
  mergeCustomTemplateFields,
  type SorteoTicketImageConfig,
} from "@/lib/sorteos/sorteo-ticket-types";
import { svgTextAsPath } from "@/lib/sorteos/sorteo-ticket-text-path";

export type SorteoTicketRenderInput = {
  empresaNombre: string;
  sorteoNombre: string;
  clienteNombre?: string;
  documento?: string;
  telefono?: string;
  ciudad?: string;
  numeroOrden: string;
  cupones: string[];
  /** ISO o texto localizable */
  fechaHora: string;
  config: SorteoTicketImageConfig;
  /** bytes PNG/JPEG/WebP o null */
  logoBytes: Buffer | null;
  logoMime: string | null;
  backgroundBytes: Buffer | null;
  backgroundMime: string | null;
  /** Plantilla completa (custom_template) */
  templateBytes?: Buffer | null;
  templateMime?: string | null;
};

/** Canvas modo automático — comprobante vertical premium */
const WA = 1080;
const HA = 1350;
const PAD = 48;
const CARD_RX = 28;

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return "?";
  if (p.length === 1) return p[0]!.slice(0, 2).toUpperCase();
  return (p[0]![0]! + p[p.length - 1]![0]!).toUpperCase();
}

function dataUrlFromBuffer(buf: Buffer, mime: string): string {
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

/** Cupón(es): tipografía grande, centrado en bloque (paths: librsvg ignora &lt;text&gt;+fuentes) */
function cuponesAutoSvg(
  cupones: string[],
  yStart: number,
  primary: string,
  accent: string
): string {
  const cx = WA / 2;
  if (cupones.length === 0) {
    return svgTextAsPath({
      text: "—",
      x: cx,
      y: yStart,
      fontSize: 36,
      weight: 600,
      fill: accent,
      textAnchor: "middle",
    });
  }
  if (cupones.length === 1) {
    return svgTextAsPath({
      text: cupones[0]!,
      x: cx,
      y: yStart + 80,
      fontSize: 72,
      weight: 800,
      fill: primary,
      textAnchor: "middle",
    });
  }
  const lines: string[] = [];
  let y = yStart;
  const fs = cupones.length <= 4 ? 56 : cupones.length <= 9 ? 40 : 32;
  const step = fs + 14;
  for (const c of cupones.slice(0, 24)) {
    lines.push(
      svgTextAsPath({
        text: c,
        x: cx,
        y,
        fontSize: fs,
        weight: 700,
        fill: primary,
        textAnchor: "middle",
      })
    );
    y += step;
  }
  if (cupones.length > 24) {
    lines.push(
      svgTextAsPath({
        text: `+${cupones.length - 24} más`,
        x: cx,
        y: y + 20,
        fontSize: 22,
        weight: 600,
        fill: accent,
        textAnchor: "middle",
      })
    );
  }
  return lines.filter(Boolean).join("\n");
}

/**
 * Modo automático: layout vertical 1080×1350, logo destacado, datos en “cards”, cupón protagonista.
 */
export function buildSorteoTicketSvg(input: SorteoTicketRenderInput): string {
  const cfg = input.config;
  const bg = (cfg.backgroundColor ?? "#f1f5f9").trim();
  const primary = (cfg.primaryColor ?? "#0f172a").trim();
  const secondary = (cfg.secondaryColor ?? "#64748b").trim();
  const accent = (cfg.primaryColor ?? "#4f46e5").trim();
  const title = (cfg.title ?? "Comprobante de participación").trim();
  const footer = (cfg.legalFooter ?? "").trim();

  const showLogo = cfg.showLogo !== false;
  const showNombre = cfg.showClienteNombre !== false;
  const showDoc = cfg.showDocumento !== false;
  const showTel = cfg.showTelefono !== false;
  const showCiu = cfg.showCiudad !== false;
  const showOrd = cfg.showNumeroOrden !== false;
  const showCup = cfg.showCupones !== false;
  const showSorteoNom = cfg.showSorteoNombre !== false;

  let headerLogo = "";
  if (showLogo) {
    if (input.logoBytes && input.logoMime) {
      const href = dataUrlFromBuffer(input.logoBytes, input.logoMime);
      /** Logo ancho arriba */
      headerLogo = `<image href="${href}" x="${(WA - 200) / 2}" y="${PAD}" width="200" height="200" preserveAspectRatio="xMidYMid meet"/>`;
    } else {
      const ini = initials(input.clienteNombre || input.empresaNombre);
      headerLogo = `<rect x="${(WA - 200) / 2}" y="${PAD}" width="200" height="200" rx="24" fill="#e2e8f0"/>
        ${svgTextAsPath({
          text: ini,
          x: WA / 2,
          y: PAD + 120,
          fontSize: 64,
          weight: 800,
          fill: "#475569",
          textAnchor: "middle",
        })}`;
    }
  }

  let bgPattern = "";
  if (input.backgroundBytes && input.backgroundMime) {
    const href = dataUrlFromBuffer(input.backgroundBytes, input.backgroundMime);
    bgPattern = `<image href="${href}" x="0" y="0" width="${WA}" height="${HA}" preserveAspectRatio="xMidYMid slice" opacity="0.12"/>`;
  }

  const yHeader = showLogo ? PAD + 220 : PAD + 20;
  const cardTop = yHeader + 28;
  const cardW = WA - PAD * 2;
  const cardX = PAD;

  const rows: { label: string; value: string }[] = [];
  if (showNombre && input.clienteNombre?.trim()) {
    rows.push({ label: "Participante", value: input.clienteNombre.trim() });
  }
  if (showDoc && input.documento?.trim()) {
    rows.push({ label: "Documento", value: input.documento.trim() });
  }
  if (showTel && input.telefono?.trim()) {
    rows.push({ label: "Teléfono", value: input.telefono.trim() });
  }
  if (showCiu && input.ciudad?.trim()) {
    rows.push({ label: "Ciudad", value: input.ciudad.trim() });
  }
  if (showOrd && String(input.numeroOrden ?? "").trim()) {
    rows.push({ label: "Nº de orden", value: String(input.numeroOrden).trim() });
  }
  if (showSorteoNom && input.sorteoNombre?.trim()) {
    rows.push({ label: "Sorteo", value: input.sorteoNombre.trim() });
  }

  let rowY = cardTop + 56;
  const rowSvg = rows
    .map((r) => {
      const labelPath = svgTextAsPath({
        text: r.label,
        x: cardX + 36,
        y: rowY,
        fontSize: 22,
        weight: 600,
        fill: secondary,
        textAnchor: "start",
      });
      const valuePath = svgTextAsPath({
        text: r.value,
        x: cardX + 36,
        y: rowY + 28,
        fontSize: 30,
        weight: 700,
        fill: primary,
        textAnchor: "start",
      });
      const block = `${labelPath}\n${valuePath}`;
      rowY += 78;
      return block;
    })
    .join("\n");

  const cardH = Math.max(120 + rows.length * 78, 200);
  const cupY = cardTop + cardH + 80;
  const cupones = showCup ? input.cupones.filter((c) => String(c).trim()) : [];
  const cupSvg =
    cupones.length > 0
      ? `${svgTextAsPath({
          text: "CUPONES",
          x: WA / 2,
          y: cupY,
          fontSize: 26,
          weight: 700,
          fill: accent,
          textAnchor: "middle",
        })}
  ${cuponesAutoSvg(cupones, cupY + 40, primary, secondary)}`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WA}" height="${HA}" viewBox="0 0 ${WA} ${HA}">
  <defs>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect width="${WA}" height="${HA}" fill="${bg}"/>
  ${bgPattern}
  ${headerLogo}
  ${svgTextAsPath({
    text: input.empresaNombre,
    x: WA / 2,
    y: yHeader,
    fontSize: 28,
    weight: 700,
    fill: secondary,
    textAnchor: "middle",
  })}
  ${svgTextAsPath({
    text: title,
    x: WA / 2,
    y: yHeader + 42,
    fontSize: 40,
    weight: 800,
    fill: primary,
    textAnchor: "middle",
  })}
  <rect x="${cardX}" y="${cardTop}" width="${cardW}" height="${cardH}" rx="${CARD_RX}" fill="#ffffff" filter="url(#cardShadow)"/>
  ${rowSvg}
  ${cupSvg}
  ${svgTextAsPath({
    text: input.fechaHora,
    x: WA / 2,
    y: HA - PAD - (footer ? 56 : 28),
    fontSize: 24,
    weight: 400,
    fill: secondary,
    textAnchor: "middle",
  })}
  ${
    footer
      ? svgTextAsPath({
          text: footer,
          x: WA / 2,
          y: HA - PAD - 12,
          fontSize: 20,
          weight: 400,
          fill: secondary,
          textAnchor: "middle",
        })
      : ""
  }
</svg>`;
}

function fillAttr(color: string): string {
  const t = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(t) || /^#[0-9A-Fa-f]{3}$/.test(t)) return t;
  return "#111827";
}

/**
 * Plantilla personalizada: datos del cliente bajo el logo y centrados como el cupón; tamaño del cupón sin tocar.
 * Colores desde mergeCustomTemplateFields. 1–6 cupones: centrados; más de 6: grilla.
 */
function buildCustomTemplateOverlaySvg(
  w: number,
  h: number,
  input: SorteoTicketRenderInput,
  layout: ReturnType<typeof mergeCustomTemplateFields>
): string {
  const padX = Math.max(40, Math.min(layout.cliente_nombre?.x ?? 72, w * 0.2));
  const bottomPad = Math.max(36, Math.round(h * 0.028));
  /**
   * Inicio del bloque de datos (coord. Y antes del primer baseline).
   * El logo va **dentro del PNG**: sin segmentación no hay bbox; un ratio bajo
   * solapa el texto con el arte. ~39% del alto suele quedar debajo de logos grandes tipo story.
   */
  const metaTop = Math.round(h * 0.39);

  const colName = fillAttr(layout.cliente_nombre.color);
  const colDoc = fillAttr(layout.cliente_documento.color);
  const colTel = fillAttr(layout.telefono.color);
  const colCiu = fillAttr(layout.ciudad.color);
  const colOrd = fillAttr(layout.numero_orden.color);
  const colSort = fillAttr(layout.sorteo_nombre.color);
  const colCup = fillAttr(layout.cupones.color);

  const cupones = input.cupones ?? [];
  const metaGap = 14;
  const blockGap = 22;

  type MetaRow = { text: string; fs: number; color: string; weight: number };
  const buildMetaRows = (metaScale: number): MetaRow[] => {
    const r = (n: number) => Math.max(16, Math.round(n * metaScale));
    const rows: MetaRow[] = [];
    const cn = input.clienteNombre?.trim();
    if (cn) {
      rows.push({
        text: cn,
        fs: r(Math.max(layout.cliente_nombre.fontSize, 34)),
        color: colName,
        weight: 700,
      });
    }
    const doc = input.documento?.trim();
    if (doc) {
      rows.push({
        text: `Documento: ${doc}`,
        fs: r(Math.max(layout.cliente_documento.fontSize, 28)),
        color: colDoc,
        weight: 600,
      });
    }
    const tel = input.telefono?.trim();
    if (tel) {
      rows.push({
        text: `Teléfono: ${tel}`,
        fs: r(Math.max(layout.telefono.fontSize, 28)),
        color: colTel,
        weight: 600,
      });
    }
    const ciu = input.ciudad?.trim();
    if (ciu) {
      rows.push({
        text: `Ciudad: ${ciu}`,
        fs: r(Math.max(layout.ciudad.fontSize, 28)),
        color: colCiu,
        weight: 600,
      });
    }
    const ord = String(input.numeroOrden ?? "").trim();
    if (ord) {
      rows.push({
        text: `Nº orden: ${ord}`,
        fs: r(Math.max(layout.numero_orden.fontSize, 34)),
        color: colOrd,
        weight: 700,
      });
    }
    const sn = input.sorteoNombre?.trim();
    if (sn) {
      rows.push({
        text: `Sorteo: ${sn}`,
        fs: r(Math.max(layout.sorteo_nombre.fontSize, 28)),
        color: colSort,
        weight: 600,
      });
    }
    return rows;
  };

  /** Altura del layout de cupones (el tamaño del número **no** usa metaScale). */
  const simulateLastCupBaseline = (yAfterMeta: number): number => {
    let y = yAfterMeta;
    if (cupones.length === 0) return y;
    if (cupones.length <= 6) {
      const fs = Math.min(
        84,
        Math.max(52, Math.round(layout.cupones.fontSize + (6 - Math.min(cupones.length, 6)) * 3))
      );
      const step = Math.round(fs * 1.2);
      for (let i = 0; i < cupones.length; i++) {
        y += step;
      }
      return y;
    }
    const cols = 3;
    const fs = 22;
    const rowH = 34;
    const maxShow = 24;
    const list = cupones.slice(0, maxShow);
    const gy = y + fs + 4;
    let maxY = gy;
    for (let i = 0; i < list.length; i++) {
      const row = Math.floor(i / cols);
      const yCell = gy + row * rowH;
      if (yCell > maxY) maxY = yCell;
    }
    if (cupones.length > maxShow) {
      maxY += Math.ceil(list.length / cols) * rowH + 8;
      maxY += 22;
    }
    return maxY;
  };

  let metaScale = 1.06;
  let metaRows = buildMetaRows(metaScale);
  for (let iter = 0; iter < 22; iter++) {
    metaRows = buildMetaRows(metaScale);
    let ySim = metaTop;
    for (const row of metaRows) {
      ySim += row.fs + metaGap;
    }
    ySim += blockGap - metaGap;
    const lastY = simulateLastCupBaseline(ySim);
    if (lastY <= h - bottomPad || metaScale <= 0.56) {
      break;
    }
    metaScale *= 0.93;
  }

  const cx = w / 2;
  const pieces: string[] = [];
  let y = metaTop;
  for (const row of metaRows) {
    y += row.fs;
    pieces.push(
      svgTextAsPath({
        text: row.text,
        x: cx,
        y,
        fontSize: row.fs,
        weight: row.weight,
        fill: fillAttr(row.color),
        textAnchor: "middle",
      })
    );
    y += metaGap;
  }
  y += blockGap - metaGap;

  if (cupones.length === 0) {
    /* Sin cupones resueltos: no dibujar placeholder */
  } else if (cupones.length <= 6) {
    const fs = Math.min(
      84,
      Math.max(52, Math.round(layout.cupones.fontSize + (6 - Math.min(cupones.length, 6)) * 3))
    );
    const step = Math.round(fs * 1.2);
    for (let i = 0; i < cupones.length; i++) {
      y += step;
      pieces.push(
        svgTextAsPath({
          text: cupones[i]!,
          x: cx,
          y,
          fontSize: fs,
          weight: 800,
          fill: colCup,
          textAnchor: "middle",
        })
      );
    }
  } else {
    const cols = 3;
    const cellW = (w - 2 * padX) / cols;
    const fs = 22;
    const rowH = 34;
    const maxShow = 24;
    const list = cupones.slice(0, maxShow);
    let gy = y + fs + 4;
    for (let i = 0; i < list.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const xCell = padX + col * cellW + cellW / 2;
      const yCell = gy + row * rowH;
      pieces.push(
        svgTextAsPath({
          text: list[i]!,
          x: xCell,
          y: yCell,
          fontSize: fs,
          weight: 700,
          fill: colCup,
          textAnchor: "middle",
        })
      );
    }
    if (cupones.length > maxShow) {
      gy += Math.ceil(list.length / cols) * rowH + 8;
      pieces.push(
        svgTextAsPath({
          text: `+${cupones.length - maxShow} más`,
          x: cx,
          y: gy,
          fontSize: 18,
          weight: 600,
          fill: colCup,
          textAnchor: "middle",
        })
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${pieces.filter(Boolean).join("\n")}
</svg>`;
}

async function renderCustomTemplateTicketPng(input: SorteoTicketRenderInput): Promise<Buffer> {
  const buf = input.templateBytes!;
  const sharpMod = (await import("sharp")).default;
  const meta = await sharpMod(buf).metadata();
  const w = meta.width && meta.width > 0 ? meta.width : input.config.custom_template_width ?? 1080;
  const h = meta.height && meta.height > 0 ? meta.height : input.config.custom_template_height ?? 1350;

  const fields = mergeCustomTemplateFields(input.config);
  const overlaySvg = buildCustomTemplateOverlaySvg(w, h, input, fields);
  const overlayPng = await sharpMod(Buffer.from(overlaySvg, "utf8")).png().toBuffer();

  const baseRgb = await sharpMod(buf)
    .resize(w, h, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();

  return sharpMod(baseRgb)
    .composite([{ input: overlayPng, left: 0, top: 0, blend: "over" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function renderSorteoTicketPng(svg: string): Promise<{ png: Buffer; hash: string }> {
  const sharpMod = (await import("sharp")).default;
  const png = await sharpMod(Buffer.from(svg, "utf8")).png({ compressionLevel: 9 }).toBuffer();
  const hash = createHash("sha256").update(png).digest("hex");
  return { png, hash };
}

/**
 * Punto único: plantilla personalizada (imagen + texto) o automático (SVG premium).
 */
export async function renderTicketPngUnified(input: SorteoTicketRenderInput): Promise<{ png: Buffer; hash: string }> {
  const hasTemplate =
    input.templateBytes && input.templateBytes.length > 0 && input.templateMime;
  if (hasTemplate) {
    try {
      const png = await renderCustomTemplateTicketPng(input);
      const hash = createHash("sha256").update(png).digest("hex");
      return { png, hash };
    } catch (e) {
      console.warn("[sorteo-ticket-render] custom_template_failed_fallback_auto", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const svg = buildSorteoTicketSvg(input);
  return renderSorteoTicketPng(svg);
}
