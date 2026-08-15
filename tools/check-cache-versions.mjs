/**
 * tools/check-cache-versions.mjs — did every changed script get its ?v= bumped,
 * and does every OTHER stamped reference agree with index.html?
 *
 *   node tools/check-cache-versions.mjs [ref]      (ref defaults to HEAD)
 *
 * WHY THIS EXISTS. Every script tag carries a `?v=N` cache-buster, and a browser
 * that already has the page keeps serving the old file until that number moves.
 * Ship a change to model/bracelet.js without bumping it and a returning user runs
 * the NEW subrank.js against the OLD model — no error, no console warning, just
 * wrong scores. It had happened twice before this tool existed.
 *
 * TWO CLASSES OF FAILURE, both real incidents:
 *
 *   MISS      a script changed but its ?v= did not, so a returning browser keeps
 *             the old copy.
 *   CONFLICT  a script OUTSIDE index.html — solver-worker.js's importScripts,
 *             app.js's `new Worker(...)` — stamps the same file at a DIFFERENT
 *             version than index.html. Locally both resolve to the same bytes,
 *             so nothing looks wrong; deployed, they are two cache entries, and
 *             the solver ran model 0.2.0 under a 0.3.0 page for one commit. The
 *             Advisor's verdicts and the Calculator's headline would have
 *             disagreed silently. That is why every root script is scanned, not
 *             just the page.
 *
 * Exit 0 when everything is consistent, 1 on any MISS or CONFLICT, 2 when the
 * repo cannot answer (not a git checkout, no index.html).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

/** path -> version, for every literal `path.js?v=N` in the text. */
function versions(text) {
  const out = new Map();
  const re = /([A-Za-z0-9_./-]+\.js)\?v=(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.set(m[1], Number(m[2]));
  return out;
}

const now = versions(readFileSync(indexPath, "utf8"));
const was = versions(head);

// Files that differ from the ref, including staged and unstaged work.
const changed = new Set(
  git(["diff", REF, "--name-only"]).split("\n").map(s => s.trim()).filter(Boolean)
);

const missing = [], bumped = [], untracked = [], conflicts = [];

// ---- rule 1: a changed, page-versioned script must carry a fresh stamp ------
for (const [path, v] of now) {
  if (!changed.has(path)) continue;
  const old = was.get(path);
  if (old === undefined) { untracked.push(path); continue; }
  if (v === old) missing.push({ path: path, v: v, where: "index.html" });
  else bumped.push({ path: path, from: old, to: v });
}

// ---- rule 2: every stamped reference in every root script agrees ------------
// Root scripts only: tools/ never ships, worker/ deploys through wrangler, and
// ocr/ files are stamped at load time rather than literally (rule 3).
const rootScripts = readdirSync(root).filter(f => f.endsWith(".js"));
const refCache = new Map();
function refsAt(src) {
  if (!refCache.has(src)) {
    try { refCache.set(src, versions(git(["show", REF + ":" + src]))); }
    catch (e) { refCache.set(src, new Map()); }
  }
  return refCache.get(src);
}
const stampedAnywhere = new Set();
for (const src of rootScripts) {
  const refs = versions(readFileSync(join(root, src), "utf8"));
  for (const [path, v] of refs) {
    if (path === src) continue;                       // a file naming itself
    stampedAnywhere.add(path);
    const pageV = now.get(path);
    if (pageV !== undefined) {
      if (v !== pageV) conflicts.push({ where: src, path: path, v: v, pageV: pageV });
      continue;
    }
    // A stamped file the page does not version (solver-worker.js itself): the
    // referencing site is its version authority, so the changed-without-bump
    // rule applies there.
    if (changed.has(path)) {
      const old = refsAt(src).get(path);
      if (old !== undefined && old === v) missing.push({ path: path, v: v, where: src });
      else if (old !== undefined) bumped.push({ path: path, from: old, to: v });
    }
  }
}

// ---- rule 3: the OCR stack versions on advisor-capture's VERSION constant ---
// ocr/*.js load at ?v=<VERSION> built at runtime, which the literal scan cannot
// see. If any ocr file changed, that constant has to move with it.
const capFile = "advisor-capture.js";
if (existsSync(join(root, capFile))) {
  const capNow = /VERSION = "(\d+)"/.exec(readFileSync(join(root, capFile), "utf8"));
  const ocrChanged = [...changed].filter(f => f.startsWith("ocr/") && f.endsWith(".js"));
  if (capNow && ocrChanged.length) {
    let capWas = null;
    try { capWas = /VERSION = "(\d+)"/.exec(git(["show", REF + ":" + capFile])); }
    catch (e) { capWas = null; }
    if (capWas && capWas[1] === capNow[1]) {
      missing.push({ path: ocrChanged.join(", "), v: capNow[1], where: capFile + " VERSION constant" });
    }
  }
}

// A changed script that nothing versions at all is worth naming too: it either
// loads some other way or it is dead, and both want a human's eye.
const unversioned = [...changed].filter(f => f.endsWith(".js") && !now.has(f) &&
  !stampedAnywhere.has(f) &&
  !f.startsWith("tools/") && !f.startsWith("worker/") && !f.startsWith("model/") &&
  !f.startsWith("ocr/") && f !== "verify.js");

for (const b of bumped) console.log("  ok    " + b.path + "  v" + b.from + " -> v" + b.to);
for (const u of untracked) console.log("  new   " + u + "  (not versioned at " + REF + ")");
for (const u of unversioned) console.log("  ?     " + u + "  changed but nothing versions it");
for (const m of missing) console.log("  MISS  " + m.path + "  changed but still v" + m.v + "  [" + m.where + "]");
for (const c of conflicts) console.log("  CONFLICT  " + c.where + " stamps " + c.path + " at v" + c.v +
  " while index.html says v" + c.pageV);

// ---- rule 4: misses already COMMITTED but not yet pushed --------------------
// The rules above diff the worktree against HEAD, so a commit that changed a
// script without its bump becomes invisible the moment it lands — which is
// exactly how model/bracelet.js shipped commit ea56a91 at a stale v11 and was
// only caught by an agent watching the worker return the old shape. When an
// upstream exists and HEAD is ahead of it, the same check runs again with the
// COMMITTED tree as "now" and the upstream as the ref.
let upstream = null;
try { upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim(); } catch (e) {}
if (upstream) {
  let ahead = 0;
  try { ahead = Number(git(["rev-list", "--count", upstream + "..HEAD"]).trim()); } catch (e) {}
  if (ahead > 0) {
    let upIndex = null, headIndex = null, headWorkerRefs = new Map(), upWorkerRefs = new Map();
    try { upIndex = versions(git(["show", upstream + ":index.html"])); } catch (e) {}
    try { headIndex = versions(git(["show", "HEAD:index.html"])); } catch (e) {}
    // Worker-side stamps: collect from every committed root script at both ends.
    let headTree = [];
    try { headTree = git(["ls-tree", "--name-only", "HEAD"]).split("\n").filter(f => f.endsWith(".js")); } catch (e) {}
    for (const src of headTree) {
      try {
        for (const [path, v] of versions(git(["show", "HEAD:" + src]))) {
          if (path !== src) headWorkerRefs.set(src + "→" + path, v);
        }
      } catch (e) {}
      try {
        for (const [path, v] of versions(git(["show", upstream + ":" + src]))) {
          if (path !== src) upWorkerRefs.set(src + "→" + path, v);
        }
      } catch (e) {}
    }
    const committedChanged = new Set(
      git(["diff", upstream, "HEAD", "--name-only"]).split("\n").map(x => x.trim()).filter(Boolean)
    );
    if (upIndex && headIndex) {
      for (const [path, v] of headIndex) {
        if (!committedChanged.has(path)) continue;
        const old = upIndex.get(path);
        if (old !== undefined && old === v) {
          missing.push({ path: path, v: v, where: "index.html, committed vs " + upstream });
          console.log("  MISS  " + path + "  committed change still v" + v + "  [vs " + upstream + "]");
        }
      }
      for (const [key, v] of headWorkerRefs) {
        const path = key.split("→")[1], src = key.split("→")[0];
        if (headIndex.has(path)) continue;                 // covered by the index pass
        if (!committedChanged.has(path)) continue;
        const old = upWorkerRefs.get(key);
        if (old !== undefined && old === v) {
          missing.push({ path: path, v: v, where: src + ", committed vs " + upstream });
          console.log("  MISS  " + path + "  committed change still v" + v + "  [" + src + " vs " + upstream + "]");
        }
      }
    }
  }
}

if (!missing.length && !conflicts.length) {
  console.log("\nevery stamped reference is fresh and consistent — safe to deploy");
  process.exit(0);
}
if (conflicts.length) console.log("\nA CONFLICT means two parts of the page load two different cached copies" +
  " of the same file. Align the stamps — index.html's is the authority.");
if (missing.length) console.log("\nA MISS means returning browsers keep the old copy. Bump the stamp where named.");
process.exit(1);
