import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { patchCalendar } from "./patch-react-big-calendar.mjs";
const manifest = JSON.parse(fs.readFileSync(new URL("./patches/react-big-calendar-1.19.4-a11y.json", import.meta.url)));
const donor = path.resolve(process.cwd(), "node_modules/react-big-calendar");
const ownRoot = path.resolve(process.cwd(), "work", `calendar-patch-unit-${crypto.randomUUID()}`);
fs.mkdirSync(ownRoot, { recursive: true });
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const project = path.join(ownRoot, crypto.randomUUID()), pkg = path.join(project, "node_modules/react-big-calendar");
  for (const file of ["package.json", "LICENSE", ...manifest.files.map(file => file.path)]) {
    const target = path.join(pkg, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    let bytes = fs.readFileSync(path.join(donor, file));
    const reviewed = manifest.files.find(entry => entry.path === file);
    if (reviewed && sha(bytes) === reviewed.patchedSha256) {
      let original = bytes.toString("utf8");
      for (const change of [...reviewed.changes].sort((a, b) => a.offset - b.offset)) {
        assert.equal(original.slice(change.offset, change.offset + change.after.length), change.after);
        original = original.slice(0, change.offset) + change.before + original.slice(change.offset + change.after.length);
      }
      bytes = Buffer.from(original);
    }
    if (reviewed) assert.equal(sha(bytes), reviewed.originalSha256, "Only reviewed original package fixtures");
    fs.writeFileSync(target, bytes);
  }
  return { project, pkg };
}
function hashes(pkg) { return manifest.files.map(file => sha(fs.readFileSync(path.join(pkg, file.path)))); }
const donorBefore = hashes(donor);
test("clean exact CJS+ESM apply, verify and repeat are deterministic; license unchanged", () => {
  const { project, pkg } = fixture();
  assert.deepEqual(patchCalendar(project, "--apply"), { status: "applied", version: "1.19.4", files: 9 });
  assert.deepEqual(hashes(pkg), manifest.files.map(file => file.patchedSha256));
  assert.equal(patchCalendar(project, "--verify").status, "verified");
  const before = hashes(pkg); assert.equal(patchCalendar(project, "--apply").status, "already_applied"); assert.deepEqual(hashes(pkg), before);
  assert.equal(sha(fs.readFileSync(path.join(pkg, "LICENSE"))), manifest.licenseSha256);
});
test("verify rejects pristine package without changing any file", () => {
  const { project, pkg } = fixture(), before = hashes(pkg);
  assert.throws(() => patchCalendar(project, "--verify"), { code: "PATCH_NOT_APPLIED" }); assert.deepEqual(hashes(pkg), before);
});
test("bad last-file hash fails before ANY first-file write", () => {
  const { project, pkg } = fixture();
  fs.appendFileSync(path.join(pkg, manifest.files.at(-1).path), "\n// unreviewed drift\n");
  const before = hashes(pkg);
  assert.throws(() => patchCalendar(project, "--apply"), { code: "PATCH_SOURCE_CHANGED" }); assert.deepEqual(hashes(pkg), before);
});
test("unreviewed version is denied before writes", () => {
  const { project, pkg } = fixture(), before = hashes(pkg), target = path.join(pkg, "package.json");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace('"version": "1.19.4"', '"version": "1.20.0"'));
  assert.throws(() => patchCalendar(project, "--apply"), { code: "PATCH_UNREVIEWED_PACKAGE_VERSION" }); assert.deepEqual(hashes(pkg), before);
});
test("mixed original/patched state fails closed and requires clean install", () => {
  const { project, pkg } = fixture(); patchCalendar(project, "--apply");
  const clean = fixture(); fs.copyFileSync(path.join(clean.pkg, manifest.files[0].path), path.join(pkg, manifest.files[0].path));
  const before = hashes(pkg);
  assert.throws(() => patchCalendar(project, "--apply"), { code: "PATCH_PARTIAL_STATE_REINSTALL_REQUIRED" }); assert.deepEqual(hashes(pkg), before);
});
test("license drift is denied without modification", () => {
  const { project, pkg } = fixture(), before = hashes(pkg);
  fs.appendFileSync(path.join(pkg, "LICENSE"), "\nmodified\n");
  assert.throws(() => patchCalendar(project, "--apply"), { code: "PATCH_LICENSE_CHANGED" }); assert.deepEqual(hashes(pkg), before);
});
test("invalid modes never modify package", () => {
  const { project, pkg } = fixture(), before = hashes(pkg);
  assert.throws(() => patchCalendar(project, "--force"), { code: "PATCH_MODE_REQUIRED" }); assert.deepEqual(hashes(pkg), before);
});
test("donor sources remain unchanged", () => {
  assert.deepEqual(hashes(donor), donorBefore);
});
