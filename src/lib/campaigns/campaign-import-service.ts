import "server-only";
import * as XLSX from "xlsx";
import { normalizeCampaignPhone } from "@/lib/campaigns/campaign-phone";

/** Re-export por compatibilidad: la fuente de verdad es `campaign-import-limits`. */
export {
  CAMPAIGN_IMPORT_MAX_ROWS,
  CAMPAIGN_IMPORT_MAX_BYTES,
  formatCampaignImportMaxRows,
  formatCampaignImportMaxSize,
} from "@/lib/campaigns/campaign-import-limits";

export type ParsedSheet = {
  headers: string[];
  rows: Array<Record<string, string>>;
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

function parseCsv(buffer: Buffer): ParsedSheet {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQ = !inQ;
      } else if ((ch === "," || ch === ";") && !inQ) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out.map((c) => c.replace(/^"|"$/g, "").trim());
  };

  const headersRaw = splitLine(lines[0]).map((h) => h.trim()).filter(Boolean);
  const headers = headersRaw.map((h, idx) => (h ? h : `col_${idx + 1}`));
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = cells[j] ?? "";
    });
    rows.push(row);
  }

  return { headers, rows };
}

export function parseCampaignSpreadsheet(buffer: Buffer, filename: string): ParsedSheet {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv")) {
    return parseCsv(buffer);
  }

  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return { headers: [], rows: [] };
  }
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false }) as string[][];
  if (!aoa.length) return { headers: [], rows: [] };

  const headersRaw = (aoa[0] ?? []).map((c) => String(c ?? "").trim());
  const headers = headersRaw.map((h, idx) => (h ? h : `col_${idx + 1}`));

  const rows: Array<Record<string, string>> = [];
  for (let r = 1; r < aoa.length; r++) {
    const line = aoa[r] ?? [];
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = line[j] != null ? String(line[j]).trim() : "";
    });
    // Excel arrastra filas totalmente vacías en el "rango usado" del sheet.
    // Las descartamos acá para no inflar el conteo de inválidos.
    if (Object.values(row).some((v) => String(v ?? "").trim() !== "")) {
      rows.push(row);
    }
  }

  return { headers, rows };
}

/** Detecta columna teléfono por nombre común o primera columna. */
export function pickPhoneColumn(headers: string[], hint?: string): string | null {
  const normalizedHints = [
    "telefono",
    "teléfono",
    "phone",
    "celular",
    "whatsapp",
    "movil",
    "móvil",
    "numero",
    "número",
  ];
  const hl = hint?.trim();
  if (hl && headers.includes(hl)) return hl;

  for (const h of headers) {
    const n = normalizeHeader(h);
    if (normalizedHints.some((x) => n.includes(x) || n === x.replace(/ó/g, "o"))) {
      return h;
    }
  }
  return headers[0] ?? null;
}
