// Builds the hosted dashboard: a static copy of dashboard.html + ui.css in ../site, ready for Vercel.
// It holds no data; it talks to each visitor's own local helper through the extension.
// Run: bun run build:site   then deploy the site/ folder.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dir, "..", "site");
mkdirSync(out, { recursive: true });
const html = readFileSync(join(import.meta.dir, "dashboard.html"), "utf8").replace('href="/ui.css"', 'href="ui.css"');
writeFileSync(join(out, "index.html"), html);
copyFileSync(join(import.meta.dir, "..", "ui.css"), join(out, "ui.css"));
writeFileSync(join(out, "vercel.json"), JSON.stringify({
  headers: [{ source: "/(.*)", headers: [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Frame-Options", value: "DENY" },
  ] }],
}, null, 2));
console.log("site/ built:", out);
