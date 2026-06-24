import type { ApiOptions, Membership, SessionProfile } from "./confidel-api";
import { createSupabaseBrowserClient } from "./supabase/client";

export function hasOwnerAccess(profile: SessionProfile | null) {
  return Boolean(
    profile?.memberships.some(
      (membership) =>
        membership.is_active &&
        (membership.role === "owner" || membership.role === "admin"),
    ),
  );
}

export function hasEmployeeAccess(profile: SessionProfile | null) {
  return Boolean(
    profile?.memberships.some(
      (membership) => membership.is_active && membership.role === "employee",
    ),
  );
}

export function firstCompanyForRole(profile: SessionProfile, roles: string[]) {
  const membership = profile.memberships.find(
    (item) => item.is_active && roles.includes(String(item.role)),
  );

  return membership?.company_id ?? null;
}

export function companyName(profile: SessionProfile | null, companyId: string | null) {
  return profile?.companies.find((company) => company.id === companyId)?.name ?? "Confidel";
}

export function displayName(profile: SessionProfile | null) {
  const membership = profile?.memberships.find((item) => item.full_name);
  return membership?.full_name ?? profile?.user.email ?? "Confidel user";
}

export function roleLabel(membership: Membership | undefined) {
  return membership?.role ? String(membership.role).toUpperCase() : "TEAM";
}

export async function getApiOptions(): Promise<ApiOptions | null> {
  const supabase = createSupabaseBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    return null;
  }

  return { token: session.access_token };
}

export async function signOut() {
  const supabase = createSupabaseBrowserClient();
  await supabase.auth.signOut();
}
