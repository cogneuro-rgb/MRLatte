# Deploying NeuroVue on Windows

---

## Just want it running locally? (no domain, no internet)

If you only need the app on one PC — no public URL, no HTTPS — use the local
setup. It takes 3 commands after Docker is installed.

**1. Install Docker Desktop** (same as Step 1 below), then open PowerShell in
the `neurovue` folder and run:

```powershell
# First time only — builds the image (~10–15 min)
docker compose -f docker-compose.local.yml up -d --build
```

**2. Open the app:**
```
http://localhost:8001
```

That's it. No domain, no firewall rules, no TLS needed.

**Stop the app:**
```powershell
docker compose -f docker-compose.local.yml down
```

**Start it again later** (fast, no rebuild):
```powershell
docker compose -f docker-compose.local.yml up -d
```

**Update after receiving new files:**
```powershell
docker compose -f docker-compose.local.yml up -d --build
```

> Your saved lesion data is kept in a Docker volume and survives stop/start
> cycles. Only `docker compose ... down -v` deletes it.

---

## Want it on the internet with a public URL? Follow the steps below.

---

## Step 1 — Install Docker Desktop

1. Download from: **https://www.docker.com/products/docker-desktop/**
2. Run the installer, keep all defaults (uses WSL2 backend — let it install WSL2 if prompted)
3. Restart the machine when asked
4. After reboot, open Docker Desktop and wait until it shows **"Engine running"** in the bottom-left corner
5. Verify in PowerShell:
   ```powershell
   docker --version
   docker compose version
   ```

---

## Step 2 — Open firewall ports

Run PowerShell **as Administrator**:
```powershell
netsh advfirewall firewall add rule name="HTTP"  dir=in action=allow protocol=TCP localport=80
netsh advfirewall firewall add rule name="HTTPS" dir=in action=allow protocol=TCP localport=443
```

---

## Step 3 — Copy the files

Copy `neurovue-deploy.zip` from the USB drive, then extract it:
```powershell
Expand-Archive -Path "D:\neurovue-deploy.zip" -DestinationPath "C:\neurovue"
cd C:\neurovue
```

Replace `D:\` with your actual USB drive letter.

---

## Step 4 — Point your domain at this machine

At your DNS provider, create an **A record**:
```
neurovue.yourdomain.com  →  <this machine's public IP>
```

Wait a few minutes for DNS to propagate before the next step. Caddy will fail
to issue a TLS certificate if DNS has not resolved yet. You can check with:
```powershell
nslookup neurovue.yourdomain.com
```
It should return this machine's IP address.

---

## Step 5 — Create the `.env` file

```powershell
Copy-Item .env.example .env
notepad .env
```

In Notepad, set your domain and save:
```
DOMAIN=neurovue.yourdomain.com
DB_NAME=neurovue
```

---

## Step 6 — Build and start

```powershell
docker compose up -d --build
```

> **The first build takes 10–15 minutes.** Docker is downloading and compiling
> large Python imaging libraries (SimpleITK, nibabel, nilearn). You will see a
> lot of output — this is normal. Wait until the terminal prompt returns.

---

## Step 7 — Verify

```powershell
# Check all 3 containers are running (should show app, mongo, caddy)
docker compose ps

# Test the API (should return [])
curl http://localhost:8001/api/lesions
```

Then open **https://yourdomain.com** in a browser — the MNI152 brain should
load in the viewer.

---

## Useful commands

```powershell
# Watch live logs
docker compose logs -f app        # backend
docker compose logs -f caddy      # reverse proxy / TLS
docker compose logs -f mongo      # database

# After receiving a code update (new zip or git pull)
docker compose up -d --build

# Stop everything — data volumes are preserved
docker compose down

# Stop AND delete all data (destructive, cannot be undone)
docker compose down -v
```

---

## Important: keeping the app running after a reboot

Docker Desktop must be running for the containers to stay up. After a machine
reboot:

1. Open **Docker Desktop** from the Start menu and wait for "Engine running"
2. Then in PowerShell:
   ```powershell
   cd C:\neurovue
   docker compose up -d
   ```

To make this automatic, enable **"Start Docker Desktop when you sign in"** in
Docker Desktop → Settings → General.

---

## Troubleshooting

**TLS certificate not issued / browser shows "not secure"**
- Port 80 must be reachable from the internet for Let's Encrypt to work. Check
  the firewall rule was added (Step 2) and that your router/cloud firewall also
  forwards port 80 to this machine.
- DNS may not have propagated yet — run `nslookup yourdomain.com` to confirm.
- Check Caddy logs: `docker compose logs caddy`

**App container exits immediately**
- `MONGO_URL` or `DB_NAME` are missing. Run `docker compose logs app` — you
  will see a clear error message saying which variable is missing.
- Make sure `.env` exists in `C:\neurovue` and contains `DOMAIN` and `DB_NAME`.

**`docker compose` not recognised**
- Docker Desktop is not running. Open it from the Start menu and wait for
  "Engine running" before retrying.

**Out of disk space during build**
- Clean up old Docker layers: `docker system prune -f`
