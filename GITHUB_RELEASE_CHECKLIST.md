# GitHub Upload Checklist

Before pushing this project to GitHub:

1. Do not commit `.env`.
2. Commit `.env.example` so deployment users know which variables exist.
3. Commit `package-lock.json` for reproducible installs.
4. Commit `deploy/install_ubuntu.sh`, `.gitattributes`, and `.github/workflows/ci.yml`.
5. Run `npm run build:admin` and commit the generated local CSS/Vue assets.
6. Open a pull request to `main`; merge only after CI succeeds.
7. Confirm the GitHub Actions CI workflow passes:
   - `npm ci`
   - generated admin asset reproducibility check
   - `npm run check`
   - `npm test`
   - `npm audit --omit=dev --audit-level=moderate`
   - production-only `npm ci --omit=dev` verification

Before every production restart or upgrade:

1. Back up PostgreSQL.
2. Run `npm run migrate` to apply the schema and online scale indexes.
3. Run `npm run doctor` to verify tenant isolation, shared Pixel identity,
   indexes, autovacuum, Redis `noeviction`, permissions, and configuration.
4. Reload API and worker processes with the updated environment.

After GitHub upload, use the published one-command install:

```bash
curl -fsSL https://raw.githubusercontent.com/GUSHU101/Facebook-api/main/deploy/install_ubuntu.sh -o /tmp/capi-install.sh \
  && sudo env \
    REPO_URL=https://github.com/GUSHU101/Facebook-api.git \
    DOMAIN=capi.example.com \
    PUBLIC_PORT=8443 \
    AUTO_SSL=1 \
    ACME_DNS_PROVIDER=dns_cf \
    CF_Token=your_cloudflare_api_token \
    CF_Zone_ID=your_cloudflare_zone_id \
    bash /tmp/capi-install.sh
```

Security notes:

- Use a DNS API token scoped only to the target zone when possible.
- Rotate the DNS API token after deployment if you do not need automatic certificate renewal.
- Keep `AES_SECRET_KEY` stable after launch, because encrypted platform tokens depend on it.
- Keep port `443` closed if you want to avoid it; use DNS-01 SSL validation and public port `8443`.

Upgrade/redeploy:

- The one-command installer can be run again on the same VPS.
- It creates a database and `.env` backup before pulling an existing installation.
- Existing `.env` and encryption/database credentials are preserved by default.
- Existing repositories are updated with `git pull --ff-only`.
- PM2 uses reload semantics for `capi-api` and `capi-worker`, avoiding duplicate processes.
