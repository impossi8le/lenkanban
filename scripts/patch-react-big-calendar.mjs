import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Lenkanban-owned accessibility patch for pinned react-big-calendar1.19.4 (MIT).
// The reviewed manifest retains upstream provenance and LICENSE fingerprint;
// updates require semantic/browser review of both public package distributions.
const MANIFEST_SHA256 = "30f22017f605b793ad68dd614c6c578e6270646baf306242c9207495e2f333be";
const FILES = new Set(["lib/DateContentRow.js", "lib/EventRow.js", "lib/EventEndingRow.js", "lib/EventRowMixin.js", "lib/Header.js", "lib/Month.js", "lib/TimeGridHeader.js", "lib/TimeGrid.js", "dist/react-big-calendar.esm.js"]);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function fail(code) { throw Object.assign(new Error(code), { code }); }
function assert(value, code) { if (!value) fail(code); }
function readContained(packageRoot, name) {
  const target = path.resolve(packageRoot, name);
  assert(target.startsWith(packageRoot + path.sep), "PATCH_PATH_OUTSIDE_PACKAGE");
  const stat = fs.lstatSync(target);
  assert(stat.isFile() && !stat.isSymbolicLink(), "PATCH_TARGET_NOT_REGULAR_FILE");
  assert(fs.realpathSync(target) === target, "PATCH_TARGET_SYMLINK");
  return { target, bytes: fs.readFileSync(target), mode: stat.mode };
}
export function patchCalendar(projectRoot, mode) {
  assert(mode === "--apply" || mode === "--verify", "PATCH_MODE_REQUIRED");
  const root = fs.realpathSync(projectRoot);
  const packageRoot = path.join(root, "node_modules", "react-big-calendar");
  assert(!fs.lstatSync(packageRoot).isSymbolicLink() && fs.realpathSync(packageRoot) === packageRoot, "PATCH_PACKAGE_SYMLINK");
  const manifestBytes = fs.readFileSync(new URL("./patches/react-big-calendar-1.19.4-a11y.json", import.meta.url));
  assert(sha(manifestBytes) === MANIFEST_SHA256, "PATCH_MANIFEST_CHANGED");
  const manifest = JSON.parse(manifestBytes);
  assert(manifest.schemaVersion === 1 && manifest.package === "react-big-calendar" && manifest.version === "1.19.4", "PATCH_MANIFEST_INVALID");
  const packageJson = readContained(packageRoot, "package.json");
  const metadata = JSON.parse(packageJson.bytes);
  assert(metadata.name === manifest.package && metadata.version === manifest.version, "PATCH_UNREVIEWED_PACKAGE_VERSION");
  assert(sha(packageJson.bytes) === manifest.packageJsonSha256, "PATCH_PACKAGE_METADATA_CHANGED");
  assert(sha(readContained(packageRoot, "LICENSE").bytes) === manifest.licenseSha256, "PATCH_LICENSE_CHANGED");
  assert(manifest.files.length === FILES.size && new Set(manifest.files.map(file => file.path)).size === FILES.size && manifest.files.every(file => FILES.has(file.path)), "PATCH_INVENTORY_INVALID");
  // Validate every source and prepare all outputs BEFORE the first write.
  const prepared = manifest.files.map(file => {
    const source = readContained(packageRoot, file.path), actual = sha(source.bytes);
    assert(actual === file.originalSha256 || actual === file.patchedSha256, "PATCH_SOURCE_CHANGED");
    if (actual === file.patchedSha256) return { ...source, patched: true, file };
    let output = source.bytes.toString("utf8"), boundary = output.length;
    for (const change of file.changes) {
      assert(Number.isInteger(change.offset) && change.offset >= 0 && change.offset + change.before.length <= boundary, "PATCH_EDIT_OVERLAP");
      assert(output.slice(change.offset, change.offset + change.before.length) === change.before, "PATCH_ANCHOR_CHANGED");
      output = output.slice(0, change.offset) + change.after + output.slice(change.offset + change.before.length);
      boundary = change.offset;
    }
    assert(sha(output) === file.patchedSha256, "PATCH_OUTPUT_MISMATCH");
    return { ...source, patched: false, file, output };
  });
  const patched = prepared.filter(file => file.patched).length;
  assert(patched === 0 || patched === prepared.length, "PATCH_PARTIAL_STATE_REINSTALL_REQUIRED");
  if (mode === "--verify") {
    assert(patched === prepared.length, "PATCH_NOT_APPLIED");
    return { status: "verified", version: manifest.version, files: prepared.length };
  }
  if (patched === prepared.length) return { status: "already_applied", version: manifest.version, files: prepared.length };
  for (const source of prepared) {
    // One atomic file replacement; an interrupted multi-file application fails
    // closed on the next invocation and requires a clean npmci, never success.
    const temporary = `${source.target}.lenkanban-${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, source.output, { flag: "wx", mode: source.mode });
      fs.renameSync(temporary, source.target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  for (const source of prepared) assert(sha(fs.readFileSync(source.target)) === source.file.patchedSha256, "PATCH_POSTWRITE_MISMATCH");
  return { status: "applied", version: manifest.version, files: prepared.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 3, "PATCH_MODE_REQUIRED");
    console.log(JSON.stringify(patchCalendar(process.cwd(), process.argv[2])));
  } catch (error) {
    // Fixed codes only; never serialize a package file or arbitrary thrown text.
    const code = typeof error?.code === "string" && /^PATCH_[A-Z_]+$/.test(error.code) ? error.code : "PATCH_SETUP_FAILED";
    console.error(JSON.stringify({ status: "failed", code })); process.exitCode = 1;
  }
}
