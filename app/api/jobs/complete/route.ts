import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  optionalString,
  optionalStringArray,
  readJsonObject,
  requiredString,
  requireUser,
} from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireUser(request);
    const body = await readJsonObject(request);

    const { data, error } = await supabase.rpc("submit_job_completion", {
      p_job_id: requiredString(body, "jobId"),
      p_notes: optionalString(body, "notes"),
      p_photo_urls: optionalStringArray(body, "photoUrls"),
    });

    assertNoDbError(error);

    return json({ completion: data?.[0] ?? null }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
