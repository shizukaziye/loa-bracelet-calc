/**
 * Fetch lostark.bible character pages into a local corpus.
 *
 * The authorization token is the condition of our access: this script REFUSES to
 * run without one, and sends it on every request. An unauthenticated pull is the
 * thing that gets us 429'd and is never acceptable here.
 *
 * The token is read from $BIBLE_TOKEN or the gitignored .bible-token file. It is
 * never written to disk by this script, never logged, and never committed.
 *
 * Raid-statistics endpoints are off limits — character pages only.
 *
 *   node tools/fetch-characters.mjs <name>[:REGION] ...
 *   node tools/fetch-characters.mjs --file names.txt
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".corpus");
const MIN_GAP_MS = 3000;          // Shizu's floor: at most one page per 3 seconds
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function token() {
  const env = (process.env.BIBLE_TOKEN || "").trim();
  if (env) return env;
  const f = join(ROOT, ".bible-token");
  if (existsSync(f)) {
    const t = readFileSync(f, "utf8").trim();
    if (t) return t;
  }
  console.error(
    "No token. Put it in .bible-token (gitignored) or set BIBLE_TOKEN.\n" +
    "Every request must carry it — refusing to fetch unauthenticated."
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(tok, name, region) {
  const url = `https://lostark.bible/character/${encodeURIComponent(region)}/${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": "Bearer " + tok,
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://lostark.bible/"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });
  return { status: res.status, body: res.status === 200 ? await res.text() : "" };
}

const args = process.argv.slice(2);
let targets = [];
const fileIdx = args.indexOf("--file");
if (fileIdx !== -1) {
  targets = readFileSync(args[fileIdx + 1], "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
} else {
  targets = args;
}
if (!targets.length) { console.error("Nothing to fetch."); process.exit(1); }

const tok = token();
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const have = new Set(readdirSync(OUT).map((f) => f.toLowerCase()));

let last = 0, done = 0, skipped = 0, minGap = Infinity;
for (const t of targets) {
  const [name, regionRaw] = t.split(":");
  const regions = regionRaw ? [regionRaw.toUpperCase()] : ["NA", "CE"];
  let got = false;
  for (const region of regions) {
    const file = `${name}-${region}.html`;
    if (have.has(file.toLowerCase())) { skipped++; got = true; break; }

    // Pace from the START of the previous request, so neither a slow response nor a
    // fast 404 can shorten the gap.
    const wait = last ? Math.max(0, last + MIN_GAP_MS - Date.now()) : 0;
    if (wait) await sleep(wait);
    if (last) minGap = Math.min(minGap, Date.now() - last);
    last = Date.now();

    let r;
    try { r = await fetchPage(tok, name, region); }
    catch (e) { console.log(`  ${name} ${region}: network ${e.message}`); continue; }

    if (r.status === 429 || r.status === 403) {
      console.error(`\nSTOP: ${r.status} on ${name}/${region}. Not retrying.`);
      console.error(`fetched=${done} skipped=${skipped} minGap=${minGap}ms`);
      process.exit(3);                       // a block is a full stop, never a backoff loop
    }
    if (r.status === 200) {
      writeFileSync(join(OUT, file), r.body);
      console.log(`  ${name} ${region}: ok`);
      done++; got = true; break;
    }
    console.log(`  ${name} ${region}: ${r.status}`);
  }
  if (!got) console.log(`  ${name}: not found on ${regions.join("/")}`);
}
console.log(`\nfetched=${done} skipped=${skipped} minGap=${minGap === Infinity ? "n/a" : minGap + "ms"}`);
