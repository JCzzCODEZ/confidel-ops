import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  firstRpcRow,
  handleRouteError,
  HttpError,
  json,
  optionalString,
  readJsonObject,
  requiredString,
  requireUser,
  selectFields,
} from "../../../_shared";

export const dynamic = "force-dynamic";

type ReviewContext = {
  params: Promise<{ jobId: string }>;
};

export async function POST(request: NextRequest, context: ReviewContext) {
  try {
    const { jobId } = await context.params;
    const { supabase } = await requireUser(request);
    const body = await readJsonObject(request);
    const completionId = requiredString(body, "completionId");
    const decision = requiredString(body, "decision");

    if (decision !== "approve" && decision !== "reject") {
      throw new HttpError(400, "decision must be approve or reject");
    }

    const { data: completion, error: lookupError } = await supabase
      .from("job_completions")
      .select("id, job_id")
      .eq("id", completionId)
      .single();

    if (lookupError || !completion) {
      throw new HttpError(404, "Completion not found");
    }

    if (completion.job_id !== jobId) {
      throw new HttpError(400, "completionId does not belong to this job");
    }

    const rpcName =
      decision === "approve" ? "approve_job_completion" : "reject_job_completion";

    const { data, error } = await supabase.rpc(rpcName, {
      p_completion_id: completionId,
      p_review_notes: optionalString(body, "reviewNotes"),
    });

    assertNoDbError(error);

    return json({
      completion: selectFields(firstRpcRow(data), [
        "id",
        "company_id",
        "job_id",
        "employee_user_id",
        "status",
        "reviewed_by",
        "reviewed_at",
        "review_notes",
      ]),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
