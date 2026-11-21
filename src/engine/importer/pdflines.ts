/**
 * Rebuilds lines of text from the positioned text pieces a PDF reader gives
 * (pdf.js getTextContent). Pieces on the same baseline are joined left to
 * right; columns are read left column first when the page clearly has two.
 */
export interface TextPiece {
  str: string;
  /** Left edge and baseline, in PDF units (y grows upward). */
  x: number;
  y: number;
  width: number;
  height: number;
}

import { isSectionHeading } from "./parse.ts";

interface Row {
  y: number;
  height: number;
  pieces: TextPiece[];
}

function rowText(pieces: TextPiece[]): string {
  const sorted = [...pieces].sort((a, b) => a.x - b.x);
  let text = "";
  let end = Number.NEGATIVE_INFINITY;
  for (const p of sorted) {
    const gap = p.x - end;
    if (text && gap > Math.max(1, p.height * 0.15) && !/\s$/.test(text) && !/^\s/.test(p.str)) text += " ";
    text += p.str;
    end = p.x + p.width;
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Lines of text in reading order. Where part of a page is laid out in two
 * columns (common for ingredient lists), the left column is read before the
 * right one, band by band (three or more columns work the same way).
 */
export function piecesToLines(pages: TextPiece[][]): string[] {
  const out: string[] = [];
  for (const pieces of pages) {
    const items = pieces.filter((p) => p.str.trim() !== "");
    if (items.length === 0) continue;
    // Rows: pieces on the same baseline.
    const rows: Row[] = [];
    for (const p of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const last = rows.at(-1);
      if (last && Math.abs(last.y - p.y) <= Math.max(2, Math.min(p.height, last.height) * 0.4)) last.pieces.push(p);
      else rows.push({ y: p.y, height: p.height, pieces: [p] });
    }
    // Where several rows start at the same place, right of the page's left edge, a column starts there.
    // A narrow gutter (a web page printed to PDF) is still a column break at one of those places.
    const starts = new Map<number, number>();
    for (const r of rows) {
      const x0 = Math.round(Math.min(...r.pieces.map((p) => p.x)));
      starts.set(x0, (starts.get(x0) ?? 0) + 1);
    }
    const leftEdge = Math.min(...starts.keys());
    const columnStarts = [...starts].filter(([x, n]) => n >= 4 && x > leftEdge + 40).map(([x]) => x);
    /** Where a row splits into columns: the start of each piece after a wide gap. */
    const splitsOf = (r: Row): number[] => {
      const s = [...r.pieces].filter((p) => p.str.trim() !== "").sort((a, b) => a.x - b.x);
      const xs: number[] = [];
      for (let k = 1; k < s.length; k++) {
        const gap = s[k]!.x - (s[k - 1]!.x + s[k - 1]!.width);
        if (gap > Math.max(15, s[k]!.height * 1.5) || (gap > 8 && !/^[•z\-–*»·o▪■●]$/.test(s[k - 1]!.str.trim()) && columnStarts.some((c) => Math.abs(c - s[k]!.x) <= 3))) xs.push(s[k]!.x);
      }
      return xs;
    };
    // A piece that runs well past a split belongs to full-width text (a small overrun is a long ingredient).
    const crossesAt = (r: Row, x: number) => r.pieces.some((p) => p.x < x - 3 && p.x + p.width > x + Math.max(10, p.height * 2));
    let i = 0;
    let prevY = Number.NaN;
    while (i < rows.length) {
      const r = rows[i]!;
      if (!Number.isNaN(prevY) && prevY - r.y > r.height * 1.8) out.push("");
      const first = splitsOf(r);
      if (first.length > 0 && !(first.length === 1 && isSectionHeading(rowText(r.pieces)))) {
        // A band of columns runs until a row crosses a split, a main heading appears, or there's a big gap.
        // Columns can be two, three or more ("Chicken:  Veggies:  Tacos:").
        const splits = [...first];
        const band: Row[] = [r];
        i++;
        while (i < rows.length) {
          const next = rows[i]!;
          if (splits.some((x) => crossesAt(next, x)) || isSectionHeading(rowText(next.pieces))) break;
          if (band.at(-1)!.y - next.y > next.height * 3) break;
          for (const x of splitsOf(next)) {
            // A column that first shows up lower down (the row above had nothing in it).
            // Columns are never this narrow: a nearby split is a bullet and its text, not a new column.
            if (splits.some((s) => Math.abs(s - x) < 40)) continue;
            if (band.some((b) => crossesAt(b, x))) continue;
            splits.push(x);
          }
          band.push(next);
          i++;
        }
        splits.sort((a, b) => a - b);
        const bounds = [Number.NEGATIVE_INFINITY, ...splits.map((x) => x - 3), Number.POSITIVE_INFINITY];
        for (let c = 0; c + 1 < bounds.length; c++) {
          let any = false;
          for (const row of band) {
            const part = row.pieces.filter((p) => p.x >= bounds[c]! && p.x < bounds[c + 1]!);
            if (part.length) {
              out.push(rowText(part));
              any = true;
            }
          }
          if (any) out.push("");
        }
        prevY = band.at(-1)!.y;
        continue;
      }
      out.push(rowText(r.pieces));
      prevY = r.y;
      i++;
    }
    out.push("");
  }
  return out;
}
