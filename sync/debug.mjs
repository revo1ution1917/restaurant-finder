#!/usr/bin/env node
// Diagnostic: inspect the fetched list HTML to understand its structure.
// Prints structure info only — safe for public logs.
import { readFileSync, existsSync } from "node:fs";

const f = process.env.HTML_FILE || "/tmp/list.html";
if (!existsSync(f)) {
  console.log(`no file at ${f}`);
  process.exit(0);
}
const html = readFileSync(f, "utf8");
console.log(`file: ${html.length} bytes`);

const idx = html.indexOf("window.APP_INITIALIZATION_STATE=");
console.log(`APP_INITIALIZATION_STATE at: ${idx}`);

// All )]}'-prefixed payload markers in the raw HTML
const payloadRe = /\)\]\}'/g;
let m, positions = [];
while ((m = payloadRe.exec(html))) positions.push(m.index);
console.log(`")]}'": ${positions.length} occurrence(s) at ${positions.slice(0, 10).join(",")}`);
for (const p of positions.slice(0, 5)) {
  console.log(`  ctx@${p}: ${JSON.stringify(html.slice(p, p + 160))}`);
}

// Keywords that hint where the list data lives or how it loads
for (const kw of ["entitylist", "getlist", "placelists", "ListId", "APP_OPTIONS", "window.IJ_values", "ucbcb"]) {
  const count = html.split(kw).length - 1;
  console.log(`"${kw}": ${count}`);
  if (count > 0 && count < 50) {
    const i = html.indexOf(kw);
    console.log(`  first ctx: ${JSON.stringify(html.slice(Math.max(0, i - 80), i + 200))}`);
  }
}

// Coordinate-looking pairs (lat,lng around London = 51.x, -0.x)
const coordRe = /51\.\d{4,},\s*-0\.\d{4,}/g;
const coords = html.match(coordRe) || [];
console.log(`London-like coord pairs: ${coords.length}`);
if (coords.length) {
  const i = html.indexOf(coords[0]);
  console.log(`  first ctx: ${JSON.stringify(html.slice(Math.max(0, i - 200), i + 200))}`);
}

// Script tags inventory
const scripts = html.match(/<script[^>]*>/g) || [];
console.log(`script tags: ${scripts.length}`);
console.log(scripts.slice(0, 12).join("\n"));
