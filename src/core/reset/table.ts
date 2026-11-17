import type { SurveyedRow } from "./step.ts";

const FOUND_MAX = 48;

function truncate(s: string): string {
  return s.length > FOUND_MAX ? `${s.slice(0, FOUND_MAX - 1)}…` : s;
}

function actionCell(row: SurveyedRow, status?: Map<SurveyedRow, string>): string {
  const st = status?.get(row);
  if (st !== undefined) return st === "done" ? "done" : st.startsWith("failed") ? st : `failed: ${st}`;
  if (row.error) return `needs you: ${row.error}`;
  if (row.survey.needsYou) return `needs you: ${row.survey.needsYou}`;
  return row.survey.action ?? "-";
}

export function renderTable(
  title: string,
  rows: SurveyedRow[],
  status?: Map<SurveyedRow, "done" | string>,
): string {
  const header = ["#", "Area", "Step", "Found", "Action"];
  const body = rows.map((r, i) => [
    String(i + 1),
    r.step.area,
    r.step.name,
    truncate(r.survey.found),
    actionCell(r, status),
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...body.map((b) => b[c]!.length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((cell, c) => (c === 0 ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!)))
      .join("  ")
      .trimEnd();
  const lines = [title, "", fmt(header)];
  rows.forEach((r, i) => {
    lines.push(fmt(body[i]!));
    for (const d of r.survey.details ?? []) lines.push(`      ${d}`);
  });
  return lines.join("\n");
}
