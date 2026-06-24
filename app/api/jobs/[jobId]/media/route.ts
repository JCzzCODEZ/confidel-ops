import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  readJsonObject,
  requiredString,
  requireUser,
  selectRows,
} from "../../../_shared";

export const dynamic = "force-dynamic";

type MediaContext = {
  params: Promise<{ jobId: string }>;
};

// Safe metadata only — never expose storage_bucket / storage_path (internal) or
// any public URL. Bytes are served exclusively via the signed-url sub-route.
const SAFE_MEDIA_FIELDS = [
  "id",
  "company_id",
  "job_id",
  "completion_id",
  "uploaded_by",
  "media_type",
  "mime_type",
  "size_bytes",
  "created_at",
];

// GET — list media metadata for a job. RLS (job_media_meta_read) restricts rows
// to owner/admin of the company or the assigned employee.
export async function GET(request: NextRequest, context: MediaContext) {
  try {
    const { jobId } = await context.params;
    const { supabase } = await requireUser(request);

    const { data, error } = await supabase
      .from("job_completion_media")
      .select(SAFE_MEDIA_FIELDS.join(", "))
      .eq("job_id", jobId)
      .order("created_at", { ascending: true });

    assertNoDbError(error);

    return json({ media: selectRows(data, SAFE_MEDIA_FIELDS) });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST — record metadata for an object already uploaded to the private bucket.
// Authorization (assigned employee or owner/admin) is enforced inside the
// record_job_media() SECURITY DEFINER RPC.
export async function POST(request: NextRequest, context: MediaContext) {
  try {
    const { jobId } = await context.params;
    const { supabase } = await requireUser(request);
    const body = await readJsonObject(request);

    const { data, error } = await supabase.rpc("record_job_media", {
      p_job_id: jobId,
      p_completion_id: requiredString(body, "completionId"),
      p_media_type: requiredString(body, "mediaType"),
      p_storage_path: requiredString(body, "storagePath"),
      p_mime_type: typeof body.mimeType === "string" ? body.mimeType : null,
      p_size_bytes: typeof body.sizeBytes === "number" ? body.sizeBytes : null,
    });

    assertNoDbError(error);

    return json({ mediaId: data ?? null }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
