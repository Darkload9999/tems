# Techzaz EMS (TEMS)

Centralized authentication and mail management for Techzaz Networks.

| Service    | Tech                         | Role                                                        |
|------------|------------------------------|-------------------------------------------------------------|
| `web`      | Astro + nginx                | Admin console; gateway for `/api` and `/auth` on one origin |
| `api`      | Go                           | Users, groups, permissions, audit, notification outbox      |
| `keycloak` | Keycloak 26                  | Sign-in (OIDC + PKCE), sessions, password policy            |
| `mail`     | Postfix + OpenDKIM           | DKIM-signed outbound mail from `no-reply@tems.techzaz.lk`   |
| `db`       | PostgreSQL 16                | Keycloak + TEMS data                                         |

## Access model

- **Permissions** are Keycloak client roles on `tems-api` (e.g. `users:edit`). Super admins can add custom ones.
- **Groups** carry permissions. A member's effective access = all their groups' permissions ∪ personal **allows** − personal **denies**.
- **Super admins** (realm role `super-admin`) bypass every check.
- Safety rails: you can only grant permissions you hold, you can't change your own access, and at least one super admin must remain.
- Every admin change is written to the audit log, and **the affected users are emailed** (configurable per event in Settings).

## Status

- [x] Console (`web/`) — complete; runs on built-in demo data (`PUBLIC_TEMS_DEMO=true`) until the API exists
- [x] Compose stack, env generator, Postgres init, Keycloak realm import
- [ ] Go API (`api/`) — implements the contract in `web/src/lib/api.ts`
- [ ] Keycloak login theme (`keycloak/themes/tems/`)
- [ ] Deploy to `tems.techzaz.lk` + mail DNS (SPF / DKIM / DMARC)

## Console only (demo data)

```bash
cd web && npm install && npm run dev            # http://localhost:4321
# or the production image:
docker build --build-arg PUBLIC_TEMS_DEMO=true -t tems-web:demo web
docker run --rm -p 127.0.0.1:18088:8080 tems-web:demo
```

## Full stack (once the API is in place)

```bash
./scripts/init-env.sh          # writes .env with random secrets, prints the super admin password
docker compose up -d --build   # http://localhost:8088
```
