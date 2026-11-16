# sbx adapter docs

How-to guides for the sbx (Docker Sandboxes) adapter.

- [Setup](../../sandbox-sbx.md): first-time setup, token, network, model
  names, what the sandbox can see, discover then enforce. Moves here next.
- [Templates](templates.md): build, update, roll back the sandbox template.

Commands: `npm run sbx:status | sbx:dashboard | sbx:preflight | sbx:smoke |
sbx:cleanup | sbx:template | sbx:template:build`. None of them grants
access: `sbx policy allow`, `sbx secret set` and approval answers are yours
to type.
