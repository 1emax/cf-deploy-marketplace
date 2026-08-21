---
name: publish-site
description: Publish a local folder of static files to Cloudflare Pages, optionally on a custom domain. Use when the user wants to publish, deploy, upload, or update a website or static files on Cloudflare, attach a domain to a site, check deploy status, add a Cloudflare API token, or set up Cloudflare credentials.
allowed-tools: Bash(cf-deploy:*), Bash(printf *)
---

# Publish a site to Cloudflare Pages

The `cf-deploy` command (already on PATH) does the work. Run it from the site's folder.

**You run `cf-deploy`, not the user.** Most people asking for this have never opened a
terminal. When the CLI's own output says things like "re-run this command" or "add one
with: cf-deploy ...", that's written for whoever's driving it — which is you. Never paste
a raw `cf-deploy ...` command into a reply and tell the user to run it; run it yourself
when the moment comes, and tell the user what happened in plain language. The one
exception is a step the CLI genuinely can't do for them, like updating nameservers at
their registrar — that's the only kind of thing to hand back to the user as an action
item.

## First, know which account

Credentials live in profiles in `~/.config/cf-deploy/config.json` (file mode 600).
Several Cloudflare accounts can be configured; each site folder remembers which one it
belongs to in a `.cf-deploy.json` written after the first successful publish.

- `cf-deploy profiles` — list configured accounts (tokens shown masked)
- `cf-deploy setup` — create the config file and print token instructions

### Saving a token the user gives you

When the user pastes a Cloudflare API token, save it with **stdin** so it stays out of
the process list and shell history:

```bash
printf '%s' '<token>' | cf-deploy profile set <profile-name> --account-id <id> --token-stdin
```

Add `--default` to make it the default account. Use `personal` as the profile name unless
the user names one.

Rules when handling a token:

- **Never print a token back**, not in confirmations, summaries, or error messages. Refer
  to it as "the token you gave me". `cf-deploy profiles` already masks it.
- **Never pass it via `--token`** — that flag exists but leaks into shell history.
- If the user pastes a token unprompted, just save it and confirm; don't lecture. Mention
  once, briefly, that anything pasted into chat is stored in the conversation history, and
  that they can instead edit `~/.config/cf-deploy/config.json` directly if they'd rather.
- A token that turns out to be wrong should be replaced by re-running `profile set`, not
  by editing files by hand.

### Telling the user how to get a token

If the user doesn't have a token yet, give them these steps — `cf-deploy setup` prints the
same thing, so running it is the easiest way to hand them the instructions.

1. Go to **https://dash.cloudflare.com/?to=/:account/api-tokens** — the **account** API
   tokens page, not the personal one at `/profile/api-tokens`. Account tokens start with
   `cfat_` and are what this tool expects.
2. **Create Token** → **Start from scratch**
3. Build one policy with two resource scopes:

   **Entire Account**
   | Permission | Level | Group |
   |---|---|---|
   | Cloudflare Pages | Edit | Developer Platform |

   **All domains**
   | Permission | Level | Group |
   |---|---|---|
   | Zone | Edit | DNS & Zones |
   | DNS | Edit | DNS & Zones |

4. **Continue to summary** → **Create Token**, then copy it — Cloudflare shows it once.

Two things people get wrong here, worth stating up front if you're walking someone
through it:

- **Zone and DNS are under "All domains", not "Entire Account".** That's why someone
  looking for a "Zone" permission in the account scope won't find one.
- **It must be "All domains", not a named list.** Adding a new domain creates a zone
  that doesn't exist yet, so a policy scoped to specific domains can't create it.

A Global API Key does **not** work; only scoped API tokens support Bearer auth.

**Account ID**: in the dashboard press `Cmd+K` / `Ctrl+K` and search "Copy account ID".
It's also on any domain's Overview page under **API**, and under **Workers & Pages** →
**Account Details**.

If several profiles exist and it's ambiguous which one this site uses, ask the user
before publishing rather than guessing — publishing to the wrong Cloudflare account is
annoying to undo.

## Publishing

```bash
cf-deploy                              # publish current folder
cf-deploy --dir ./site                 # publish a specific folder
cf-deploy --domain example.com         # publish and wire up a domain
cf-deploy --profile client-acme        # pick a specific Cloudflare account
```

Re-running is how updates work: same command, new file contents. The Pages project and
zone are only created once, so repeat runs are safe.

The project name defaults to the remembered one, else a slug of the domain, else a slug
of the folder name. Pass `--project <name>` to override.

**Always report the `https://<project>.pages.dev` URL back to the user.** It works
immediately, even while a custom domain is still propagating.

## Attaching a domain later

```bash
cf-deploy attach-domain --domain example.com
```

Three things can happen, and each needs different handling:

1. **Zone is pending** — the domain is new to Cloudflare. The command prints nameservers.
   Relay them to the user in plain language: they need to set these at their domain's
   registrar, and it usually takes a few hours to propagate. That's the one step only
   they can do.

   **Do not tell the user to run a `cf-deploy` command themselves** — most people using
   this have never opened a terminal. The re-run afterward is your job, not theirs. Tell
   them something like "once you've updated those, just tell me (or ask me to check
   later) and I'll finish connecting the domain" — then, in that later turn, run
   `cf-deploy attach-domain --domain <domain>` yourself. The `.pages.dev` URL still works
   in the meantime, so mention that too.

2. **Domain already has DNS records** — the command refuses and lists them, because the
   domain is already serving something. **Show the user exactly what would be replaced and
   ask them to confirm.** Only re-run with `--replace-dns` after they say yes. Do not add
   that flag on your own initiative.

3. **Success** — DNS is pointed and the domain attached. The certificate takes up to
   ~15 minutes; `cf-deploy status` shows when it goes active.

## Checking state

```bash
cf-deploy status     # this site's project, URL, and domain status
cf-deploy list       # every Pages project and zone on the account
cf-deploy doctor     # what the current token is actually allowed to do
```

## Deleting things

```bash
cf-deploy delete --project <name>              # reports what would go, deletes nothing
cf-deploy delete --project <name> --yes        # actually deletes
cf-deploy delete --domain <domain> --yes       # removes the zone from Cloudflare
```

Without `--yes` the command only prints its plan. **Always run it without `--yes` first,
show the user exactly what it lists, and get their confirmation before re-running with
`--yes`.** Deleting a project destroys its deployment history; deleting a zone removes the
domain from Cloudflare entirely, taking down anything it serves.

Take particular care when the plan marks a zone as `LIVE, currently serving traffic`.

`--domain` matches a zone by exact name only, so `www.example.com` will never resolve to
— and delete — the `example.com` zone.

## What gets uploaded

Everything in the folder except dotfiles (`.env`, `.git`, ...), `node_modules`, `vendor`,
and `__pycache__`. The command aborts outright if it finds an `.env` file, rather than
risk publishing secrets. Cloudflare limits: 25MB per file, 20,000 files.

If the user points this at a folder that also holds source code or config, mention that
everything not excluded becomes publicly readable at the site URL.

## Troubleshooting

- **"credentials rejected"** — the token is wrong, expired, or lacks permissions. It needs
  Account/Cloudflare Pages/Edit, Zone/Zone/Edit, and Zone/DNS/Edit. A Global API Key does
  not work. Offer to save a replacement token (see above); don't echo the old one.
- **Custom domain stuck in "initializing" or "pending"** — usually the certificate still
  being issued; check `cf-deploy status` again in a few minutes.
- **Root URL is blank but files deployed** — the folder has no `index.html`. Pages serves
  `index.html` at the root; other files are reachable by their own paths.
