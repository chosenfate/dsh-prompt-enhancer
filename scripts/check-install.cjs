#!/usr/bin/env node
/**
 * Post-install self-check for the prompt-enhancer bundle.
 *
 * Verifies the manifest, the patch row, the exported resources, and the
 * source markers the Loader and the Host rely on. It does NOT start the
 * Harness: registration itself is confirmed separately with
 * cordis_inspect_query.
 *
 *   node scripts/check-install.cjs <plugin-dir> ["<dsh app dir>"]
 *
 * The optional app dir adds checks that need the running build: the client
 * module id in the module graph and the slot names in the installed
 * ui-conversation package.
 */

const fs = require("node:fs");
const path = require("node:path");

const pluginDir = path.resolve(process.argv[2] ?? ".");
const appDir = process.argv[3] ? path.resolve(process.argv[3]) : null;

const problems = [];
const notes = [];

function check(label, ok, detail) {
  if (ok) {
    notes.push(`ok    ${label}`);
  } else {
    problems.push(`FAIL  ${label}${detail === undefined ? "" : " — " + detail}`);
  }
}

function read(rel) {
  try {
    return fs.readFileSync(path.join(pluginDir, rel), "utf8");
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ manifest
const pkgRaw = read("package.json");
check("package.json exists", pkgRaw !== undefined);
if (pkgRaw === undefined) {
  report();
}

let pkg;
try {
  pkg = JSON.parse(pkgRaw);
} catch (error) {
  check("package.json parses", false, error.message);
  report();
}

check("name matches the patch row", pkg.name === "@chosenfate/dsh-prompt-enhancer", pkg.name);
check("type is module", pkg.type === "module");
check("main points at index.js", pkg.main === "index.js");
check("declares the bundle patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("declares the web client platform", pkg.dsh?.client?.platform === "web");
check("engines.dsh covers the installed app", satisfiesRange(pkg.engines?.dsh, "0.2.2-rc.1"), pkg.engines?.dsh);

for (const rel of ["index.js", "lib/client.js", "cordis.patch.yml", "locale/en.json", "locale/zh.json", "icon.svg", "README.md", "LICENSE"]) {
  check(`file present: ${rel}`, read(rel) !== undefined);
}

for (const sub of [".", "./client", "./locale/*.json", "./icon"]) {
  check(`export present: ${sub}`, pkg.exports?.[sub] !== undefined);
}

// --------------------------------------------------------------------- patch
const patch = read("cordis.patch.yml") ?? "";
check("patch inserts a row", /- insert:/.test(patch));
check("patch row id is prompt-enhancer", /id: prompt-enhancer/.test(patch));
check("patch row name matches the package", patch.includes(pkg.name));
check("patch carries the tunables", /systemPrompt:/.test(patch) && /temperature:/.test(patch));

// ---------------------------------------------------------------------- icon
const icon = read("icon.svg");
if (icon !== undefined) {
  check("icon is an SVG document", /<svg[\s>]/.test(icon));
  check("icon stays inside the size budget", Buffer.byteLength(icon) <= 256 * 1024, `${Buffer.byteLength(icon)} bytes`);
  check("icon declares a viewBox", /viewBox=/.test(icon));
}

// -------------------------------------------------------------------- locales
for (const rel of ["locale/en.json", "locale/zh.json"]) {
  const raw = read(rel);
  if (raw === undefined) continue;
  try {
    const dict = JSON.parse(raw);
    check(`${rel} has meta.title`, typeof dict.meta?.title === "string" && dict.meta.title.length > 0);
    check(`${rel} has meta.description`, typeof dict.meta?.description === "string" && dict.meta.description.length > 0);
    check(`${rel} carries the button strings`, typeof dict.button?.enhance === "string");
    check(`${rel} carries the settings strings`, typeof dict.settings?.title === "string");
  } catch (error) {
    check(`${rel} parses`, false, error.message);
  }
}

// ----------------------------------------------------------------- host half
const index = read("index.js") ?? "";
check("host exports apply", /export\s*{[^}]*\bapply\b/.test(index));
check("host exports inject", /export\s*{[^}]*\binject\b/.test(index));
check("host exports name", /export\s*{[^}]*\bname\b/.test(index));
check("host registers the enhance route", index.includes("/api/prompt-enhancer/enhance"));
check("host registers the config route", index.includes("/api/prompt-enhancer/config"));
check("host reads the default model service", index.includes("agentDefaultModel"));
check("host persists config through the editor", index.includes("configEditor"));
check("host bounds the model call", index.includes("AbortSignal.timeout"));

// --------------------------------------------------------------- client half
const client = read("lib/client.js") ?? "";
check("client registers with the module loader", client.includes("window.__ModuleLoader__.load"));
check("client injects the composer slot", client.includes('ctx.slots.inject("conversation.input.right"'));
check("client injects its own settings section", client.includes('ctx.slots.inject("settings.section"'));
check("client registers a nav icon for that section", client.includes('ctx.slots.inject("settings.section.icon"'));
check("client no longer lives in the plugins tab", !client.includes("settings.plugins.tab"));
check("client reads the draft through useInput", client.includes("useInput"));
check("client writes the draft through setDraft", client.includes("setDraft"));
check("client freezes on the sending phases", client.includes('"adjudicating"') && client.includes('"submitting"') && client.includes('"sending"'));
check("client never requires the primitives package", !client.includes("@deepseek-ai/dsh-client-ui-primitives"));
check("client styles through theme tokens", client.includes("--dsw-alias-"));
check("client styles are injected once", client.includes("data-plugin-css"));

// -------------------------------------------------- optional build-time checks
if (appDir !== null) {
  const graph = findUp(appDir, "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib");
  if (graph === null) {
    notes.push("skip  app dir given but no installed ui-conversation package found");
  } else {
    const slots = safeRead(path.join(graph, "index.d.ts")) ?? "";
    check("installed ui-conversation declares conversation.input.right", slots.includes("conversation.input.right"));
    check("installed ui-conversation declares settings.plugins.tab", slots.includes("settings.plugins.tab"));
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function findUp(from, rel) {
  let dir = from;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Minimal semver range check for the engines.dsh patterns this bundle uses. */
function satisfiesRange(range, version) {
  if (typeof range !== "string") return false;
  const parts = version.split("-");
  const core = parts[0].split(".").map(Number);
  const pre = parts[1];
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i += 1) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0) ? -1 : 1;
    }
    return 0;
  };
  const parse = (spec) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(spec.trim());
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : null;
  };
  const v = { core, pre };
  const clauses = range.split(/\s+/).filter(Boolean);
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i];
    const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(clause);
    const op = m[1] ?? "=";
    const bound = parse(m[2]);
    if (bound === null) return false;
    const coreCmp = cmp(v.core, bound.core);
    const preCmp = v.pre === bound.pre ? 0 : v.pre === undefined ? 1 : bound.pre === undefined ? -1 : v.pre < bound.pre ? -1 : 1;
    const total = coreCmp !== 0 ? coreCmp : preCmp;
    if (op === ">=" && total < 0) return false;
    if (op === ">" && total <= 0) return false;
    if (op === "<=" && total > 0) return false;
    if (op === "<" && total >= 0) return false;
    if (op === "=" && total !== 0) return false;
    void i;
  }
  return true;
}

function report() {
  for (const line of notes) console.log(line);
  for (const line of problems) console.log(line);
  console.log(`\n${notes.length} checks passed, ${problems.length} failed`);
  process.exit(problems.length === 0 ? 0 : 1);
}

report();
