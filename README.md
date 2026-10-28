# Techzaz EMS (TEMS)

Centralized sign-in, people and project management for Techzaz Networks: users and access groups,
employee records with onboarding and e-signed agreements, projects with status tracking, and tickets.
Everyone a change affects is emailed.

| Service    | Tech                         | Role                                                        |
|------------|------------------------------|-------------------------------------------------------------|
| `web`      | Astro + nginx                | Admin console; gateway for `/api` and `/auth` on one origin |
| `api`      | Go                           | Users, groups, permissions, employees, projects, tickets, audit, notification outbox |
| `keycloak` | Keycloak 26                  | Sign-in (OIDC + PKCE), sessions, password policy            |
| `mail`     | Postfix + OpenDKIM           | DKIM-signed outbound mail from `no-reply@tems.techzaz.lk`   |
| `db`       | PostgreSQL 16                | Keycloak + TEMS data (including uploaded documents)          |

## Modules

| Console page | What it does |
|---|---|
| **Users, Groups, Permissions** | Sign-in accounts, access groups and the permission catalog. Super admins create groups for any team (HR, Project Managers, …) and choose exactly what each group can do. |
| **Employees** | Employee records with personal details, payroll (salary, allowances, EPF/ETF numbers, bank) and documents: birth certificate, NIC, educational qualifications, CV, EPF, ETF, salary and bank documents, agreements. |
| **Onboarding** | Every new employee moves through **Documents → Approval → Agreement → Active**. HR uploads the required documents (set in Settings) and submits; a *different* admin approves or sends it back with a note; HR sends the agreement and the candidate gets a **private signing link** to read it and sign in a signature box. Signing files a signed copy (signature, name, time, IP, document hash) and completes the onboarding. |
| **Projects** | Teams with roles and allocation, a project lead, and **status tracking**: status (planning, active, on hold, completed, cancelled), health (on track, at risk, off track), progress from resolved tickets, overdue warnings and a timeline of status updates. |
| **Tickets** | Per-project tasks, bugs, features and support requests (`KEY-12`), on a board or a list, with priority, due date, assignee (from the project team), comments and an activity trail. |
| **My work** | For staff whose sign-in account is linked to their employee record: their projects and the tickets assigned to them. |
| **Mail, Audit, Settings** | Outbox with delivery status, the full audit trail, sender identity, password policy, required onboarding documents and which events send email. |
| **Email signatures** | Every email signature follows one layout: the Techzaz Networks logo, a bronze rule, name, job title (people only), company, Email / Mobile / Web, the AWS Partner and Google Cloud Partner badges, then the legal disclaimer between rows of asterisks. Ten templates ship ready to use (Saeed Ahamed, Chief Executive Officer; Lakshitha Perera, Head of Engineering; Human Resource Team; IT, Marketing, Admin, Sales, Operations and Cyber Security Departments; Support Team) and you can add your own, the badges and the disclaimer are edited in Settings with a live preview. Compose picks a signature per message; each kind of notification (accounts and access, people, projects and tickets) is signed by the one chosen in Settings. |
| **Outlook setup** | Super admins add a person's personal address (e.g. Gmail) in Users → Outlook setup. That address is emailed the work email plus the IMAP/SMTP settings and step-by-step Outlook (desktop and mobile) setup. The mail servers are set in Settings → Work mailbox servers. |

## Access model

- **Permissions** are Keycloak client roles on `tems-api` (e.g. `users:edit`). Super admins can add custom ones.
- **Groups** carry permissions. A member's effective access = all their groups' permissions ∪ personal **allows** − personal **denies**.
- **Super admins** (realm role `super-admin`) bypass every check.
- Safety rails: you can only grant permissions you hold, you can't change your own access, and at least one super admin must remain.
- Every admin change is written to the audit log, and **the affected people are emailed** (configurable per event in Settings): account and access changes, onboarding steps, payroll and document changes, approvals, agreements to sign and signed, project assignments and status updates, ticket assignments, changes and comments. Agreement signing links are always sent.
- People permissions: `employees:view|manage|approve|payroll|delete`, `projects:view|manage`, `tickets:view|create|manage`. Payroll details and payroll documents (EPF, ETF, salary, bank) need `employees:payroll`. Nobody can approve an onboarding they submitted (super admins excepted). The realm ships **HR** and **Project Managers** groups as starting points.

## Status

- [x] Console (`web/`): runs live, or on built-in demo data with `PUBLIC_TEMS_DEMO=true`
- [x] Compose stack, env generator, Postgres init, Keycloak realm import
- [x] Go API (`api/`): implements the contract in `web/src/lib/api.ts`; verified end to end against Keycloak 26
- [x] Employees, onboarding pipeline, document uploads, e-signed agreements, projects with status tracking, tickets
- [x] Keycloak login theme (`keycloak/themes/tems/`)
- [x] Deploy kit: Caddy TLS front, mail DNS helper, backups ([`deploy/DEPLOY.md`](deploy/DEPLOY.md))
- [ ] Go live on `tems.techzaz.lk` and publish SPF / DKIM / DMARC (follow `deploy/DEPLOY.md`)

## Console only (demo data)

```bash
cd web && npm install && npm run dev            # http://localhost:4321
# or the production image:
docker build --build-arg PUBLIC_TEMS_DEMO=true -t tems-web:demo web
docker run --rm -p 127.0.0.1:18088:8080 tems-web:demo
```

## Full stack

```bash
./scripts/init-env.sh          # writes .env with random secrets, prints the super admin password
docker compose up -d --build   # http://localhost:8088
```

## Production

See [`deploy/DEPLOY.md`](deploy/DEPLOY.md): server prerequisites, DNS (A, PTR, SPF, DKIM, DMARC),
TLS with Caddy, and backups. `./scripts/mail-dns.sh` prints the exact records to publish and checks them.

## Development checks

```bash
cd api && gofmt -l . && go vet ./... && go test ./...
cd web && PUBLIC_TEMS_DEMO=false npm run build   # astro check + build
```
