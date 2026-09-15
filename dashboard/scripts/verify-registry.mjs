#!/usr/bin/env node
/**
 * Check `NEXUS_REGISTRY` against a real nexus blob.
 *
 * Why this exists as a script and not a test: the unit tests in
 * `src/lib/sync/registry.test.ts` were all green while a real default blob
 * lost **every one of its 90 records**. Two things were wrong that only real
 * data could show:
 *
 *   1. the roadmap seed mints ids like `seed:0001:phase:ship`, and the nested
 *      key format `${parent}:${child}` could not be split unambiguously — so
 *      every child resolved to a parent named `seed`, became an orphan, and
 *      was dropped;
 *   2. a collection missing from the registry does not fail anything. Its data
 *      falls into the `__rest__` leftover as one opaque singleton, which is
 *      *worse* than Stage 3a for that domain: whole-subtree conflicts, with no
 *      symptom until two devices edit it in one offline window.
 *
 * Neither is expressible as a unit test in this repo, because the model still
 * lives in nexus. So this points the real registry at the real data.
 *
 * Usage:
 *   node scripts/verify-registry.mjs [path-to-nexus]
 *
 * Defaults to $NEXUS_DIR, then a few sibling guesses. Exits non-zero on data
 * loss, an uncovered collection, or a broken property. Folds into CI in Stage
 * 4, when the model is ported into this repo and nexus stops being a
 * prerequisite.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const DASH = resolve(HERE, "..");

function findNexus() {
  const candidates = [
    process.argv[2],
    process.env.NEXUS_DIR,
    resolve(DASH, "../../../nexus"),
    resolve(DASH, "../../../../nexus"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, "src/lib/migrate.ts"))) return resolve(c);
  }
  console.error(
    "Could not find a nexus checkout (looked for src/lib/migrate.ts in):\n  " +
      candidates.join("\n  ") +
      "\nPass the path as an argument or set NEXUS_DIR.",
  );
  process.exit(2);
}

const NEXUS = findNexus();
const ESBUILD = join(DASH, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) {
  console.error(`esbuild not found at ${ESBUILD} — run npm install in ${DASH}.`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "verify-registry-"));
writeFileSync(
  join(work, "entry.ts"),
  `
import { makeDefaultData } from ${JSON.stringify(join(NEXUS, "src/lib/migrate.ts"))};
import { NEXUS_REGISTRY, flatten, rehydrate, REST } from ${JSON.stringify(join(DASH, "src/lib/sync/registry.ts"))};
import { sameRecord } from ${JSON.stringify(join(DASH, "src/lib/sync/flatten.ts"))};

const blob: any = makeDefaultData();
const problems: string[] = [];

/** Every array-of-objects-with-id in the blob, as a registry-style path. */
function identified(node: any, path = "", out = new Map<string, number>()) {
  if (Array.isArray(node)) {
    if (node.some((v) => v && typeof v === "object" && typeof v.id === "string")) {
      out.set(path, (out.get(path) ?? 0) + node.length);
    }
    for (const item of node) identified(item, path + "[]", out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) identified(v, path ? path + "." + k : k, out);
  }
  return out;
}

/**
 * Arrays that are EMPTY in a fresh blob.
 *
 * The check above cannot see these: an empty array has no id-bearing elements,
 * so a record collection missing from the registry would pass unnoticed simply
 * because a new install has no courses yet. Most of the model is empty in a
 * fresh blob, which makes this the larger half of the coverage question.
 *
 * An empty array is either a record collection (must be registered) or a
 * genuine scalar list of strings (must not be). Nothing in the data
 * distinguishes them, so the scalar ones are named here. A new one shows up as
 * a failure that has to be classified by hand, which is the right amount of
 * friction: the alternative is a silent gap.
 */
const SCALAR_ARRAYS = new Set([
  "roadmap.principles",
  "roadmap.layers[].methods",
  "roadmap.layers[].demo.flow",
  "academics.semesters",
  "projects[].runbook.commands",
  "projects[].runbook.env",
  "projects[].runbook.ports",
  "projects[].runbook.links",
]);

function emptyArrays(node: any, path = "", out = new Set<string>()) {
  if (Array.isArray(node)) {
    if (node.length === 0) out.add(path);
    for (const item of node) emptyArrays(item, path + "[]", out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) emptyArrays(v, path ? path + "." + k : k, out);
  }
  return out;
}

// ── 1. coverage ──────────────────────────────────────────────────────────
const registered = new Set(NEXUS_REGISTRY.filter((s) => s.kind !== "singleton").map((s) => s.path));
const found = identified(blob);
console.log("collections carrying records in a fresh blob:");
for (const [p, n] of [...found].sort()) {
  const ok = registered.has(p);
  console.log(\`  \${ok ? "covered " : "UNCOVERED"} \${p}  (\${n})\`);
  if (!ok) problems.push(\`\${p} is not in NEXUS_REGISTRY — its data falls into \${REST}\`);
}

// ── 1b. the empty half of the model ──────────────────────────────────────
const unclassified = [...emptyArrays(blob)].filter(
  (p) => !registered.has(p) && !SCALAR_ARRAYS.has(p),
);
console.log("\\nempty arrays in a fresh blob:", [...emptyArrays(blob)].length, "-", unclassified.length, "unclassified");
for (const p of unclassified) {
  console.log(\`  UNCLASSIFIED \${p}\`);
  problems.push(
    \`\${p} is an empty array that is neither registered nor a known scalar list — \` +
      \`if it holds records it needs a registry entry, and a fresh blob cannot tell us which\`,
  );
}

// ── 2. nothing stranded in the leftover ──────────────────────────────────
const snapshot = flatten(blob, NEXUS_REGISTRY);
const leftover = (snapshot as any)[REST][REST];
const stranded = [...identified(leftover).keys()];
console.log("\\nleftover keys:", Object.keys(leftover).sort().join(", ") || "(none)");
if (stranded.length) problems.push("identified arrays stranded in the leftover: " + stranded.join(", "));

// ── 3. the three properties, on real data ────────────────────────────────
const orphans: any[] = [];
const back = rehydrate(snapshot, NEXUS_REGISTRY, (o) => orphans.push(o));
const records = Object.entries(snapshot).flatMap(([collection, recs]) =>
  Object.entries(recs).map(([id, body]) => ({ collection, id, body })),
);
const fold = (rs: typeof records) => {
  const s: any = {};
  for (const r of rs) (s[r.collection] ??= {})[r.id] = r.body;
  return rehydrate(s, NEXUS_REGISTRY, () => {});
};
const shuffled = [...records].sort(() => Math.random() - 0.5);

const checks: [string, boolean][] = [
  ["round-trip: rehydrate(flatten(blob)) equals the blob", sameRecord(blob, back)],
  ["no orphans dropped", orphans.length === 0],
  ["idempotence: re-flattening the round-trip is a no-op", sameRecord(snapshot, flatten(back as any, NEXUS_REGISTRY))],
  ["commutativity: reversed arrival order", sameRecord(fold(records), fold([...records].reverse()))],
  ["commutativity: shuffled arrival order", sameRecord(fold(records), fold(shuffled))],
];

console.log(\`\\n\${records.length} records across \${new Set(records.map((r) => r.collection)).size} collections\\n\`);
for (const [name, ok] of checks) {
  console.log(\`  \${ok ? "ok  " : "FAIL"} \${name}\`);
  if (!ok) problems.push(name);
}
for (const o of orphans.slice(0, 10)) console.log(\`       orphan: \${o.collection}/\${o.id}\`);

if (problems.length) {
  console.error("\\n" + problems.length + " problem(s):");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("\\nregistry verified against the real model.");
`,
);

execFileSync(
  ESBUILD,
  [
    join(work, "entry.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${join(work, "entry.mjs")}`,
    "--log-level=warning",
  ],
  { stdio: "inherit" },
);

try {
  execFileSync(process.execPath, [join(work, "entry.mjs")], { stdio: "inherit" });
} catch {
  process.exit(1);
}
