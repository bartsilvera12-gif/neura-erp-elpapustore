import Link from "next/link";
import { Suspense } from "react";
import SorteosCuponesManualClient from "@/components/sorteos/SorteosCuponesManualClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function SorteoCuponManualPage() {
  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-xs text-slate-500">
        <Link href="/sorteos" className="font-medium text-slate-500 transition-colors hover:text-[#4FAEB2]">
          Sorteos
        </Link>
        <span aria-hidden className="text-slate-300">/</span>
        <span className="font-semibold text-slate-700">Cupón manual</span>
      </nav>

      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
          />
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
            Sorteos · Cupón manual
          </p>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Cupón manual</h1>
        <p className="mt-1 text-sm text-slate-500">
          Registrá una venta presencial (efectivo). Los cupones siguen la numeración existente, sin
          conflicto con los ya generados.
        </p>
      </div>

      <Suspense fallback={null}>
        <SorteosCuponesManualClient />
      </Suspense>
    </div>
  );
}
