import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { errorResponse } from "@/lib/api/response";
import { requireCampanasApiAccess } from "@/lib/campaigns/campaign-auth";
import {
  AUDIENCE_LABEL,
  parseAudienceFilters,
  runAudience,
  validateAudienceFilters,
} from "@/lib/campaigns/audiences";

export const maxDuration = 60;

/** Devuelve la audiencia completa como Excel con las columnas de importación de campañas. */
export async function POST(request: NextRequest) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) return NextResponse.json(errorResponse(auth.message), { status: auth.status });

  const filters = parseAudienceFilters((await request.json().catch(() => ({}))) as Record<string, unknown>);
  const invalid = validateAudienceFilters(filters);
  if (invalid) return NextResponse.json(errorResponse(invalid), { status: 400 });

  try {
    const { rows } = await runAudience(auth.empresaId, filters, 15000);
    const label = filters.kinds.map((k) => AUDIENCE_LABEL[k]).join(" + ");
    const sheetRows = rows.map((r) => ({
      nombre: r.nombre,
      telefono: r.telefono,
      Variable_1: "",
      Variable_2: "",
      variable_3: "",
      header_image_url: "",
      observacion_interna: label,
      observacion_interna2: [r.detalle, r.ultimo ? `Último: ${r.ultimo}` : ""].filter(Boolean).join(" · "),
    }));
    const ws = XLSX.utils.json_to_sheet(sheetRows, {
      header: [
        "nombre",
        "telefono",
        "Variable_1",
        "Variable_2",
        "variable_3",
        "header_image_url",
        "observacion_interna",
        "observacion_interna2",
      ],
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "destinatarios");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="audiencia_${filters.kinds.join("+")}.xlsx"`,
        "X-Audience-Count": String(rows.length),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
