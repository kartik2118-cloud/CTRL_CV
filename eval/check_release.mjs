#!/usr/bin/env node
/**
 * eval/check_release.mjs
 * LiveSub Release Candidate Preflight Validation Script.
 * 
 * Verifications:
 * 1. manifest.json: Valid MV3 schema, required fields, permissions, content_scripts, background.
 * 2. Placeholder Check: Flag if 'REPLACE_ME' remains in extension/ (expected pre-release fail).
 * 3. Key Patterns Scan: Grep for known secret token patterns (gsk_, sk-, AIza, etc.).
 * 4. .env Scan: Ensure no environment variable files are packaged in extension/.
 * 5. Vendor Integrity: Ensure sync/dist/syncEngine.browser.js and extension/vendor/syncEngine.browser.js have identical SHA256.
 * 6. Package Distribution: Build dist/ctrlcv-extension.zip from extension/ contents.
 * 7. Archive Inspection: Scan packaged zip for secrets or unexpected files.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT_DIR, "extension");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const ZIP_PATH = path.join(DIST_DIR, "ctrlcv-extension.zip");

function getSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  }
  return arrayOfFiles;
}

console.log("==========================================================================");
console.log("LIVESUB EXTENSION RELEASE CANDIDATE AUDIT (eval/check_release.mjs)");
console.log("==========================================================================");

const results = [];
let overallPass = true;

// 1. Manifest Validation
const manifestPath = path.join(EXT_DIR, "manifest.json");
let manifestValid = false;
let manifestDetail = "";

try {
  const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(manifestRaw);
  if (manifest.manifest_version === 3 && manifest.name && manifest.version && manifest.background && manifest.content_scripts) {
    manifestValid = true;
    manifestDetail = `MV3 valid (v${manifest.version}, ${manifest.permissions?.length || 0} permissions)`;
  } else {
    manifestDetail = "Missing required MV3 fields";
  }
} catch (e) {
  manifestDetail = `JSON parse error: ${e.message}`;
}

results.push({
  Check: "Manifest V3 Parse",
  Status: manifestValid ? "PASS" : "FAIL",
  Detail: manifestDetail
});
if (!manifestValid) overallPass = false;

// 2. Placeholder Check (REPLACE_ME)
const extFiles = getAllFiles(EXT_DIR);
let placeholderFound = false;
const placeholderLocations = [];

for (const f of extFiles) {
  const rel = path.relative(ROOT_DIR, f);
  const content = fs.readFileSync(f, "utf-8");
  if (content.includes("REPLACE_ME")) {
    placeholderFound = true;
    placeholderLocations.push(rel);
  }
}

if (placeholderFound) {
  results.push({
    Check: "Backend URL Placeholder",
    Status: "FAIL",
    Detail: `Found 'REPLACE_ME' in: ${placeholderLocations.join(", ")} (operator must set real URL)`
  });
  overallPass = false;
} else {
  results.push({
    Check: "Backend URL Placeholder",
    Status: "PASS",
    Detail: "No 'REPLACE_ME' placeholder found in extension files"
  });
}

// 3. Key Patterns Scan
const SECRET_REGEX = /(gsk_[0-9a-zA-Z]{20,}|sk-[0-9a-zA-Z]{20,}|AIza[0-9A-Za-z-_]{35}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/g;
let secretFound = false;
const secretLocations = [];

for (const f of extFiles) {
  const rel = path.relative(ROOT_DIR, f);
  const content = fs.readFileSync(f, "utf-8");
  if (SECRET_REGEX.test(content)) {
    secretFound = true;
    secretLocations.push(rel);
  }
}

results.push({
  Check: "API Keys & Secrets Grep",
  Status: secretFound ? "FAIL" : "PASS",
  Detail: secretFound ? `Found secrets in: ${secretLocations.join(", ")}` : "Zero secret patterns detected"
});
if (secretFound) overallPass = false;

// 4. .env Scan in extension/
let envFileFound = false;
for (const f of extFiles) {
  const base = path.basename(f);
  if (base.startsWith(".env")) {
    envFileFound = true;
  }
}

results.push({
  Check: "No .env in extension/",
  Status: envFileFound ? "FAIL" : "PASS",
  Detail: envFileFound ? "Detected .env file inside extension/" : "Clean (no .env files in extension/)"
});
if (envFileFound) overallPass = false;

// 5. Vendor Hash Integrity
const syncDistHash = getSha256(path.join(ROOT_DIR, "sync", "dist", "syncEngine.browser.js"));
const extVendorHash = getSha256(path.join(EXT_DIR, "vendor", "syncEngine.browser.js"));
const vendorIdentical = syncDistHash !== null && syncDistHash === extVendorHash;

results.push({
  Check: "Vendor Sync Integrity",
  Status: vendorIdentical ? "PASS" : "FAIL",
  Detail: vendorIdentical
    ? `SHA256 match (${syncDistHash.slice(0, 12)}...)`
    : `Mismatch (dist: ${syncDistHash ? syncDistHash.slice(0, 8) : "missing"}, vendor: ${extVendorHash ? extVendorHash.slice(0, 8) : "missing"})`
});
if (!vendorIdentical) overallPass = false;

// 6. Build dist/ctrlcv-extension.zip
fs.mkdirSync(DIST_DIR, { recursive: true });
let zipCreated = false;
let zipSize = 0;

try {
  execSync(
    `powershell.exe -NoProfile -Command "Compress-Archive -Path '${EXT_DIR}/*' -DestinationPath '${ZIP_PATH}' -Force"`,
    { stdio: "pipe" }
  );
  if (fs.existsSync(ZIP_PATH)) {
    zipCreated = true;
    zipSize = fs.statSync(ZIP_PATH).size;
  }
} catch (e) {
  zipCreated = false;
}

results.push({
  Check: "Zip Package Generation",
  Status: zipCreated ? "PASS" : "FAIL",
  Detail: zipCreated ? `dist/ctrlcv-extension.zip created (${zipSize} bytes)` : "Failed to create archive"
});
if (!zipCreated) overallPass = false;

// 7. Zip Secret Scan
let zipSecretFound = false;
if (zipCreated) {
  const zipBuf = fs.readFileSync(ZIP_PATH);
  const zipStr = zipBuf.toString("latin1");
  if (SECRET_REGEX.test(zipStr)) {
    zipSecretFound = true;
  }
}

results.push({
  Check: "Packaged Archive Secrets Scan",
  Status: zipSecretFound ? "FAIL" : "PASS",
  Detail: zipSecretFound ? "Secret pattern found inside packaged zip" : "Clean (zero secrets inside zip archive)"
});
if (zipSecretFound) overallPass = false;

console.log("\nRELEASE PREFLIGHT RESULTS TABLE:");
console.log("-------------------------------------------------------------------------------------------------------------");
console.log(
  "Check".padEnd(32) +
  "Status".padEnd(10) +
  "Detail"
);
console.log("-------------------------------------------------------------------------------------------------------------");

for (const r of results) {
  console.log(
    r.Check.padEnd(32) +
    r.Status.padEnd(10) +
    r.Detail
  );
}

console.log("-------------------------------------------------------------------------------------------------------------");
console.log(`RELEASE AUDIT VERDICT: ${overallPass ? "READY_FOR_RELEASE" : "FAIL (PRE-RELEASE PLACEHOLDER DETECTED)"}`);
console.log("==========================================================================");

if (!overallPass) {
  process.exit(1);
}
