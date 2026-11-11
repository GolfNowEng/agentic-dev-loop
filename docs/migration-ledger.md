# dev-loop 2.0.0 migration ledger

One row per divergence found while unifying `src/core/` between dev-loop and
research-loop (Task 3). Classes: (a) one-sided fix, both get it; (b) role
difference, becomes a parameter / role setting / moves under `roles/`;
(c) unknown, escalated.

| file | divergence | class | evidence (commit/changelog entry) |
|---|---|---|---|
| claude-usage | none (src and tests identical modulo import path) | no divergence | `diff research-loop/src/claude-usage.ts src/core/claude-usage.ts` empty; shared history 18aa955/88d3938 |
| run-dirs | none (src and tests identical modulo import path) | no divergence | `diff research-loop/src/run-dirs.ts src/core/run-dirs.ts` empty; shared history 18aa955/88d3938 |
