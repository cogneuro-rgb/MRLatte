# Deploying NeuroVue

Single-server deployment. One URL opens the whole app. MongoDB + the FastAPI
backend (which also serves the built React frontend) + Caddy (automatic HTTPS)
run as three containers via Docker Compose.

---

## Server requirements

| Resource | Minimum | Notes |
|---|---|---|
| CPU | 2 vCPU | Python imaging libs are CPU-bound during report generation |
| RAM | 4 GB | NIfTI loading + MongoDB + Python runtime peaks at ~2.5 GB |
| Disk | 20 GB SSD | Base OS ~5 GB + Docker images ~4 GB + lesion data |
| OS | Ubuntu 22.04 LTS | Any Linux with Docker 24+ works |
| Docker | 24+ with Compose plugin | `docker compose` (v2), not `docker-compose` (v1) |

---

## Prerequisites

**1. Install Docker on the server:**
```bash
curl -fsSL https://get.docker.com | sh
# Verify:
docker --version          # Docker 24.x or later
docker compose version    # v2.x
```

**2. Open firewall ports** (Caddy needs 80 for Let's Encrypt, 443 for HTTPS, 22 for SSH):
```bash
ufw allow 22
ufw allow 80
ufw allow 443
ufw --force enable
ufw status
```

**3. Point your domain at the server.**
Create an `A` record (and optionally `AAAA` for IPv6) at your DNS provider:
```
neurovue.yourdomain.com  →  <server public IP>
```
Wait for DNS to propagate before starting the stack (usually a few minutes,
up to an hour). Caddy will fail to issue a TLS certificate if DNS has not
resolved yet.

---

## Deploy steps

```bash
# 1. Clone the repository onto the server
git clone <repo-url> neurovue
cd neurovue

# 2. Create the environment file from the template
cp .env.example .env

# 3. Edit .env — set your domain (the only required change)
nano .env
#   DOMAIN=neurovue.yourdomain.com
#   DB_NAME=neurovue          ← keep the default or rename

# 4. Build and start all services in the background
docker compose up -d --build
```

**First build warning:** the Python imaging dependencies (SimpleITK, nibabel,
nilearn, neuropythy, dipy) are large. The first `--build` takes **10–15 minutes**
depending on server speed and network. Subsequent builds use the layer cache
and complete in under a minute.

Watch progress in real time:
```bash
docker compose logs -f
```

---

## Verify the deployment

```bash
# App loads over HTTPS (Caddy auto-issues the cert on first request — allow ~10s)
curl -I https://neurovue.yourdomain.com

# API responds
curl -s https://neurovue.yourdomain.com/api/lesions   # → []

# Check all three containers are running
docker compose ps
```

In the browser: open `https://neurovue.yourdomain.com` — the MNI152 base
volume should render in the viewer.

**Lesion save round-trip:**
1. Draw Lesion → enable → paint a region → Save → enter a name when prompted.
2. A `.nii.gz` downloads in the browser AND is stored server-side:
```bash
docker compose exec app ls -R /data/lesions
docker compose exec mongo mongosh --quiet \
  --eval 'db.getSiblingDB("neurovue").lesions.find().pretty()'
```

---

## Where data lives

All persistent data is stored in named Docker volumes — they survive container
restarts and `docker compose down`.

| Volume | Contents |
|---|---|
| `mongo_data` | MongoDB database (lesion metadata, status checks) |
| `lesions_data` | Drawn lesion `.nii.gz` files under `/data/lesions/<name>/` |
| `caddy_data` | TLS certificates issued by Let's Encrypt |
| `caddy_config` | Caddy internal state |

**Back up lesion data** (run on the server):
```bash
# Lesion NIfTI files
docker run --rm \
  -v neurovue_lesions_data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/lesions_backup_$(date +%Y%m%d).tar.gz -C /data .

# MongoDB dump
docker compose exec mongo mongodump --db neurovue --out /tmp/mongodump
docker compose cp mongo:/tmp/mongodump ./mongodump_$(date +%Y%m%d)
```

---

## Operations

```bash
# Tail logs
docker compose logs -f app        # backend (FastAPI + static serving)
docker compose logs -f caddy      # reverse proxy / TLS
docker compose logs -f mongo      # database

# Update after a code change on the server
git pull
docker compose up -d --build

# Stop (volumes and data are preserved)
docker compose down

# Stop AND delete all data (destructive — cannot be undone)
docker compose down -v
```

---

## Local smoke test (no domain, no TLS)

Verify the image builds and the app starts before pointing a domain at it:

```bash
# Start a standalone Mongo
docker run -d --name nv-mongo mongo:7

# Build and run the app container
docker build -t neurovue .
docker run --rm -p 8001:8001 --link nv-mongo:mongo \
  -e MONGO_URL=mongodb://mongo:27017 \
  -e DB_NAME=neurovue \
  neurovue

# Verify
curl http://localhost:8001/api/lesions   # → []
# Open http://localhost:8001 in a browser

# Cleanup
docker stop nv-mongo && docker rm nv-mongo
```

---

## Security notes

**No authentication is configured by default.** Anyone who can reach the domain
can use the app and save lesions. If access control is required before going
live, add HTTP Basic Auth to the `Caddyfile`:

```caddy
{$DOMAIN} {
    basicauth {
        # Generate the hash: docker run --rm caddy:2 caddy hash-password --plaintext yourpassword
        username $2a$14$...hashedpassword...
    }
    reverse_proxy app:8001
}
```

Then restart Caddy: `docker compose restart caddy`.

---

## Troubleshooting

**TLS certificate not issued / browser shows "not secure"**
- Caddy needs port 80 open to complete the ACME challenge. Run `ufw status` and confirm 80 is allowed.
- DNS may not have propagated yet. Check: `nslookup neurovue.yourdomain.com` — it must return your server's IP.
- Check Caddy logs: `docker compose logs caddy`.

**App container exits immediately after starting**
- `MONGO_URL` or `DB_NAME` are missing — the backend does a fail-fast check at startup and prints a clear `RuntimeError`.
- Run `docker compose logs app` to see the error.
- Confirm `.env` is present in the repo root and contains `DOMAIN` and `DB_NAME`.

**Atlas overlays not loading / 404 on atlas files**
- Atlas NIfTI files must live in `frontend/public/atlases/` in the repo. CRA copies that folder into `build/atlases/` during `yarn build`, and the container serves them from `/app/frontend/build/atlases/`.
- Verify inside the running container: `docker compose exec app ls /app/frontend/build/atlases/`

**DICOM import endpoint returns 500**
- `dcm2niix` is bundled in the image. Verify it is present: `docker compose exec app which dcm2niix`

**Out of disk space during build**
- The Python imaging layers are ~1.5 GB. Clean up dangling layers from previous builds: `docker system prune -f`
