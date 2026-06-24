import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  firstRpcRow,
  handleRouteError,
  json,
  readJsonObject,
  requiredString,
  requireUser,
  selectFields,
} from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireUser(request);
    const body = await readJsonObject(request);

    const { data, error } = await supabase.rpc("assign_job", {
      p_job_id: requiredString(body, "jobId"),
      p_employee_user_id: requiredString(body, "employeeUserId"),
    });

    assertNoDbError(error);

    return json(
      {
        assignment: selectFields(firstRpcRow(data), [
          "id",
          "company_id",
          "job_id",
          "employee_user_id",
          "status",
          "assigned_at",
        ]),
      },
      201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
