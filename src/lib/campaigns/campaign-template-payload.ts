/**
 * Construye payload `template` para Meta Cloud API / YCloud a partir del snapshot de plantilla
 * y variables por slot ({{1}}, {{2}}, {{nombre}}, …).
 */
import "server-only";

export {
  buildCampaignTemplatePreviewText,
  extractBodyPlaceholderKeysOrdered,
  extractBodyPlaceholderKeysOrderedFromText,
  extractBodyVariableSlotsOrdered,
  extractNamedPlaceholders,
  extractNumericSlots,
  extractTemplatePlaceholders,
  getBodyComponentText,
  PLACEHOLDER_RE,
} from "@/lib/campaigns/campaign-placeholders-shared";

import { extractBodyPlaceholderKeysOrdered } from "@/lib/campaigns/campaign-placeholders-shared";
import {
  isHttpsUrl,
  logTemplatePayloadHeaderImage,
  templateSnapshotHeaderMediaFormat,
} from "@/lib/campaigns/campaign-header-image";

export type CampaignTemplateVarsResolvedLog = {
  campaign_id: string;
  recipient_id: string;
  template_name: string;
  placeholders_count: number;
  params_count: number;
  missing_placeholders: string[];
};

/** Log seguro (sin tokens ni PII de contenido). */
export function logCampaignTemplateVarsResolved(evt: CampaignTemplateVarsResolvedLog): void {
  console.info("[campaign-template-vars][resolved]", {
    campaign_id: evt.campaign_id,
    recipient_id: evt.recipient_id,
    template_name: evt.template_name,
    placeholders_count: evt.placeholders_count,
    params_count: evt.params_count,
    missing_placeholders: evt.missing_placeholders,
  });
}

/** `mappedBySlot`: claves "1","2","nombre" → texto final para cada {{…}} */
export function buildMetaCloudTemplatePayload(params: {
  templateName: string;
  languageCode: string;
  componentsSnapshot: unknown[];
  mappedBySlot: Record<string, string>;
  /** URL https pública para HEADER IMAGE (misma para toda la campaña, fase 1). */
  headerImageUrl?: string | null;
}): Record<string, unknown> {
  const components: Array<Record<string, unknown>> = [];
  const headerFormat = templateSnapshotHeaderMediaFormat(params.componentsSnapshot);
  const headerUrl = String(params.headerImageUrl ?? "").trim();

  if (headerFormat && headerUrl && isHttpsUrl(headerUrl)) {
    try {
      logTemplatePayloadHeaderImage(new URL(headerUrl).hostname);
    } catch {
      logTemplatePayloadHeaderImage("(parse)");
    }
    const link = headerUrl.slice(0, 4000);
    // Cada formato de header usa una key distinta en el parámetro de Meta.
    const headerParam: Record<string, unknown> =
      headerFormat === "VIDEO"
        ? { type: "video", video: { link } }
        : headerFormat === "DOCUMENT"
          ? { type: "document", document: { link, filename: "documento" } }
          : { type: "image", image: { link } };
    components.push({
      type: "header",
      parameters: [headerParam],
    });
  }

  const slots = extractBodyPlaceholderKeysOrdered(params.componentsSnapshot);
  const bodyParameters = slots.map((slot) => ({
    type: "text",
    text: String(params.mappedBySlot[slot] ?? "").slice(0, 4096),
  }));

  if (bodyParameters.length > 0) {
    components.push({ type: "body", parameters: bodyParameters });
  }

  const template: Record<string, unknown> = {
    name: params.templateName,
    language: { code: params.languageCode },
  };

  if (components.length > 0) {
    template.components = components;
  }

  return template;
}
