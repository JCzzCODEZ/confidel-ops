# Confidel Full Audit Prompt

Run a complete final audit of both:
1. Confidel Ops app
2. Confidel public website / confidel.co

Do not make random feature additions. Focus on bugs, security, workflow, business
readiness, pricing logic, and deployment readiness.

---

## PART 1 — CONFIDEL OPS APP BUG FIXES

Current known issues:
1. App sometimes gets stuck on: "Opening Confidel", "Loading owner dashboard", "Loading employee dashboard".
2. Owner Team invite form sometimes shows: `null is not an object (evaluating 'e.currentTarget.reset')`.
3. Confirm: Employee completion → Owner Review → Invoice Draft → Payment → Records → CSV export.

Tasks:
- Fix all auth loading hangs.
- Fix all async form reset bugs.
- Search entire app for `currentTarget.reset()`.
- Never use `event.currentTarget` after an await.
- Confirm no screen can spin forever.
- Confirm employee completion appears in owner Review.
- Confirm Records only depends on generated invoice draft / financial summary.
- Run typecheck and build.

## PART 2 — OPS APP AGENT AUDIT

- **Agent A — Owner Workflow:** owner login, clients, jobs, assign, review, pricing, invoice draft, payment, records, CSV export, team invites, employee activation/deactivation.
- **Agent B — Employee Workflow:** employee login, assigned jobs only, active jobs submittable, completed/rejected read-only, services checklist, add-ons checklist, timing, expenses, before/after photos, signature pad, notes, submit confirmation.
- **Agent C — Security:** employee cannot access owner routes/records/pricing/payroll/profit/tax/invoices; employee cannot see other employees' jobs; anon blocked; storage files private; alarm-code reveal audited; no service-role key in app; RLS enforced.
- **Agent D — Records / Tax:** invoice draft creates financial summary; monthly records correct; totals correct; CSV includes revenue, tax, payments, expenses, mileage, reimbursements, payroll, profit; paid/partial/unpaid works.
- **Agent E — Deployment:** Vercel deployment, env vars, Supabase Auth redirect URLs, /api/health, typecheck, build, production smoke test, rollback plan.

## PART 3 — CONFIDEL.CO WEBSITE AUDIT

- **Agent F — Customer Workflow:** 5-second clarity, easy service request, working forms, clear buttons, mobile usability, broken links, obvious booking/contact path.
- **Agent G — Pricing / Offer:** prices reasonable for North NJ premium home services; nothing too low/high; services clear enough for premium pricing; add-ons clear; no confusion between cleaning/house sitting/detailing/Airbnb turnover; opening offers clear; nothing legally/tax-wise misleading.
- **Agent H — Brand / Design:** luxury feel; black/gold/white brand; logo displays; no cheap/AI fonts; polished copy; clean mobile; believable high-quality images.
- **Agent I — SEO / Trust:** titles/meta; local keywords (North NJ, Passaic, Bergen, Essex, Morris, Hudson, Union, Middlesex); service pages; contact info; trust signals; insurance/bonding language; testimonials section; privacy/terms links.
- **Agent J — Technical:** performance, mobile responsiveness, accessibility basics, form validation, spam protection, analytics readiness, lead notification, console errors, 404s, HTTPS, favicon/logo, sitemap/robots.

## PART 4 — REQUIRED TESTS

Confidel Ops: `npm run typecheck`, `npm run build`, `npm run test:e2e`, `npm run test:api`, `npm run test:pricing`, `npm run test:onboarding`.

confidel.co: build command, lint/typecheck if available, browser smoke test, mobile viewport test, form submission test, console error check. If a command cannot run, explain why.

## PART 5 — FINAL REPORT FORMAT

1. Bugs found
2. Bugs fixed
3. Files changed
4. Tests passed
5. Tests not run and why
6. Security findings
7. Pricing concerns
8. Website UX concerns
9. Ops app workflow concerns
10. Remaining blockers before real client data
11. Remaining blockers before public launch
12. Whether Confidel Ops is safe for private demo
13. Whether Confidel Ops is safe for real production
14. Whether confidel.co is ready for customers
15. Exact next commands to run
16. Exact Vercel/Supabase steps needed

Do not say complete unless everything is actually verified.
