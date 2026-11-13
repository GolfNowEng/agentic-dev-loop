# Setting up the sbx sandbox

The `sbx` adapter runs each agent in a Docker Sandbox: it sees only the
folders the loop mounts, reaches only allowed network hosts, and gets
credentials through a proxy. dev-loop never runs `sbx policy allow`,
`sbx secret set`, or approval responses. It prints them; you run them.

Do these in order. Config keys are in [config.md](config.md).

## 1. Kit location and config

The kit lives at `~/Desktop/Repos/keystone-bedrock-kit`. Point the config
at it with an absolute path (write your real home path in the config):

```json
"sandbox": {
  "adapter": "sbx",
  "mode": "discover",
  "sbx": { "kitDir": "/abs/path/to/keystone-bedrock-kit", "memory": "4g" }
}
```

Or turn it on for one run with `--sandbox=sbx` on the command line (the
`sandbox.sbx` block must still exist for `kitDir`).

Set `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` and
`ANTHROPIC_DEFAULT_OPUS_MODEL` in your `DEVLOOP_ENV_FILE`. They are passed
into the sandbox by name; preflight prints a warning naming any that are
unset, because inside the sandbox the `sonnet`/`opus`/`haiku` aliases then
fall back to stock model ids.

## 2. Add node and jq

The loop needs the same node major version inside the sandbox as on the
host, and `jq` (the hooks use it). The kit is a mixin whose dockerfile is
`FROM scratch`, so neither can come from it as it stands. Preflight fails
with "sandbox image has no node N" or "sandbox image has no jq" until this
is done. Two options; you pick (neither is tested yet):

- A saved template: install node and jq in a sandbox, run
  `sbx template save` from it, then pass that template when the sandbox is
  created.
- Extend the kit so it provides node and jq.

## 3. GitHub token

Run `sbx secret set github` with a fine-grained token that covers the
four repos. The agent never sees the token; the proxy injects it.
Without it, preflight fails with "gh is not logged in inside the sandbox".

## 4. SSH remotes (unverified)

The target repos use `git@github.com:` remotes, and `~/.ssh` is not
mounted, so `git push` / `git fetch` inside the sandbox fail. The fix is
an HTTPS rewrite baked into the template or kit, alongside node and jq:

```
git config --global url."https://github.com/".insteadOf git@github.com:
```

Then git uses the token from `sbx secret set github` (step 3). This has
not been tried yet.

## 5. Approve the kit credential (required, before the first loop run)

Before the first loop run, run this once by hand and choose "Approve all":

```
sbx run claude --kit <kitDir> <any dir>
```

An unapproved credential is silently absent inside the sandbox. Every run
then fails with a gateway auth error, recorded as an agent error. It does
**not** park, so `npm run sandbox:approvals` will not show it, and
preflight does not catch it yet.

## 6. Run in discover mode first

With `"mode": "discover"` a blocked host gets an HTTP 403 and the run
carries on. Afterwards:

```
npm run sandbox:approvals
```

Discover-mode runs carry on, so they are listed under "Discovered in
discover mode (not parked)", with each blocked host and a line like
`sbx policy allow network example.org`. There is nothing to clear for
them. Read each one and decide yourself which to run. Then switch to
`"mode": "enforce"`.

An infra failure (the sandbox itself failed: daemon down, prepare failed)
parks the ticket and pauses the worker in both modes.

## 7. Real-case paths

sbx fixes the case of a mounted path, but the container is
case-sensitive, so preflight refuses any mount or cwd whose case differs
from the disk ("sandbox paths must match the disk's real case"). `npm run`
starts from the repo root's real case, so the realistic cause is a
wrong-case `targetRepo.path` in the config (`.../repos/...` when the disk
says `Repos`); the message then adds "if it comes from targetRepo.path,
fix the case in the config". If it is the cwd, `cd` into the real-case
path and restart.

## 8. Atlassian MCP (unverified)

The Atlassian MCP is configured in your home Claude config, which is not
mounted. Inside the sandbox the agent most likely has no Atlassian tools
at all. This will not show up in the approvals list: check the run's
output for missing-tool or permission errors. The likely fix is a
project-level `.mcp.json` or a kit-level MCP config, or having the host
post the Jira comments (spec §4.7).
