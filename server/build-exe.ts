// Builds ApplyKit.exe: the server, dashboard and tray icon in one file, no Bun or terminal needed.
// Run: bun build-exe.ts   Output: server/ApplyKit.exe (it keeps its data in a data folder next to it).
import { readFileSync, writeFileSync } from "node:fs";
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
const code = await proc.exited;
if (code) process.exit(code);

// --windows-hide-console doesn't always stick, and a console exe opens a terminal that quits the app when closed.
// Mark the exe as a windowed (GUI) program: PE optional header Subsystem 3 (console) -> 2 (windows).
const exe = readFileSync(out);
const sub = exe.readUInt32LE(0x3c) + 0x5c;
if (exe.readUInt16LE(sub) === 3) { exe.writeUInt16LE(2, sub); writeFileSync(out, exe); }
console.log("subsystem:", exe.readUInt16LE(sub) === 2 ? "windows (no terminal)" : exe.readUInt16LE(sub));
