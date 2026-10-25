// Builds ApplyKit.exe: the server, dashboard and tray icon in one file, no Bun or terminal needed.
// Run: bun build-exe.ts   Output: server/ApplyKit.exe (it keeps its data in a data folder next to it).
import { join } from "node:path";

const dir = import.meta.dir;
const out = join(dir, "ApplyKit.exe");
const proc = Bun.spawn([
  process.execPath, "build", join(dir, "server.ts"), "--compile", "--minify",
  "--target=bun-windows-x64",
  "--windows-hide-console",
  `--windows-icon=${join(dir, "icon.ico")}`,
  "--windows-title=Apply Kit",
  // The optional notes search (RAG) loads a large native model library; the exe runs without it.
  "--external", "@huggingface/transformers",
  "--outfile", out,
], { stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);
