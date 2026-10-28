# Deploying TEMS to tems.techzaz.lk

One Linux host runs the whole stack with Docker Compose. Caddy terminates TLS on
443 and forwards to the web gateway on `127.0.0.1:8088`; nothing else is
published. Postfix sends straight to recipients' mail servers on port 25.

```
Internet ──443──► Caddy ──► web :8088 (nginx) ──/api──► api ──► keycloak, db
                                               └─/auth─► keycloak
          ◄──25── mail (Postfix + OpenDKIM) ◄── api, keycloak
```

## 1. Server

- Ubuntu 24.04 (or any distro with Docker), 2 vCPU / 4 GB RAM / 20 GB disk.
- A static public IPv4 whose provider allows **outbound port 25** and lets you
  set **reverse DNS** (PTR). Many clouds block 25 until you ask; check first.
- Firewall: allow 22, 80 and 443 inbound. Port 25 inbound is not needed (TEMS only sends).

```bash
curl -fsSL https://get.docker.com | sh
apt-get install -y caddy dnsutils            # or follow caddyserver.com/docs/install
git clone https://github.com/Darkload9999/tems /opt/tems && cd /opt/tems
```

## 2. DNS (part 1): point the names at the server

In the `techzaz.lk` zone:

| Type | Name                    | Value       |
|------|-------------------------|-------------|
| A    | `tems.techzaz.lk`       | server IPv4 |
| A    | `mail.tems.techzaz.lk`  | server IPv4 |

At the hosting provider, set the IP's **PTR** to `mail.tems.techzaz.lk`. It must
match the Postfix hostname, or large providers will reject the mail.

If `tems.techzaz.lk` sits behind Cloudflare's proxy, keep `mail.tems` as DNS-only
(grey cloud) and set Cloudflare SSL to *Full (strict)*.

## 3. Configure and start

```bash
PUBLIC_URL=https://tems.techzaz.lk TEMS_SUPERADMIN_EMAIL=you@techzaz.lk ./scripts/init-env.sh
docker compose up -d --build
docker compose ps                  # all services healthy after ~1 minute
```

`init-env.sh` prints the first super admin's password once; store it in your
password manager. `.env` holds every secret (mode 600) and is never committed.

Then TLS:

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
```

Open https://tems.techzaz.lk and sign in as `superadmin`.

## 4. DNS (part 2): SPF, DKIM, DMARC

The mail container generates its DKIM key on first start. Print every record
with its current status:

```bash
./scripts/mail-dns.sh
```

Add the TXT records it lists to the `techzaz.lk` zone:

| Name                               | Value                                        |
|------------------------------------|----------------------------------------------|
| `tems.techzaz.lk`                  | `v=spf1 ip4:<server IP> -all`                |
| `tems._domainkey.tems.techzaz.lk`  | `v=DKIM1; h=sha256; k=rsa; s=email; p=…` (from the script) |
| `_dmarc.tems.techzaz.lk`           | `v=DMARC1; p=quarantine; adkim=s; aspf=s`    |

Re-run `./scripts/mail-dns.sh` until every row shows ✓. In the console,
**Mail → Outbox** shows the same DKIM check. Then send yourself a message from
**Mail → Compose** and open the original headers. You should see
`spf=pass`, `dkim=pass header.d=tems.techzaz.lk` and `dmarc=pass`.

Want aggregate DMARC reports? Re-run with `DMARC_RUA=dmarc@techzaz.lk` and use the `rua=` value it prints.

## 5. Operate

| Task | Command |
|------|---------|
| Update | Automatic on every push to `main` once continuous deployment is set up (section 6). By hand: `git pull && docker compose up -d --build` |
| Roll back | `./scripts/deploy.sh <older-tag>` (tags are the first 12 characters of a commit SHA; see the repository's Packages) |
| Logs | `docker compose logs -f api` (or `keycloak`, `mail`, `web`) |
| Mail queue | `docker compose exec mail postqueue -p` |
| Backup | `./scripts/backup.sh` (dumps both databases, which include every uploaded employee document and signed agreement, plus the DKIM key, to `backups/`) |
| Nightly backup | `crontab -e` → `17 3 * * * /opt/tems/scripts/backup.sh` and copy `backups/` off the host |
| Restore a DB | `docker compose exec -T db pg_restore -U postgres --clean -d tems < backups/<ts>/tems.dump` |

Backups contain salary details and identity documents: keep `backups/` encrypted and off the web server's public paths.

Keep the DKIM key with your backups: if you lose the `mail_dkim` volume, a new key
is generated and the DKIM DNS record has to be replaced.

The Keycloak admin console is not exposed (the gateway returns 404 for
`/auth/admin`). For break-glass changes, use `kcadm.sh` inside the container with
`KC_BOOTSTRAP_ADMIN_PASSWORD` from `.env`:

```bash
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080/auth --realm master --user kcadmin --password '<KC_BOOTSTRAP_ADMIN_PASSWORD>'
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get realms/tems
```

## 6. Continuous deployment (GitHub Actions)

`.github/workflows/ci.yml` checks every push and pull request (Go tests, console build, Compose config,
shellcheck). For a push to `main` that passes, it builds `ghcr.io/darkload9999/tems-api` and `tems-web`
tagged with the commit and runs `scripts/deploy.sh` on the server over SSH. The script pulls the new
images, restarts the stack and waits until it is healthy. If the new version isn't healthy, it rolls
back to the previous tag and the run fails. **Run workflow** on `main` (Actions → CI/CD) redeploys the
current commit.

One-time setup:

1. On the server (after section 3, so `/opt/tems/.env` exists), create a deploy user that can run Docker:

   ```bash
   adduser --disabled-password --gecos "" deploy && usermod -aG docker deploy && chown -R deploy:deploy /opt/tems
   ```

2. On your computer, make a key pair for GitHub and allow it on the server:

   ```bash
   ssh-keygen -t ed25519 -N "" -C tems-deploy -f tems-deploy
   ```

   Append `tems-deploy.pub` to `/home/deploy/.ssh/authorized_keys` on the server.

3. Record the server's host key: `ssh-keyscan -H tems.techzaz.lk`

4. In GitHub, go to **Settings → Environments → New environment**, name it `production` and add:

   | Kind | Name | Value |
   |------|------|-------|
   | Secret | `DEPLOY_HOST` | `tems.techzaz.lk` (or the server IP) |
   | Secret | `DEPLOY_USER` | `deploy` |
   | Secret | `DEPLOY_SSH_KEY` | contents of the private key `tems-deploy` |
   | Secret | `DEPLOY_KNOWN_HOSTS` | output of step 3 |
   | Secret (optional) | `DEPLOY_PORT` | SSH port, if not 22 |
   | Variable | `PUBLIC_URL` | `https://tems.techzaz.lk` (turns on the post-deploy smoke test) |
   | Variable (optional) | `DEPLOY_PATH` | install path, if not `/opt/tems` |

   Optional: under the environment, add **Required reviewers** to approve each deploy, and limit
   **Deployment branches** to `main`.

Until these secrets exist, pushes to `main` still build and publish the images, and the deploy job is
skipped with a warning. The deploy job signs in to GHCR on the server with the run's own token and signs
out afterwards, so no registry password is stored. A rollback only swaps the images: Compose and realm
files from the newer commit stay in place.
