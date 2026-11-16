import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const base = join(fileURLToPath(new URL(".", import.meta.url)), "cache");
const exts = new Set([".mp3", ".ogg", ".m4a"]);

const fmt = (n) => {
  for (const u of ["B", "KB", "MB", "GB"]) {
    if (n < 1024) return `${n.toFixed(1)} ${u}`;
    n /= 1024;
  }
  return `${n.toFixed(1)} TB`;
};

let size = 0;
let songs = 0;
for (const name of ["presence", "music"]) {
  try {
    const files = readdirSync(join(base, name)).filter((f) => exts.has(extname(f)));
    const s = files.reduce((a, f) => a + statSync(join(base, name, f)).size, 0);
    size += s;
    songs += files.length;
    console.log(`${name}: ${fmt(s)} (${files.length} songs)`);
  } catch {
    console.log(`${name}: (not found)`);
  }
}
console.log(`total:    ${fmt(size)} (${songs} songs)`);
