# Setting up the sbx sandbox

The `sbx` adapter runs each agent in a Docker Sandbox. The agent sees only
the folders the loop mounts (dev-loop and the target repo), reaches only
allowed network hosts, and gets credentials through a proxy that adds them
to each request. The agent never holds a token.

**Access grants are yours.** dev-loop never runs `sbx policy allow`,
`sbx secret set` or `sbx policy approval respond`, and no npm script wraps
them. It prints the command; you decide and type it.

**Opt-in per run.** The project config holds the sbx settings but no
`adapter` line, so a plain run uses no sandbox. Add `--sandbox=sbx`:

```
npm run loop -- --project=webtarsthree --sandbox=sbx --once --stream
```

On macOS, with you at the terminal, that also opens the live dashboard
(`npm run sbx:dashboard`) in a new Terminal window once preflight passes,
unless one is already open. `--no-dashboard` skips it. The first time,
macOS asks whether Terminal may control Terminal: allow it. If the window
can't open, the loop prints why and carries on.

Config keys: [config.md](config.md). First set up on 2026-11-16 against
sbx v0.54.0.

## Commands

| Command | What it does |
|---|---|
| `npm run sbx:status` | sandboxes, secrets (names only), policies, pending approvals, templates |
| `npm run sbx:dashboard` | sbx's live dashboard (`sbx tui`); loop sandboxes appear and disappear here |
| `npm run sbx:preflight` | the loop's startup checks, then exit; touches no ticket |
| `npm run sbx:smoke` | one sandbox built from the loop's create args (dev-loop folder only), one tiny `claude -p` (haiku), then removed; a few cents |
| `npm run sbx:cleanup` | removes this project's leftover `dl-*` sandboxes |
| `npm run sbx:template:build -- --tag=v3` | rebuilds the template from `sandbox/sbx/template.sh` ([templates.md](adapters/sbx/templates.md)) |
| `npm run sandbox:approvals` | what a discover run was refused, with the allow lines to review |

`cleanup`, `smoke` and `template:build` take `-- --project=<name>` (default
`webtarsthree`); `sbx:preflight` is fixed to webtarsthree and passes
`--sandbox=sbx`. The loop runs
`claude -p` headless, so there is no Claude screen to attach to: watch
the dashboard (opened for you) and run the loop with `--stream`.

## 1. Template: node, jq, direnv, the HTTPS rewrite

The kit is a `FROM scratch` mixin, so it can't supply tools. A saved
template does. Build one:

```
sbx policy allow network deb.nodesource.com     # once, yourself
npm run sbx:template:build -- --tag=v1
```

Type `allow` when it asks about the target repo's `.envrc`. Then set
`"template": "docker.io/library/dev-loop-sbx:v1"` in the project's
`sandbox.sbx` block. Packages live in `sandbox/sbx/template.sh`. Updating,
upgrading node and rolling back:
[adapters/sbx/templates.md](adapters/sbx/templates.md).

## 2. GitHub token

```
sbx secret set github      # paste the token; sbx secret ls shows (stored)
```

Used: a fine-grained token, resource owner **fandango**, repos webtarsthree,
catalog-ui-management and catalog-ui-public, expiry 366 days. Permissions:

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | `git push` of the feature branch |
| Pull requests | Read and write | `gh pr create / view / edit / review` |
| Issues | Read and write | the GitHub issue mirror (`gh issue ...`) |
| Actions | Read | read CI runs |
| Commit statuses | Read | `gh pr checks` |
| Metadata | Read | required |

Leave **Workflows** off, so a push that touches `.github/workflows/` is
refused: a free safety net. Leave admin, secrets, variables, environments,
webhooks, deployments, pages and every account permission off.

The org requires approval ("Generate token and request access"). Until it
is approved, private repos answer 404 and preflight says "the sandbox's
GitHub token cannot see ...". Personal repos are out of reach; dev-loop
works only on fandango repos. When the token expires, preflight fails the
same way: renew it and run `sbx secret set github` again.

Alternatives if a fine-grained token is not possible:

- **Host `gh` login:** `sbx secret set github --command '/opt/homebrew/bin/gh auth token'`.
  It works at once, but reaches every repo your `gh` login can reach.
  Only for attended runs.
- **Classic token** with only `repo`: no repo limit either.

**Follow-up:** while the fine-grained token waited for org approval, we
weighed the host `gh` login as a stopgap and chose to wait. If that wait
blocks a run, use the stopgap for attended runs only, then switch back.

## 3. Network: allow GitHub

The sandbox blocks hosts by default. `gh` reports a blocked host as "token
invalid"; the real message is `403 ... Approval required for api.github.com`.
An approval from `sbx policy approval ls` covers only the sandbox that
asked. The loop makes a new sandbox per run, so allow these globally:

```
sbx policy allow network api.github.com,github.com
```

## 4. The kit credential

Run once: `sbx run claude --kit ~/Desktop/Repos/keystone-bedrock-kit ~/Desktop/Repos/dev-loop`,
and choose "Approve all" if asked. If it doesn't ask, it is already
approved. An unapproved credential is silently absent inside the sandbox,
and every run then fails with a gateway auth error (an agent error, not a
park). `npm run sbx:smoke` catches this.

## 5. Model names

The `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` aliases come from the
`env` block of `~/.claude/settings.json` (the source of truth) when the
loop's env lacks them; a value in your shell or `DEVLOOP_ENV_FILE` wins.
Only those three names are read from that file, and their values go into
the sandbox by name (`sbx exec -e NAME`). The sandbox never sees the file.

## 6. Only these folders are visible

The sandbox mounts dev-loop's folder and the target repo, nothing else:
not `~/.zshrc`, `~/.claude`, `~/.ssh`, `~/.aws`, your other projects or
your Desktop. Anything inside the two mounts is readable by the agent, so:

- Keep dev-loop's env file out of the repo:
  `DEVLOOP_ENV_FILE=$HOME/.config/dev-loop/.env`, exported in `~/.zshrc`.
  Preflight **refuses** a `.env`, `.envrc` or `.env.*` (except `*.example`)
  at the top of dev-loop's folder.
- In the target repo, preflight only notes it. webtarsthree's `.envrc` is
  needed: the dev skill runs every command through `direnv exec`. Keep it
  to local dev/INT settings. Preflight also checks that it is allowed
  inside the sandbox (a template rebuild approves it).
- The check covers only the top of each mount. A secret deeper in, such as
  `config/secrets.json`, is not caught.

## 7. Check, then run in discover mode

```
npm run sbx:preflight     # tools, GitHub reachability, env files; free
npm run sbx:smoke         # a real claude -p in a real sandbox; a few cents
```

Preflight's GitHub step names the cause: a firewall approval (`sbx policy
approval ls` or `sbx policy allow network <host>`), token access, or a
template without the HTTPS rewrite.

With `"mode": "discover"`, a blocked host gets a 403 and the run carries on.
Afterwards, `npm run sandbox:approvals` lists each blocked host with a
`sbx policy allow network <host>` line. Review them and run the ones you
approve yourself. webtarsthree installs packages from a private npm
registry (`nexus3.mgo.com`), which will likely show up here. When a run is
clean, switch to `"mode": "enforce"`.

An infra failure (daemon down, prepare failed) parks the ticket and pauses
the worker in both modes.

## 8. Real-case paths

The container is case-sensitive: preflight refuses a mount or cwd whose
case differs from the disk (`.../repos/...` when the disk says `Repos`).
If it comes from `targetRepo.path`, fix the config; if it is the cwd, `cd`
into the real path.

## 9. Atlassian MCP (unverified)

The Atlassian MCP lives in your home Claude config, which is not mounted,
so the agent most likely has no Atlassian tools inside the sandbox.
`sbx create --static-mcp atlassian` (with `sbx mcp add`) may be the fix;
untested. The discover run will show it.
