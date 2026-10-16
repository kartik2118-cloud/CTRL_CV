#!/usr/bin/env node
/**
 * sync/build_browser.mjs: Generates standalone browser bundle sync/dist/syncEngine.browser.js
 * for Manifest V3 content script usage without requiring an external bundler.
 * 
 * Exposes:
 *   globalThis.CtrlCVSync = { SyncEngine, SyncBridge };
 * 
 * Source of truth remains the pure ESM files:
 *   - sync/syncEngine.js
 *   - sync/syncBridge.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, "dist");

export function buildBrowserBundle(extraOut = null) {
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const engineSrc = fs.readFileSync(path.join(__dirname, "syncEngine.js"), "utf-8");
  const bridgeSrc = fs.readFileSync(path.join(__dirname, "syncBridge.js"), "utf-8");

  // Strip ESM imports and exports
  const cleanedEngine = engineSrc
    .replace(/^export\s+class\s+/gm, "class ")
    .replace(/^export\s+/gm, "")
    .trim();

  const cleanedBridge = bridgeSrc
    .replace(/^import\s+.*?;?\s*$/gm, "")
    .replace(/^export\s+class\s+/gm, "class ")
    .replace(/^export\s+/gm, "")
    .trim();

  const bundle = `/**
 * CtrlCV Subtitle Sync Bundle (Manifest V3 Classic Script)
 * Auto-generated from sync/syncEngine.js and sync/syncBridge.js.
 * Source of truth: ESM modules in sync/.
 */
(function(root) {
  'use strict';

  ${cleanedEngine}

  ${cleanedBridge}

  root.CtrlCVSync = {
    SyncEngine: SyncEngine,
    SyncBridge: SyncBridge
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
`;

  const outPath = path.join(DIST_DIR, "syncEngine.browser.js");
  fs.writeFileSync(outPath, bundle, "utf-8");
  console.log(`[Build] Generated browser bundle at: ${outPath} (${Buffer.byteLength(bundle)} bytes)`);

  if (extraOut) {
    const resolvedExtra = path.resolve(process.cwd(), extraOut);
    let targetFile = resolvedExtra;
    const isDir = extraOut.endsWith("/") || extraOut.endsWith("\\") || (fs.existsSync(resolvedExtra) && fs.statSync(resolvedExtra).isDirectory());
    if (isDir) {
      targetFile = path.join(resolvedExtra, "syncEngine.browser.js");
    }
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, bundle, "utf-8");
    console.log(`[Build] Copied browser bundle to: ${targetFile} (${Buffer.byteLength(bundle)} bytes)`);
  }

  return outPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cliArgs = process.argv.slice(2);
  let outArg = null;
  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === "--out" && cliArgs[i + 1]) {
      outArg = cliArgs[i + 1];
      i++;
    } else if (cliArgs[i] === "--copy") {
      if (cliArgs[i + 1] && !cliArgs[i + 1].startsWith("--")) {
        outArg = cliArgs[i + 1];
        i++;
      } else {
        outArg = "extension/vendor";
      }
    }
  }
  buildBrowserBundle(outArg);
}
