// Counts paid or rationed lookups per source per day and month, so free allowances are never exceeded.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Limits = Record<string, { day?: number; month?: number }>;
type Usage = Record<string, { day: number; month: number; dayKey: string; monthKey: string }>;

export class Ledger {
  constructor(private file: string, private limits: Limits) {}

  private read(): Usage {
    const raw: Usage = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7);
    for (const u of Object.values(raw)) {
      if (u.dayKey !== day) { u.day = 0; u.dayKey = day; }
      if (u.monthKey !== month) { u.month = 0; u.monthKey = month; }
    }
    return raw;
  }

  private entry(all: Usage, source: string) {
    const day = new Date().toISOString().slice(0, 10);
    return (all[source] ??= { day: 0, month: 0, dayKey: day, monthKey: day.slice(0, 7) });
  }

  canSpend(source: string): boolean {
    const u = this.entry(this.read(), source), l = this.limits[source] ?? {};
    return (l.day === undefined || u.day < l.day) && (l.month === undefined || u.month < l.month);
  }

  spend(source: string): void {
    const all = this.read(), u = this.entry(all, source);
    u.day++; u.month++;
    writeFileSync(this.file, JSON.stringify(all, null, 1));
  }

  usage(): Record<string, { day: number; month: number }> {
    return Object.fromEntries(Object.entries(this.read()).map(([k, u]) => [k, { day: u.day, month: u.month }]));
  }
}
