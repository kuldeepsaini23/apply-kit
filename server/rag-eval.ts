// Retrieval eval: does the right fact show up in the top k? Compares BM25, vector and hybrid.
// Run: bun rag-eval.ts   (uses "docs" from config.json, or APPLYKIT_DOCS=path1,path2)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Index, type Mode } from "./rag";

const DIR = import.meta.dir;
const cfgFile = existsSync(join(DIR, "config.json")) ? join(DIR, "config.json") : join(DIR, "config.example.json");
const docs: string[] = process.env.APPLYKIT_DOCS?.split(",") ?? JSON.parse(readFileSync(cfgFile, "utf8")).docs ?? [];
if (!docs.length) { console.log("No docs configured (config.json \"docs\" or APPLYKIT_DOCS)."); process.exit(1); }

// Cases: rag-eval.cases.json (private, gitignored) or rag-eval.cases.example.json.
// Each case: question, a regex a relevant chunk must match, and whether it uses the notes' own words or a paraphrase.
const casesFile = existsSync(join(DIR, "rag-eval.cases.json")) ? join(DIR, "rag-eval.cases.json") : join(DIR, "rag-eval.cases.example.json");
const CASES: [string, RegExp, "exact" | "paraphrase"][] = JSON.parse(readFileSync(casesFile, "utf8")).map((c: any) => [c.q, new RegExp(c.match, "i"), c.kind]);

const t0 = Date.now();
const ix = await Index.build(docs, join(DIR, "data", "rag-index.json"));
console.log(`Indexed ${ix.chunks.length} chunks from ${docs.length} path(s) in ${Date.now() - t0}ms\n`);

const K = 5;
const results: Record<Mode, { hit: number; mrr: number; byKind: Record<string, number> }> = {} as any;
for (const mode of ["bm25", "vector", "hybrid"] as Mode[]) {
  const r = { hit: 0, mrr: 0, byKind: { exact: 0, paraphrase: 0 } as Record<string, number> };
  for (const [q, re, kind] of CASES) {
    const hits = await ix.search(q, K, mode);
    const pos = hits.findIndex((h) => re.test(`${h.heading} ${h.text}`));
    if (pos >= 0) { r.hit++; r.mrr += 1 / (pos + 1); r.byKind[kind]++; }
  }
  results[mode] = r;
}
const n = CASES.length, ne = CASES.filter((c) => c[2] === "exact").length, np = n - ne;
console.log(`mode     recall@${K}   MRR    exact-wording  paraphrased`);
for (const [m, r] of Object.entries(results))
  console.log(`${m.padEnd(8)} ${String(Math.round((100 * r.hit) / n)).padStart(5)}%   ${(r.mrr / n).toFixed(2)}   ${r.byKind.exact}/${ne}            ${r.byKind.paraphrase}/${np}`);
