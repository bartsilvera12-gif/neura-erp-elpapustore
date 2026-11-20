"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Alerta = {
  activo?: boolean;
  mensajes?: number;
  truncado?: boolean;
  primero?: string | null;
  ultimo?: string | null;
  ventana_horas?: number;
};

/** Cada 5 minutos alcanza: un bloqueo por pago dura horas o días, no segundos. */
const REFRESH_MS = 5 * 60 * 1000;

function horaCorta(iso: string | null | undefined): string {
  const s = (iso ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-PY", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Cartel de "WhatsApp no está enviando por un problema de pago en Meta".
 *
 * Vive en el ERP a propósito: si Meta cortó la cuenta por facturación, avisar por WhatsApp no
 * serviría — ese canal está caído justo cuando hace falta el aviso.
 *
 * No se puede cerrar: mientras el problema siga, el cartel sigue. Desaparece solo cuando dejan
 * de llegar mensajes fallidos con ese código, o sea cuando el pago se regulariza.
 */
export default function MetaBillingBanner() {
  const [alerta, setAlerta] = useState<Alerta | null>(null);

  const consultar = useCallback(async () => {
    try {
      const res = await fetchWithSupabaseSession("/api/chat/meta-billing-alert", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { success?: boolean; data?: Alerta };
      if (json.success && json.data) setAlerta(json.data);
    } catch {
      /* Sin red: el cartel simplemente no aparece. Nunca rompe la pantalla. */
    }
  }, []);

  useEffect(() => {
    void consultar();
    const t = setInterval(() => void consultar(), REFRESH_MS);
    return () => clearInterval(t);
  }, [consultar]);

  if (!alerta?.activo) return null;

  const desde = horaCorta(alerta.primero);
  const cantidad = alerta.mensajes ?? 0;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rose-300 bg-rose-50 px-6 py-3 text-sm text-rose-900"
    >
      <span className="font-semibold">
        WhatsApp no está enviando mensajes: Meta reporta un problema de pago.
      </span>
      <span className="text-rose-800">
        {alerta.truncado ? "Más de " : ""}
        {cantidad} {cantidad === 1 ? "mensaje falló" : "mensajes fallaron"}
        {desde ? ` desde el ${desde}` : ""}. Los clientes no están recibiendo respuesta.
      </span>
      <a
        href="https://business.facebook.com/billing_hub/payment_settings"
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold underline underline-offset-2 hover:text-rose-950"
      >
        Revisar el pago en Meta
      </a>
    </div>
  );
}
