const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { requiredBaselinePaths } = require("./visual-manifest.cjs");

function validateBaseline(png, metadata) {
  if (png.length < 33 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid baseline PNG");
  if (metadata.schemaVersion !== 2 || metadata.pngSha256 !== createHash("sha256").update(png).digest("hex")) throw new Error("Baseline PNG/provenance hash mismatch");
  if (!/^[a-f0-9]{64}$/.test(metadata.source?.digest ?? "")) throw new Error("Missing source fingerprint");
  if (!metadata.environment?.browser || !metadata.environment?.playwright || !metadata.environment?.os?.platform || !metadata.environment?.os?.arch) throw new Error("Missing baseline environment");
  if (!metadata.project || !metadata.viewport || metadata.viewport.width !== png.readUInt32BE(16) || png.readUInt32BE(20) < metadata.viewport.height) throw new Error("Invalid baseline geometry");
  if (metadata.locale !== "ru-RU" || metadata.timezone !== "Europe/Moscow" || metadata.fixedTime !== require("./design-data.cjs").FIXED_TIME) throw new Error("Invalid baseline determinism metadata");
}

function checkBaselines(root = path.resolve(__dirname, "../baselines")) {
  const files = [];
  const found = new Set();
  const required = requiredBaselinePaths();
  const expected = new Set(required.flatMap(file => [file, file + ".json"]));
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Baseline symlinks are forbidden");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Baseline symlinks are forbidden");
      if (entry.isDirectory()) visit(target);
      else {
        const relative = path.relative(root, target).split(path.sep).join("/");
        if (!entry.isFile() || !expected.has(relative)) throw new Error("Unexpected baseline input");
        found.add(relative);
        if (entry.name.endsWith(".png")) files.push(target);
        else if (!fs.existsSync(target.slice(0, -5))) throw new Error("Orphan baseline provenance");
      }
    }
  }
  visit(root);
  if (files.length === 0) throw new Error("BLOCKED #60: no reviewed browser PNG baselines; capture PNG + JSON on a prepared server before enabling comparisons");
  const missing = [...expected].filter(file => !found.has(file));
  if (missing.length) throw new Error(`BLOCKED #60: incomplete reviewed matrix; missing ${missing.length} of ${expected.size} PNG/provenance files`);
  for (const png of files) {
    const metadata = JSON.parse(fs.readFileSync(png + ".json", "utf8"));
    validateBaseline(fs.readFileSync(png), metadata);
    const project = path.relative(root, png).split(path.sep)[0];
    const width = Number(project.split("-")[1]);
    if (metadata.project !== project || metadata.viewport.width !== width || metadata.viewport.height !== (width === 360 ? 844 : width === 768 ? 1024 : 900)) throw new Error("Baseline rendering profile/path mismatch");
    if (metadata.environment.os.platform !== "linux" || metadata.environment.os.arch !== "x64") throw new Error("BLOCKED #60: reviewed baselines must use the canonical Linux x64 renderer");
  }
  return files.length;
}

if (require.main === module) console.log(`Validated ${checkBaselines()} PNG/provenance pairs`);
module.exports = { validateBaseline, checkBaselines };
