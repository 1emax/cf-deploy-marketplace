# cf-deploy

Claude Code plugin for publishing static sites to Cloudflare Pages — upload a folder, add
the domain, point DNS. Everything through the Cloudflare API; no `wrangler`, no dashboard.

## Install

```bash
/plugin marketplace add https://github.com/1emax/cf-deploy-marketplace
/plugin install cf-deploy-trial@cf-deploy-marketplace
```

Then set up credentials once. `cf-deploy setup` prints these same instructions.

### Create the API token

Go to **https://dash.cloudflare.com/?to=/:account/api-tokens** → **Create Token** →
**Custom token** → **Get started**.

> This is the **account** API tokens page, not the personal one at
> `/profile/api-tokens`. Account tokens start with `cfat_` and are what this tool
> expects — they're also why `/user/tokens/verify` rejects them, so `cf-deploy` verifies
> against `/accounts/{id}` instead.

Choose **Create Token** → **Start from scratch**, then build one policy with two
resource scopes:

**Entire Account**

| Permission | Level | Group |
|---|---|---|
| Cloudflare Pages | Edit | Developer Platform |

**All domains**

| Permission | Level | Group (!) |
|---|---|---|
| Zone | Edit | DNS & Zones |
| DNS | Edit | DNS & Zones |

Then **Continue to summary** → **Create Token** and copy it — Cloudflare shows it once.

> ⚠️ Two easy mistakes:
> - **Zone** and **DNS** sit under **All domains**, not under **Entire Account** — which
>   is why looking for a "Zone" permission in the account scope turns up nothing.
> - It must be **All domains**, not a named list of domains. Adding a new domain creates
>   a zone that doesn't exist yet, so a policy scoped to specific domains can't create it.

Verify what a token can actually do with `cf-deploy doctor`.

A Global API Key will *not* work — this uses `Authorization: Bearer`, which only scoped
API tokens support.

### Find the Account ID

In the dashboard press `Cmd+K` / `Ctrl+K` and search **"Copy account ID"**. It's also on
any domain's Overview page under **API**, and under **Workers & Pages** → **Account
Details**.

Then just tell Claude Code:

> here's my Cloudflare token: cfat_… and account id 1e7e…

It saves it for you. Or do it yourself:

```bash
printf '%s' '<your-token>' | cf-deploy profile set personal --account-id <id> --token-stdin
```

Credentials go to `~/.config/cf-deploy/config.json` with mode `600`. Tokens are never
printed back — `cf-deploy profiles` shows them masked.

Piping the token via `--token-stdin` keeps it out of your shell history and out of the
process list. A `--token` flag exists for convenience but warns, because it leaks into
both. To avoid putting the token in a chat transcript at all, edit
`~/.config/cf-deploy/config.json` directly instead.

## Use

Just talk to Claude Code from the site's folder:

> publish this folder to example.com

Or run it directly:

```bash
cf-deploy                          # publish the current folder
cf-deploy --dir ./site             # publish a specific folder
cf-deploy --domain example.com     # publish and wire up the domain
cf-deploy attach-domain --domain example.com
cf-deploy move-domain --domain example.com --project other-site --yes
cf-deploy status
cf-deploy list
cf-deploy doctor                   # what the token is actually allowed to do
cf-deploy delete --project mysite  # dry run; add --yes to actually delete
```

Deletes and domain moves are two-step by design: without `--yes`, both commands print
exactly what would happen and stop. Deleting a project detaches any custom domains and
removes their DNS records first (Cloudflare otherwise refuses to delete a project with a
domain still attached) — but only the records that still point at that project, so a
domain already moved elsewhere first is never touched. `--domain` matches a zone by
**exact name**, so `www.example.com`
can never resolve to — and destroy — the `example.com` zone.

Re-running is how you update a site: same command, new files. The Pages project, the
zone, and the DNS record are each created only once.

## Multiple Cloudflare accounts

Add a profile per account:

```bash
printf '%s' '<token>' | cf-deploy profile set client-acme --account-id <id> --token-stdin
cf-deploy profiles                 # list them, tokens masked
cf-deploy profile remove client-acme
```

Which produces `~/.config/cf-deploy/config.json`:

```json
{
  "defaultProfile": "personal",
  "profiles": {
    "personal":    { "accountId": "...", "apiToken": "..." },
    "client-acme": { "accountId": "...", "apiToken": "..." }
  }
}
```

The first profile you add becomes the default; `--default` moves it later. Pick a
specific one for a run with `--profile client-acme`. After the first successful publish, the site folder
remembers its own profile, project, and domain in `.cf-deploy.json`, so later runs need no
flags at all.

Account selection order: `--account-id`/`--profile` flags → `CLOUDFLARE_ACCOUNT_ID` +
`CLOUDFLARE_API_TOKEN` env vars → the folder's `.cf-deploy.json` → `defaultProfile` → the
only profile if there's just one.

## Domains

Adding a domain has two phases, because nameserver changes are outside anyone's control:

1. **New domain** — `cf-deploy` adds it to Cloudflare and prints the nameservers to set at
   your registrar. Propagation usually takes a few hours. The `*.pages.dev` URL works
   immediately in the meantime, so the site is never blocked on DNS.
2. **Once the zone is active** — re-run the same command. It creates the proxied
   `CNAME → <project>.pages.dev` record and attaches the custom domain. The TLS
   certificate is typically issued within ~15 minutes; `cf-deploy status` shows progress.

If the domain already has A/AAAA/CNAME records, `cf-deploy` **refuses and lists them**
rather than silently taking a live site offline. Re-run with `--replace-dns` to go ahead.

## What gets uploaded

Everything in the folder except dotfiles (`.env`, `.git`, `.DS_Store`, …), `node_modules`,
`vendor`, and `__pycache__`. If an `.env` file somehow survives that filter the deploy
aborts outright rather than risk publishing secrets.

Cloudflare limits: 25 MB per file, 20,000 files per deployment.

## How it works

`cf-deploy` reimplements Cloudflare's direct-upload protocol — the same one
`wrangler pages deploy` uses internally, since there's no single "just send the files"
endpoint:

1. hash each file: `BLAKE3(base64(contents) + extension)`, hex, first 32 chars
2. `GET .../pages/projects/:name/upload-token` → short-lived upload JWT
3. `POST /pages/assets/check-missing` → skip anything Cloudflare already cached
4. `POST /pages/assets/upload` → the rest, batched under the 40 MB / 2000-file request caps
5. `POST .../pages/projects/:name/deployments` with a manifest of path → hash

## Layout

```
cf-deploy/
├── .claude-plugin/marketplace.json   # marketplace catalog
└── plugins/cf-deploy/
    ├── .claude-plugin/plugin.json    # plugin manifest
    ├── skills/publish-site/SKILL.md  # teaches Claude when and how to use the CLI
    ├── bin/cf-deploy                 # CLI, added to PATH when the plugin is enabled
    ├── lib/                          # config, API client, zones, DNS, upload, domains
    └── node_modules/blake3-wasm/     # vendored: plugins have no npm install step
```

`node_modules/` is committed on purpose — Claude Code plugins are copied as files with no
dependency install step, so the one runtime dependency (~1 MB) ships with the plugin.

## Development

```bash
claude --plugin-dir ./plugins/cf-deploy      # load without installing
claude plugin validate .                     # check the marketplace manifest
claude plugin validate ./plugins/cf-deploy   # check the plugin manifest
```

Bump `version` in **both** `plugin.json` and `marketplace.json` when releasing; users get
updates via `/plugin update cf-deploy`.
