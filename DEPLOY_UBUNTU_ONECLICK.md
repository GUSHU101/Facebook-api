# Pure Ubuntu One-Command Deployment

This path does not require Baota/aaPanel. It installs and manages the stack directly on Ubuntu with apt, Nginx, PostgreSQL, Redis, Node.js and PM2.

## Requirements

- Ubuntu 20.04/22.04/24.04 VPS
- Root SSH access
- A GitHub repository containing this project
- A domain pointing to the VPS if you want public HTTPS access
- A non-443 public HTTPS port, for example `8443`

## One-Command Install

After uploading this project to GitHub, run:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USER/YOUR_REPO/main/deploy/install_ubuntu.sh -o /tmp/capi-install.sh \
  && sudo env \
    REPO_URL=https://github.com/YOUR_GITHUB_USER/YOUR_REPO.git \
    DOMAIN=capi.example.com \
    PUBLIC_PORT=8443 \
    AUTO_SSL=1 \
    ACME_DNS_PROVIDER=dns_cf \
    CF_Token=your_cloudflare_api_token \
    CF_Zone_ID=your_cloudflare_zone_id \
    bash /tmp/capi-install.sh
```

Optional variables:

```bash
APP_DIR=/www/wwwroot/capi-saas
BRANCH=main
INTERNAL_PORT=3000
DB_NAME=capi_saas
DB_USER=capi_user
DB_PASSWORD=replace_with_strong_password
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace_with_strong_password
AES_SECRET_KEY=replace_with_32_plus_character_secret
CERT_FULLCHAIN=/etc/ssl/capi/fullchain.pem
CERT_KEY=/etc/ssl/capi/privkey.pem
AUTO_SSL=1
ACME_DNS_PROVIDER=dns_cf
ACME_EMAIL=admin@example.com
REDIRECT_HTTP=1
ENABLE_UFW=1
AUTO_ENABLE_NGINX=1
SKIP_APT=1
```

Use `SKIP_APT=1` only when Node.js, PM2, PostgreSQL, Redis and Nginx are already installed.

If you provide `DB_PASSWORD`, use only letters, numbers, `.`, `_`, `~`, or `-`, because it is embedded in `DATABASE_URL`.

## What The Script Does

1. Detects Ubuntu and requires root.
2. Installs missing system dependencies with apt.
3. Installs or upgrades Node.js to 20 when needed.
4. Installs PM2 when needed.
5. Starts PostgreSQL, Redis and Nginx.
6. Opens `PUBLIC_PORT` in UFW when UFW is active.
7. Clones or updates the GitHub repository.
8. Creates PostgreSQL database and user.
9. Generates `.env` with strong secrets when not provided.
10. Runs `npm install --omit=dev`.
11. Runs `npm run check`, `init.sql`, `npm run migrate`, and `npm run doctor`.
12. Starts API and worker with PM2.
13. Optionally issues SSL certificates with acme.sh DNS-01.
14. Writes a non-443 Nginx HTTPS config example, or enables it automatically when certificate paths are available.
15. Optionally adds an HTTP port 80 redirect to `https://domain:PUBLIC_PORT`.

The installer is designed to be re-runnable. If the repository already exists, it pulls the selected branch. PM2 uses `startOrReload`, so repeated deploys update existing `capi-api` and `capi-worker` processes instead of creating duplicate processes.

## HTTPS Without 443

The script intentionally does not bind public `443`.

If `AUTO_SSL=1`, the script uses acme.sh DNS-01 validation to issue a certificate. DNS-01 is required for fully automatic SSL when avoiding public `443`.

Cloudflare example:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USER/YOUR_REPO/main/deploy/install_ubuntu.sh -o /tmp/capi-install.sh \
  && sudo env \
    REPO_URL=https://github.com/YOUR_GITHUB_USER/YOUR_REPO.git \
    DOMAIN=capi.example.com \
    PUBLIC_PORT=8443 \
    AUTO_SSL=1 \
    ACME_DNS_PROVIDER=dns_cf \
    CF_Token=your_cloudflare_api_token \
    CF_Zone_ID=your_cloudflare_zone_id \
    bash /tmp/capi-install.sh
```

Aliyun DNS example:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USER/YOUR_REPO/main/deploy/install_ubuntu.sh -o /tmp/capi-install.sh \
  && sudo env \
    REPO_URL=https://github.com/YOUR_GITHUB_USER/YOUR_REPO.git \
    DOMAIN=capi.example.com \
    PUBLIC_PORT=8443 \
    AUTO_SSL=1 \
    ACME_DNS_PROVIDER=dns_ali \
    Ali_Key=your_aliyun_access_key \
    Ali_Secret=your_aliyun_access_secret \
    bash /tmp/capi-install.sh
```

If `CERT_FULLCHAIN` and `CERT_KEY` are provided and `AUTO_ENABLE_NGINX=1`, the script writes and reloads an active Nginx config automatically.

Without certificate paths, it writes an example file:

```text
/etc/nginx/conf.d/capi-saas-8443.conf.example
```

Copy it to an active Nginx config after adding real certificate paths:

```bash
cp /etc/nginx/conf.d/capi-saas-8443.conf.example /etc/nginx/conf.d/capi-saas.conf
nano /etc/nginx/conf.d/capi-saas.conf
nginx -t
systemctl reload nginx
```

Manual Nginx config template, using `8443` for public HTTPS and never binding `443`:

```nginx
# /etc/nginx/conf.d/capi-saas.conf
# Replace nestworks.com.au and certificate paths if your domain/project name differs.

server {
    listen 80;
    server_name nestworks.com.au;

    # Optional: keep HTTP available only for redirects or certificate checks.
    location /.well-known/acme-challenge/ {
        root /var/www/html;
        try_files $uri =404;
    }

    location / {
        return 301 https://$host:8443$request_uri;
    }
}

server {
    listen 8443 ssl http2;
    server_name nestworks.com.au;

    ssl_certificate     /etc/ssl/capi/fullchain.pem;
    ssl_certificate_key /etc/ssl/capi/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    client_max_body_size 10m;

    location ~* /(\.git|\.svn|\.hg|node_modules|runtime|backups|\.env|\.npm|\.cache)/ {
        return 404;
    }

    location ~* (\.env.*|package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|docker-compose\.yml|Dockerfile|README\.md|LICENSE|\.sql(\.gz)?|\.log|\.bak|\.old|\.tmp)$ {
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Port 8443;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 30s;
        proxy_send_timeout 30s;
        proxy_read_timeout 86400s;
    }

    access_log /var/log/nginx/capi-saas.access.log;
    error_log  /var/log/nginx/capi-saas.error.log;
}
```

Matching `.env` port values:

```env
PORT=3000
TRUST_PROXY_HOPS=1
```

`PORT=3000` is only the internal Node.js port. Shopify, Meta, TikTok and the admin panel should use:

```text
https://nestworks.com.au:8443
```

Use DNS validation for SSL certificates so certificate issuance does not require port `443`.

When `REDIRECT_HTTP=1`, Nginx also redirects:

```text
http://capi.example.com/* -> https://capi.example.com:8443/*
```

## After Install

Open:

```text
https://capi.example.com:8443/admin
```

Then:

1. Add Shopify shop.
2. Add Facebook / Meta route.
3. Add TikTok route if needed.
4. Copy generated Shopify Custom Pixel code.
5. Configure Shopify `orders/paid` webhook:

```text
https://capi.example.com:8443/api/webhook/orders/paid
```

For `Purchase`, browser and webhook events should use the same checkout/order event ID. The server merges duplicate Purchase payloads while the event is still pending, so Shopify order webhook data can enrich browser events without causing already successful events to be sent again.

## Upgrade

```bash
cd /www/wwwroot/capi-saas
npm run backup
git pull --ff-only
npm install --omit=dev
npm run check
npm run migrate
npm run doctor
pm2 restart ecosystem.config.js
```

## Backup And Restore

Create a backup before upgrades or server maintenance:

```bash
cd /www/wwwroot/capi-saas
npm run backup
```

Backups are written to:

```text
/www/wwwroot/capi-saas/backups
```

The backup includes a PostgreSQL custom-format dump and, by default, a copy of `.env`. Keep `.env` backups private because `AES_SECRET_KEY` is required to decrypt saved platform tokens.

Restore a database backup:

```bash
cd /www/wwwroot/capi-saas
CONFIRM=RESTORE bash scripts/restore.sh backups/capi-db-YYYYMMDDTHHMMSSZ.dump
npm run migrate
npm run doctor
pm2 restart ecosystem.config.js
```
