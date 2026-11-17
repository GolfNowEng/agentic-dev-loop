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
  // Details sit under the Step column and wrap before Action, so they read as notes on their row.
  const indent = widths[0]! + 2 + widths[1]! + 2;
  const room = Math.max(20, widths[2]! + 2 + widths[3]! - 2);
  const lines = [title, "", fmt(header)];
  rows.forEach((r, i) => {
    lines.push(fmt(body[i]!));
    for (const d of r.survey.details ?? []) {
      wrap(d, room).forEach((part, j) => lines.push(`${" ".repeat(indent)}${j === 0 ? "↳ " : "  "}${part}`));
    }
  });
  return lines.join("\n");
}

/** Split on spaces into lines of at most `width` chars; a single longer word is cut. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    for (let w = word; w !== ""; ) {
      const next = line === "" ? w : `${line} ${w}`;
      if (next.length <= width) {
        line = next;
        w = "";
      } else if (line === "") {
        out.push(w.slice(0, width));
        w = w.slice(width);
      } else {
        out.push(line);
        line = "";
      }
    }
  }
  if (line !== "") out.push(line);
  return out.length > 0 ? out : [""];
}
