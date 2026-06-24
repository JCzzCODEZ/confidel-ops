import type { NextRequest } from "next/server";
import {
  assertNoDbError,
  handleRouteError,
  json,
  requireCompanyAdmin,
  requireUser,
} from "../_shared";

export const dynamic = "force-dynamic";

type CompletionRow = {
  id: string;
  company_id: string;
  job_id: string;
  employee_user_id: string;
  notes: string | null;
  status: string;
  submitted_at: string | null;
};

type JobRow = {
  id: string;
  client_id: string;
  title: string;
};

type ClientRow = {
  id: string;
  name: string;
};

type EmployeeRow = {
  user_id: string;
  full_name: string | null;
  email: string | null;
};

export async function GET(request: NextRequest) {
  try {
    const { supabase, user } = await requireUser(request);
    const companyId = request.nextUrl.searchParams.get("companyId");

    if (!companyId) {
      return json({ error: "companyId is required" }, 400);
    }

    await requireCompanyAdmin(supabase, user, companyId);

    const { data: completionData, error: completionError } = await supabase
      .from("job_completions")
      .select("id, company_id, job_id, employee_user_id, notes, status, submitted_at")
      .eq("company_id", companyId)
      .eq("status", "submitted")
      .order("submitted_at", { ascending: true });

    assertNoDbError(completionError);

    const completions = (completionData ?? []) as CompletionRow[];
    const jobIds = unique(completions.map((completion) => completion.job_id));
    const employeeIds = unique(completions.map((completion) => completion.employee_user_id));

    const jobs = await loadJobs(companyId, jobIds);
    const clients = await loadClients(companyId, unique(jobs.map((job) => job.client_id)));
    const employees = await loadEmployees(companyId, employeeIds);

    const jobById = new Map(jobs.map((job) => [job.id, job]));
    const clientById = new Map(clients.map((client) => [client.id, client]));
    const employeeById = new Map(employees.map((employee) => [employee.user_id, employee]));

    return json({
      completions: completions.map((completion) => {
        const job = jobById.get(completion.job_id);
        const client = job ? clientById.get(job.client_id) : null;
        const employee = employeeById.get(completion.employee_user_id);

        return {
          id: completion.id,
          company_id: completion.company_id,
          job_id: completion.job_id,
          job_title: job?.title ?? null,
          client_name: client?.name ?? null,
          employee_user_id: completion.employee_user_id,
          employee_name: employee?.full_name ?? employee?.email ?? null,
          employee_email: employee?.email ?? null,
          status: completion.status,
          submitted_at: completion.submitted_at,
          notes: completion.notes,
        };
      }),
    });

    async function loadJobs(nextCompanyId: string, nextJobIds: string[]) {
      if (!nextJobIds.length) {
        return [] as JobRow[];
      }

      const { data, error } = await supabase
        .from("jobs")
        .select("id, client_id, title")
        .eq("company_id", nextCompanyId)
        .in("id", nextJobIds);

      assertNoDbError(error);
      return (data ?? []) as JobRow[];
    }

    async function loadClients(nextCompanyId: string, clientIds: string[]) {
      if (!clientIds.length) {
        return [] as ClientRow[];
      }

      const { data, error } = await supabase
        .from("clients")
        .select("id, name")
        .eq("company_id", nextCompanyId)
        .in("id", clientIds);

      assertNoDbError(error);
      return (data ?? []) as ClientRow[];
    }

    async function loadEmployees(nextCompanyId: string, nextEmployeeIds: string[]) {
      if (!nextEmployeeIds.length) {
        return [] as EmployeeRow[];
      }

      const { data, error } = await supabase
        .from("company_memberships")
        .select("user_id, full_name, email")
        .eq("company_id", nextCompanyId)
        .in("user_id", nextEmployeeIds);

      assertNoDbError(error);
      return (data ?? []) as EmployeeRow[];
    }
  } catch (error) {
    return handleRouteError(error);
  }
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
