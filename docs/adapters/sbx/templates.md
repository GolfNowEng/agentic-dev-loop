# sbx templates: build, update, roll back

A template is a saved sandbox disk that every loop sandbox starts from. It
holds what the kit can't supply (the kit is a `FROM scratch` mixin): node,
jq, direnv, git settings, and your approval of the target repo's `.envrc`.

## Where it lives

Only on your Mac, in sbx's local image store (`sbx template ls`). It is not
in a repo and nothing is pushed. A sandbox is three layers:

| Layer | What | Changed by |
|---|---|---|
| Base image | sbx's stock Claude image | sbx upgrades |
| **Template** (`dev-loop-sbx:vN`) | our packages and settings | `npm run sbx:template:build` |
| Kit (`keystone-bedrock-kit`) | Bedrock network rule and login | never by us; applied on top at each create |

Your repos are not in the template: dev-loop and the target repo are
mounted live from your Mac.

## The recipe: `sandbox/sbx/template.sh`

Everything installed into a template is in that one script, which runs
inside the build sandbox. To add a package, add a line under
`# --- packages`, then rebuild.

## Rebuild (any change)

```
npm run sbx:template:build -- --tag=v3
```

1. Creates a build sandbox from the kit, with dev-loop and the target repo
   mounted at their real paths.
2. Runs `template.sh` inside it, with the node major from the shell you
   run it in (override with `--node=26`).
3. For each target repo with an `.envrc`, asks you to type `allow`. That
   is your direnv approval, baked into the template. With no terminal (an
   agent, a pipe), it never allows.
4. Stops the sandbox, saves `dev-loop-sbx:v3`, and removes the build
   sandbox, even when a step fails.

It refuses a tag that already exists, so the old one stays for rollback.

Then:

1. Set `"template": "docker.io/library/dev-loop-sbx:v3"` in the project's
   `sandbox.sbx` block.
2. Run `npm run sbx:preflight && npm run sbx:smoke`.

If a host is blocked during the build (a new apt source, for example), the
build fails and says so. Review the host with `npm run sbx:status`, allow it
yourself (`sbx policy allow network <host>`), and rerun.

## When to rebuild

| Trigger | How you find out |
|---|---|
| Add a tool or package | you decide; edit `template.sh` |
| The project moves to a new node major | preflight: "sandbox image has no node N". Run `nvm use N` on the host first, then build with `--node=N` |
| The target repo's `.envrc` changed | preflight: "the target repo's .envrc is not allowed inside the sandbox" |
| A new target repo with an `.envrc` | same message, from its first preflight |

## Roll back

Point `template` at the previous tag. Delete old tags once a newer one has
done a real run: `sbx template rm docker.io/library/dev-loop-sbx:v1`.

## Gotchas from the first builds

- Inside the sandbox `~` is `/home/agent`, not your home folder. Mounted
  repos are at their full Mac path.
- The image has no pager: `git config --get-regexp` fails with "unable to
  execute pager" until `core.pager cat` is set (`template.sh` sets it).
- Don't use Debian's own `nodejs`: it is node 20.
- `sbx template save` stops a running sandbox first; the build does that
  for you.
- `deb.nodesource.com` must be allowed once:
  `sbx policy allow network deb.nodesource.com`.
