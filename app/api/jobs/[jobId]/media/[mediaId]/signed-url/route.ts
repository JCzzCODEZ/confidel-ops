import type { NextRequest } from "next/server";
import { handleRouteError, HttpError, json, requireUser } from "../../../../../_shared";

export const dynamic = "force-dynamic";

type SignedUrlContext = {
  params: Promise<{ jobId: string; mediaId: string }>;
};

const SIGNED_URL_TTL_SECONDS = 60;

// POST — issue a short-lived signed URL for one media object. The metadata row
// is read with the caller's token (RLS gates which rows are visible), and the
// signed URL is created with the caller's token too (storage RLS gates the
// object). Result is a private, expiring URL — never a public URL.
export async function POST(request: NextRequest, context: SignedUrlContext) {
  try {
    const { jobId, mediaId } = await context.params;
    const { supabase } = await requireUser(request);

    const { data: media, error: lookupError } = await supabase
      .from("job_completion_media")
      .select("id, job_id, storage_bucket, storage_path")
      .eq("id", mediaId)
      .single();

    if (lookupError || !media) {
      // RLS-hidden rows surface here as not-found, which is what we want.
      throw new HttpError(404, "Media not found");
    }

    if (media.job_id !== jobId) {
      throw new HttpError(400, "media does not belong to this job");
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(media.storage_bucket)
      .createSignedUrl(media.storage_path, SIGNED_URL_TTL_SECONDS);

    if (signError || !signed?.signedUrl) {
      throw new HttpError(403, signError?.message ?? "Unable to sign media URL");
    }

    return json({ url: signed.signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS });
  } catch (error) {
    return handleRouteError(error);
  }
}
