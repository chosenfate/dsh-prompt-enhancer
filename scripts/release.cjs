#!/usr/bin/env node
/**
 * Release: test, self-check, publish, then verify what the registry actually
 * serves by pulling the published tarball back and running the install
 * self-check against it.
 *
 *   node scripts/release.cjs            # publish the version in package.json
 *   node scripts/release.cjs --dry-run  # everything except the publish
 *
 * Auth: run `pnpm login` (or `npm login`) once; the credential lives in
 * ~/.npmrc and this script never touches it. A scoped package publishes as
 * restricted unless publishConfig.access=public is set — package.json carries
 * it, so plain `pnpm publish` is enough.
 *
 * The publisher is pnpm when present (the DeepSeek Harness runtime ships
 * pnpm but not npm) and npm otherwise; override with PUBLISH_CMD.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dryRun = process.argv.includes("--dry-run");
const registry = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org";

const steps = [];
const problems = [];

function run(label, command, args, options = {}) {
  process.stdout.write(`\n== ${label}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) problems.push(`${label} failed (exit ${result.status})`);
  return result;
}

function runCapture(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8" });
}

// ------------------------------------------------------------------- preflight
if (pkg.name.startsWith("@") && pkg.publishConfig?.access !== "public") {
  problems.push("a scoped package needs publishConfig.access=public or others cannot install it");
}
if (pkg.private === true) problems.push("package.json must not set private:true to publish");
for (const rel of ["index.js", "lib/client.js", "cordis.patch.yml", "locale/en.json", "locale/zh.json", "icon.svg", "README.md", "LICENSE"]) {
  if (!fs.existsSync(path.join(root, rel))) problems.push(`files[] references a missing file: ${rel}`);
}
const patch = fs.readFileSync(path.join(root, "cordis.patch.yml"), "utf8");
if (!patch.includes(pkg.name)) problems.push("the patch row name must match package.json name");

if (problems.length > 0) {
  for (const line of problems) console.log(`FAIL  ${line}`);
  process.exit(1);
}
steps.push("preflight: manifest, files list, and patch row agree");

// ----------------------------------------------------------------------- tests
run("unit tests", process.execPath, ["--test", "test/host.test.mjs", "test/client.test.cjs"]);
run("install self-check", process.execPath, ["scripts/check-install.cjs", "."]);
steps.push("tests and install self-check passed");

if (dryRun) {
  console.log("\ndry run: skipping publish and registry verification");
  process.exit(problems.length === 0 ? 0 : 1);
}

// --------------------------------------------------------------------- publish
const pnpm = runCapture("pnpm", ["--version"]);
const publisher = process.env.PUBLISH_CMD ?? (pnpm.status === 0 ? "pnpm" : "npm");
run(`publish ${pkg.name}@${pkg.version} via ${publisher}`, publisher, ["publish", "--access", "public"]);
steps.push(`published ${pkg.name}@${pkg.version}`);

// ----------------------------------------------------------------- verification
// Read the packument the registry actually serves, pull the tarball, unpack
// it, and run the install self-check against the published bytes — not
// against the working tree.
const encoded = pkg.name.replace("/", "%2f");
const packument = runCapture("curl", ["-s", "--max-time", "30", `${registry}/${encoded}`]);
let served = null;
try {
  const doc = JSON.parse(packument.stdout);
  served = doc.versions?.[pkg.version] ?? null;
} catch {
  served = null;
}
if (served === null) {
  problems.push(`the registry does not serve ${pkg.name}@${pkg.version} yet`);
} else {
  const tarballUrl = served.dist?.tarball;
  if (typeof tarballUrl !== "string") {
    problems.push("the packument carries no tarball url");
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-enhancer-release-"));
    const tarball = path.join(dir, "package.tgz");
    const fetched = runCapture("curl", ["-s", "--max-time", "60", "-o", tarball, tarballUrl]);
    if (fetched.status !== 0 || !fs.existsSync(tarball)) {
      problems.push("the published tarball could not be downloaded");
    } else {
      run("unpack the published tarball", "tar", ["-xzf", tarball, "-C", dir]);
      // npm packs under package/, so the payload lands in <dir>/package.
      const unpacked = path.join(dir, "package");
      if (!fs.existsSync(path.join(unpacked, "package.json"))) {
        problems.push("the tarball did not unpack into package/");
      } else {
        run("install self-check on the published tarball", process.execPath, [path.join(root, "scripts", "check-install.cjs"), unpacked]);
        steps.push("the published tarball passes the install self-check");
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------- report
console.log("");
for (const line of steps) console.log(`ok    ${line}`);
for (const line of problems) console.log(`FAIL  ${line}`);
console.log(`\n${steps.length} steps completed, ${problems.length} failed`);
process.exit(problems.length === 0 ? 0 : 1);
