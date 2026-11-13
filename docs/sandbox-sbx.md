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

## 2. Add node

The loop needs the same node major version inside the sandbox as on the
host. The kit is a mixin whose dockerfile is `FROM scratch`, so node
cannot come from it as it stands. Preflight fails with "sandbox image has
no node N" until this is done. Two options; you pick (neither is tested yet):

- A saved template: install node in a sandbox, run `sbx template save`
  from it, then pass that template when the sandbox is created.
- Extend the kit so it provides node.

## 3. GitHub token

Run `sbx secret set github` with a fine-grained token that covers the
four repos. The agent never sees the token; the proxy injects it.
Without it, preflight fails with "gh is not logged in inside the sandbox".

## 4. One-time credential approval

The first sandboxed run may ask for a credential approval. If a run parks
for this, `npm run sandbox:approvals` shows what to approve. Approve it
yourself, then `--clear=<KEY>`.

## 5. Run in discover mode first

With `"mode": "discover"` a blocked host gets an HTTP 403 and the run
carries on. Afterwards:

```
npm run sandbox:approvals
```

It lists each blocked host with a line like `sbx policy allow network
example.org`. Read each one and decide yourself which to run. Then switch
to `"mode": "enforce"`.

## 6. Start from the real-case path

sbx fixes the case of a mounted path, but the container is
case-sensitive. A shell cd'd into `.../repos/...` when the disk says
`Repos` is refused at preflight ("sandbox paths must match the disk's
real case"). `cd` into the real-case path and restart.

## 7. Atlassian MCP

Whether the Atlassian MCP works inside the sandbox is unverified. The
discover run will show it: look for blocked Atlassian hosts in the
approvals list.
