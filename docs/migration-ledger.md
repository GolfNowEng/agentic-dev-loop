# dev-loop 2.0.0 migration ledger

One row per divergence found while unifying `src/core/` between dev-loop and
research-loop (Task 3). Classes: (a) one-sided fix, both get it; (b) role
difference, becomes a parameter / role setting / moves under `roles/`;
(c) unknown, escalated.

| file | divergence | class | evidence (commit/changelog entry) |
|---|---|---|---|
| claude-usage | none (src and tests identical modulo import path) | no divergence | `diff research-loop/src/claude-usage.ts src/core/claude-usage.ts` empty; shared history 18aa955/88d3938 |
| run-dirs | none (src and tests identical modulo import path) | no divergence | `diff research-loop/src/run-dirs.ts src/core/run-dirs.ts` empty; shared history 18aa955/88d3938 |
| reset-project | header comment: dev says "dev-loop's own local state", research says "this repo's own local state" (no behavior difference; paths come from config) | (a) one-sided wording fix: take research's role-neutral comment | `diff research-loop/src/reset-project.ts src/core/reset-project.ts` = lines 1-2 only; research tests (same 29 case names, research-loop fixture paths/label) pass unchanged against dev src |
