/**
 * Extracts real cost/token usage from `claude -p --output-format json`'s
 * stdout (already JSON.parse'd). Purely defensive: any malformed or
 * missing field yields zeros rather than throwing -- a usage-parsing bug
 * must never crash the loop, and ceilings.ts already treats 0 cost as
 * "cannot judge, don't breach," never as a bypass (a genuinely free run is
 * indistinguishable from a malformed report, and neither should pause the
 * loop on its own).
 */

export interface UsageResult {
  costUsd: number;
  tokens: { in: number; out: number };
}

const ZERO_USAGE: UsageResult = { costUsd: 0, tokens: { in: 0, out: 0 } };

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Parse the confirmed `claude -p --output-format json` shape:
 * `{ total_cost_usd, usage: { input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens } }`. `tokens.in`
 * combines every input-side field the CLI reports (plain input plus both
 * cache variants); `tokens.out` is `output_tokens` alone.
 */
export function extractUsage(raw: unknown): UsageResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ZERO_USAGE;
  }
  const root = raw as Record<string, unknown>;

  const costUsd = numberOrZero(root.total_cost_usd);

  const usage =
    typeof root.usage === "object" && root.usage !== null && !Array.isArray(root.usage)
      ? (root.usage as Record<string, unknown>)
      : {};

  const tokensIn =
    numberOrZero(usage.input_tokens) +
    numberOrZero(usage.cache_creation_input_tokens) +
    numberOrZero(usage.cache_read_input_tokens);
  const tokensOut = numberOrZero(usage.output_tokens);

  return { costUsd, tokens: { in: tokensIn, out: tokensOut } };
}
