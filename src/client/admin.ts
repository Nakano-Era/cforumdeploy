import { requestJson, type RegistrationMode } from "./api";

export interface AdminSettings {
  siteName?: string;
  siteDescription?: string;
  registrationMode?: RegistrationMode;
  registrationFrozen?: boolean;
  inviteRequiresApproval?: boolean;
  maintenanceMode?: boolean;
  lv0FirstTopicsReviewCount?: number;
  lv0FirstRepliesReviewCount?: number;
}

export async function getAdminSettings(
  signal?: AbortSignal,
): Promise<{ settings: AdminSettings }> {
  return requestJson<{ settings: AdminSettings }>("/api/admin/settings", {
    method: "GET",
    signal,
  });
}

export async function updateAdminSettings(
  input: AdminSettings,
  csrfToken: string,
): Promise<{ settings: AdminSettings }> {
  return requestJson<{ settings: AdminSettings }>("/api/admin/settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(input),
  });
}
