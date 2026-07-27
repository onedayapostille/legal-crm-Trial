export interface LeadPipelineClient {
  clientStatus?: string | null;
  sourceLeadId?: number | null;
}

/** Load details for a pipeline Lead or a possible converted Lead. */
export function shouldLoadLeadPipelineDetails(client: LeadPipelineClient | null | undefined) {
  return client?.clientStatus === "Leads" || client?.clientStatus === "Existing Client";
}

/**
 * Pipeline details are editable while a record is still a Lead. After
 * conversion, the section appears only when retained/source Lead data exists.
 * A directly-created Existing Client therefore never shows an empty card.
 */
export function shouldShowLeadPipelineDetails(
  client: LeadPipelineClient | null | undefined,
  hasLeadDetail: boolean,
) {
  return client?.clientStatus === "Leads"
    || (client?.clientStatus === "Existing Client" && hasLeadDetail);
}

export function canEditLeadPipelineDetails(client: LeadPipelineClient | null | undefined) {
  return client?.clientStatus === "Leads";
}
