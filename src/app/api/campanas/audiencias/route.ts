import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireCampanasApiAccess } from "@/lib/campaigns/campaign-auth";
import {
  listAudienceOptions,
  parseAudienceFilters,
  runAudience,
  validateAudienceFilters,
} from "@/lib/campaigns/audiences";

export const maxDuration = 60;

/** Sorteos y campañas para los selectores de la pantalla de audiencias. */
export async function GET(request: NextRequest) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) return NextResponse.json(errorResponse(auth.message), { status: auth.status });
  try {
    return NextResponse.json(successResponse(await listAudienceOptions(auth.empresaId)));
  } catch (e) {
    return NextResponse.json(errorResponse(e instanceof Error ? e.message : "Error"), { status: 500 });
  }
}

/** Calcula la audiencia: total y las primeras 50 filas para previsualizar. */
export async function POST(request: NextRequest) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) return NextResponse.json(errorResponse(auth.message), { status: auth.status });

  const filters = parseAudienceFilters((await request.json().catch(() => ({}))) as Record<string, unknown>);
  const invalid = validateAudienceFilters(filters);
  if (invalid) return NextResponse.json(errorResponse(invalid), { status: 400 });

  try {
    const res = await runAudience(auth.empresaId, filters, 50);
    return NextResponse.json(successResponse(res));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    const timeout = /statement timeout|canceling statement/i.test(msg);
    return NextResponse.json(
      errorResponse(timeout ? "La consulta tardó demasiado. Probá con un período más corto." : msg),
      { status: timeout ? 504 : 500 }
    );
  }
}
