/**
 * tools/check-cache-versions.mjs — did every changed script get its ?v= bumped?
 *
 *   node tools/check-cache-versions.mjs [ref]      (ref defaults to HEAD)
 *
 * WHY THIS EXISTS. Every script in index.html carries a `?v=N` cache-buster, and
 * a browser that already has the page keeps serving the old file until that
 * number moves. Ship a change to model/bracelet.js without bumping it and a
 * returning user runs the NEW subrank.js against the OLD model — no error, no
 * console warning, just wrong scores. It has already happened; two of the last
 * three commits before this tool are manual "bump cache-busters" fixups.
 *
 * The check is exact rather than clever: for every versioned script, compare the
 * file against `ref`. If the file changed and its number did not, say so.
 *
 * Exit 0 when everything is consistent, 1 when a bump is missing, 2 when the
 * repo cannot answer (not a git checkout, no index.html).
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF = process.argv[2] || "HEAD";
const indexPath = join(root, "index.html");

if (!existsSync(indexPath)) {
  console.error("no index.html here — nothing to check");
  process.exit(2);
}

function git(args) {
  // stderr is dropped on purpose: on Windows git warns about CRLF conversion for
  // every file it touches, which would bury the actual answer.
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

let head;
try {
  head = git(["show", REF + ":index.html"]);
} catch (e) {
  console.error("cannot read index.html at " + REF + " — is this a git checkout?");
  process.exit(2);
}

/** path -> version, for every `src="path?v=N"` and every lazy-loaded entry. */
function versions(html) {
  const out = new Map();
  const re = /([A-Za-z0-9_./-]+\.js)\?v=(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) out.set(m[1], Number(m[2]));
  return out;
}

const now = versions(readFileSync(indexPath, "utf8"));
const was = versions(head);

// Files that differ from the ref, including staged and unstaged work.
const changed = new Set(
  git(["diff", REF, "--name-only"]).split("\n").map(s => s.trim()).filter(Boolean)
);

const missing = [], bumped = [], untracked = [];
for (const [path, v] of now) {
  if (!changed.has(path)) continue;
  const old = was.get(path);
  if (old === undefined) { untracked.push(path); continue; }
  if (v === old) missing.push({ path: path, v: v });
  else bumped.push({ path: path, from: old, to: v });
}

// A changed script that index.html does not version at all is worth naming too:
// it either loads some other way or it is dead, and both want a human's eye.
const unversioned = [...changed].filter(f => f.endsWith(".js") && !now.has(f) &&
  !f.startsWith("tools/") && !f.startsWith("worker/") && !f.startsWith("model/") &&
  f !== "verify.js");

for (const b of bumped) console.log("  ok    " + b.path + "  v" + b.from + " -> v" + b.to);
for (const u of untracked) console.log("  new   " + u + "  (not versioned at " + REF + ")");
for (const u of unversioned) console.log("  ?     " + u + "  changed but index.html does not version it");
for (const m of missing) console.log("  MISS  " + m.path + "  changed but still v" + m.v);

if (!missing.length) {
  console.log("\nevery changed script carries a fresh ?v= — safe to deploy");
  process.exit(0);
}
console.log("\n" + missing.length + " script" + (missing.length === 1 ? "" : "s") +
  " changed without a cache-buster bump. Returning browsers would run the old copy" +
  " against the new ones, which shows up as wrong numbers rather than as an error.");
console.log("Bump each in index.html, then rerun.");
process.exit(1);
