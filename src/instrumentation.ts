/**
 * Next.js instrumentation: corre una vez al arrancar el proceso del servidor.
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Arranca el pump de automatizaciones (cada minuto): cierre de sorteos por fecha.
 * Ver src/lib/chat/automation-pump.ts.
 */
export async function register(): Promise<void> {
  // Sólo en el runtime Node (no en edge) y una vez por proceso.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Default: sólo en producción y single_client (evita disparar envíos desde `next dev` local).
  const flag = process.env.AUTOMATION_PUMP_ENABLED?.trim().toLowerCase();
  const enabled =
    flag === "true" ||
    (flag !== "false" &&
      process.env.NODE_ENV === "production" &&
      process.env.NEURA_INSTANCE_MODE === "single_client");
  if (!enabled) {
    console.info("[instrumentation] automation-pump deshabilitado en este entorno");
    return;
  }

  const { startAutomationPump } = await import("@/lib/chat/automation-pump");
  startAutomationPump();
}
