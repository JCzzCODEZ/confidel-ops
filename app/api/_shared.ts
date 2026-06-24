import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { captureServerError } from "../../lib/monitoring";

export const noStoreHeaders = {
  "Cache-Control": "private, no-store",
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function createSupabaseRouteClient() {
  const cookieStore = await cookies();

  return createServerClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    },
  );
}

export async function requireUser(request?: NextRequest): Promise<{
  supabase: SupabaseClient;
  user: User;
}> {
  const bearerToken = getBearerToken(request);

  if (bearerToken) {
    const supabase = createClient(
      requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
        global: {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
          },
        },
      },
    );

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(bearerToken);

    if (error || !user) {
      throw new HttpError(401, "Authentication required");
    }

    return { supabase, user };
  }

  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new HttpError(401, "Authentication required");
  }

  return { supabase, user };
}

export async function requireCompanyAdmin(
  supabase: SupabaseClient,
  user: User,
  companyId: string,
) {
  const { data, error } = await supabase
    .from("company_memberships")
    .select("role")
    .eq("company_id", companyId)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .single();

  if (error || !data || !["owner", "admin"].includes(String(data.role))) {
    throw new HttpError(403, "Owner or admin access required");
  }
}

export async function readJsonObject(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Request body must be a JSON object");
    }

    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(400, "Request body must be valid JSON");
  }
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: noStoreHeaders });
}

export function handleRouteError(error: unknown) {
  if (error instanceof HttpError) {
    return json({ error: error.message, details: error.details ?? null }, error.status);
  }

  const maybeDbError = error as { code?: string; message?: string; details?: unknown };
  const code = maybeDbError.code;
  const message = maybeDbError.message || "Unexpected server error";

  if (code === "42501") {
    return json({ error: message, code }, 403);
  }

  if (code && ["22023", "23503", "23505", "23514"].includes(code)) {
    return json({ error: message, code, details: maybeDbError.details ?? null }, 400);
  }

  // Unexpected (5xx) errors only — report to monitoring if configured (no-op
  // otherwise). Fire-and-forget; the response is unchanged.
  void captureServerError(error);
  return json({ error: message, code: code ?? null }, 500);
}

export function requiredString(body: Record<string, unknown>, key: string) {
  const value = body[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${key} is required`);
  }

  return value.trim();
}

export function optionalString(body: Record<string, unknown>, key: string) {
  const value = body[key];

  if (value == null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, `${key} must be a string`);
  }

  return value.trim();
}

export function requiredInteger(body: Record<string, unknown>, key: string) {
  const value = body[key];

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, `${key} must be an integer`);
  }

  return value;
}

export function optionalInteger(body: Record<string, unknown>, key: string) {
  const value = body[key];

  if (value == null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, `${key} must be an integer`);
  }

  return value;
}

export function optionalDateString(body: Record<string, unknown>, key: string) {
  const value = optionalString(body, key);

  if (!value) {
    return null;
  }

  if (Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${key} must be a valid date`);
  }

  return value;
}

export function optionalStringArray(body: Record<string, unknown>, key: string) {
  const value = body[key];

  if (value == null) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, `${key} must be an array of strings`);
  }

  return value;
}

export function firstRpcRow<T>(data: T | T[] | null) {
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

export function selectFields(row: unknown, fields: string[]) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }

  return Object.fromEntries(
    fields
      .filter((field) => field in row)
      .map((field) => [field, (row as Record<string, unknown>)[field]]),
  );
}

export function selectRows(data: unknown, fields: string[]) {
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((row) => selectFields(row, fields));
}

export function assertNoDbError(error: unknown): asserts error is null {
  if (error) {
    throw error;
  }
}

function getBearerToken(request?: NextRequest) {
  const authorization = request?.headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

function requiredEnv(key: string) {
  const value = process.env[key];

  if (!value) {
    throw new HttpError(500, `${key} is not configured`);
  }

  return value;
}
