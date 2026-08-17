/*
 * ULTRON — Field Guide to Post-Training a Code Model
 *
 *   node build.js            build everything
 *   node build.js 01 04      build only those sections (fast iteration)
 *
 * Sections are in development order. The manifest is OUTLINE.md — if a topic
 * is there, it must be built; if it is built, it must be there.
 */

const pptxgen = require("pptxgenjs");
const { makeTheme } = require("./lib/theme");

const SECTIONS = [
  "01-orientation",
  "02-environment",
  "03-models",
  "04-sandbox",
  "05-evaluation",
  "06-data",
  "07-sft",
  "08-rft",
  "09-preference",
  "10-rlvr",
  "11-repair",
  "12-merging",
  "13-serving",
  "14-operations",
  "15-synthesis",
];

const filter = process.argv.slice(2);
const chosen = filter.length
  ? SECTIONS.filter(s => filter.some(f => s.startsWith(f)))
  : SECTIONS;

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
pres.author = "ULTRON";
pres.company = "Field Guide";
pres.title = "Field Guide to Post-Training a Code Model";

const T = makeTheme(pres);

for (const name of chosen) {
  let mod;
  try {
    mod = require(`./sections/${name}`);
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND" && e.message.includes(name)) {
      console.log(`  ~ ${name} not written yet, skipping`);
      continue;
    }
    throw e;
  }
  const before = T.pageCount();
  mod(pres, T);
  console.log(`  + ${name.padEnd(18)} ${String(T.pageCount() - before).padStart(3)} slides`);
}

const out = filter.length ? "ULTRON-Field-Guide-partial.pptx" : "ULTRON-Field-Guide.pptx";
pres.writeFile({ fileName: out })
  .then(f => console.log(`\nWrote ${f} — ${T.pageCount()} slides total`));
