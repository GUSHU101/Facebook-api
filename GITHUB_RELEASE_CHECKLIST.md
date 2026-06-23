# GitHub Upload Checklist

Before pushing this project to GitHub:

1. Do not commit `.env`.
2. Commit `.env.example` so deployment users know which variables exist.
3. Commit `package-lock.json` for reproducible installs.
4. Commit `deploy/install_ubuntu.sh`, `.gitattributes`, and `.github/workflows/ci.yml`.
5. Push to the `main` branch.
6. Confirm the GitHub Actions CI workflow passes:
   - `npm ci`
   - `npm run check`
   - `npm test`
   - `npm audit --audit-level=moderate`

After GitHub upload, replace placeholders in the one-command install:

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

Security notes:

- Use a DNS API token scoped only to the target zone when possible.
- Rotate the DNS API token after deployment if you do not need automatic certificate renewal.
- Keep `AES_SECRET_KEY` stable after launch, because encrypted platform tokens depend on it.
- Keep port `443` closed if you want to avoid it; use DNS-01 SSL validation and public port `8443`.

Upgrade/redeploy:

- The one-command installer can be run again on the same VPS.
- Existing repositories are updated with `git pull --ff-only`.
- PM2 uses reload semantics for `capi-api` and `capi-worker`, avoiding duplicate processes.
