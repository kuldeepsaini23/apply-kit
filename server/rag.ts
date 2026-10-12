// Retrieval over your own notes (markdown), so Claude answers from the right facts.
// Hybrid search: BM25 keyword scores + vector similarity from a local embedding model
// (all-MiniLM-L6-v2 via transformers.js, runs on CPU, no API), merged with reciprocal rank fusion.
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

export type Chunk = { id: number; source: string; heading: string; text: string; tokens: string[]; vec: Float32Array | null };
export type Mode = "bm25" | "vector" | "hybrid";
export type Hit = Chunk & { score: number };

const MODEL = "Xenova/all-MiniLM-L6-v2";
const STOP = new Set("a an and are as at be but by for from has have he her his i if in into is it its me my of on or our she so than that the their them then there these they this to was we were what when which who will with you your how did do does about can".split(" "));

export const tokenize = (s: string) =>
  (s.toLowerCase().match(/[a-z0-9][a-z0-9.+#@/-]*[a-z0-9+#]|[a-z0-9]/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

// Split markdown by headings, then into ~900-char windows with overlap so facts aren't cut in half.
export function chunkMarkdown(source: string, md: string, max = Number(process.env.RAG_CHUNK ?? 600), overlap = Math.round(max / 6)) {
  const out: { source: string; heading: string; text: string }[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (body.length < 40) return;
    for (let i = 0; i < body.length; i += max - overlap) {
      const piece = body.slice(i, i + max);
      if (piece.trim().length > 40) out.push({ source, heading, text: piece });
      if (i + max >= body.length) break;
    }
  };
  for (const line of md.replace(/\r/g, "").split("\n")) {
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) { flush(); heading = h[1].trim(); } else buf.push(line);
  }
  flush();
  return out;
}

let embedder: any = null;
async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!embedder) {
    const { pipeline } = await import("@huggingface/transformers");
    embedder = await pipeline("feature-extraction", MODEL, { dtype: "fp32" });
  }
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const t = await embedder(texts.slice(i, i + 32), { pooling: "mean", normalize: true });
    const [n, d] = t.dims;
    for (let j = 0; j < n; j++) out.push(Float32Array.from(t.data.slice(j * d, (j + 1) * d)));
  }
  return out;
}

function listFiles(paths: string[]) {
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) { if (f.endsWith(".md")) files.push(join(p, f)); }
    else files.push(p);
  }
  return files.sort();
}

export class Index {
  chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgdl = 0;

  static async build(paths: string[], cacheFile?: string) {
    const files = listFiles(paths);
    const sig = MODEL + "|" + (process.env.RAG_CHUNK ?? 600) + "|" + files.map((f) => `${f}:${statSync(f).mtimeMs}`).join("|");
    const ix = new Index();
    const raw = files.flatMap((f) => chunkMarkdown(basename(f), readFileSync(f, "utf8")));
    ix.chunks = raw.map((c, id) => ({ id, ...c, tokens: tokenize(`${c.heading} ${c.text}`), vec: null }));
    // Reuse cached vectors when the files haven't changed.
    let vecs: Float32Array[] | null = null;
    if (cacheFile && existsSync(cacheFile)) {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (cached.sig === sig && cached.vecs.length === ix.chunks.length) vecs = cached.vecs.map((v: number[]) => Float32Array.from(v));
    }
    if (!vecs) {
      vecs = await embed(ix.chunks.map((c) => `${c.heading}\n${c.text}`));
      if (cacheFile) writeFileSync(cacheFile, JSON.stringify({ sig, vecs: vecs.map((v) => Array.from(v, (x) => +x.toFixed(5))) }));
    }
    ix.chunks.forEach((c, i) => (c.vec = vecs![i]));
    for (const c of ix.chunks) for (const t of new Set(c.tokens)) ix.df.set(t, (ix.df.get(t) ?? 0) + 1);
    ix.avgdl = ix.chunks.reduce((n, c) => n + c.tokens.length, 0) / Math.max(1, ix.chunks.length);
    return ix;
  }

  private bm25(query: string, k1 = 1.2, b = 0.75) {
    const q = [...new Set(tokenize(query))];
    const N = this.chunks.length;
    return this.chunks.map((c) => {
      const tf = new Map<string, number>();
      for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let s = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.tokens.length) / this.avgdl)));
      }
      return s;
    });
  }

  async search(query: string, k = 6, mode: Mode = "hybrid"): Promise<Hit[]> {
    const rank = (scores: number[]) => scores.map((s, i) => [i, s] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([i]) => i);
    let order: number[];
    let score: Map<number, number>;
    if (mode === "bm25") {
      const s = this.bm25(query); order = rank(s); score = new Map(order.map((i) => [i, s[i]]));
    } else {
      const [qv] = await embed([query]);
      const cos = this.chunks.map((c) => { let d = 0; for (let j = 0; j < qv.length; j++) d += qv[j] * c.vec![j]; return d; });
      if (mode === "vector") { order = rank(cos); score = new Map(order.map((i) => [i, cos[i]])); }
      else {
        // Reciprocal rank fusion: robust to the two scores being on different scales.
        const rrf = new Map<number, number>();
        for (const list of [rank(this.bm25(query)), rank(cos)]) list.slice(0, 50).forEach((i, r) => rrf.set(i, (rrf.get(i) ?? 0) + 1 / (60 + r)));
        order = [...rrf.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
        score = rrf;
      }
    }
    return order.slice(0, k).map((i) => ({ ...this.chunks[i], score: score.get(i) ?? 0 }));
  }
}

// Format hits for a prompt, with the source so Claude can stay grounded.
export const asContext = (hits: Hit[]) =>
  hits.map((h, i) => `[${i + 1}] (${h.source} › ${h.heading || "notes"})\n${h.text.trim()}`).join("\n\n");
