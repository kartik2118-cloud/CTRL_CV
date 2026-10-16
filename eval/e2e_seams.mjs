#!/usr/bin/env node
/**
 * eval/e2e_seams.mjs (Link 5: E2E-MOCK)
 * End-to-end seam evaluation verifying:
 * - Backend FastAPI WebSocket connection & handshake
 * - Audio streaming via WsClient (16 kHz mono)
 * - Result normalization & dispatch to SyncBridge
 * - Double conversion prevention under playback rate 1.5x
 * - Strict 8-field schema validation via validate_log.py
 *
 * ALL METRICS LABELED SIMULATED.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const e2eNodeScript = path.join(__dirname, 'e2e_node.mjs');

const proc = spawn(process.execPath, [e2eNodeScript], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..')
});

proc.on('close', (code) => {
  if (code === 0) {
    console.log('\n[E2E Seams Simulator] All seam checks passed (Mode: SIMULATED).');
    process.exit(0);
  } else {
    console.error(`\n[E2E Seams Simulator] Seam check failed with code ${code}.`);
    process.exit(code || 1);
  }
});
