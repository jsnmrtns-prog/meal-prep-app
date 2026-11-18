/**
 * Weight-change factors (public/data/yields.json, built by scripts/build_yields.py).
 * Used for purchase amounts and container weights only, never for nutrition.
 */
export type YieldKind = "cook" | "bone" | "hydration";

export interface YieldEntry {
  id: string;
  kind: YieldKind;
  description: string;
  method: string;
  /** Weight after ÷ weight before × 100. Hydration yields exceed 100. */
  percent: number;
  min: number | null;
  max: number | null;
  samples: number | null;
  source: string;
  ref: string;
}

export interface YieldsFile {
  schema: number;
  sources: Record<string, { citation: string; file?: string; sha256?: string }>;
  entries: YieldEntry[];
}

export class YieldDb {
  private readonly byId = new Map<string, YieldEntry>();
  readonly sources: YieldsFile["sources"];

  constructor(file: YieldsFile) {
    if (file.schema !== 1) throw new Error(`Unsupported yields schema ${file.schema}`);
    this.sources = file.sources;
    for (const e of file.entries) {
      if (!(e.percent > 0)) throw new Error(`Yield ${e.id} has no valid percent`);
      if (this.byId.has(e.id)) throw new Error(`Duplicate yield ${e.id}`);
      this.byId.set(e.id, e);
    }
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): YieldEntry {
    const e = this.byId.get(id);
    if (!e) throw new Error(`Yield ${id} not found`);
    return e;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(kind?: YieldKind): YieldEntry[] {
    return [...this.byId.values()].filter((e) => !kind || e.kind === kind);
  }

  citation(entry: YieldEntry): string {
    return this.sources[entry.source]?.citation ?? entry.source;
  }
}
