import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'node_modules', '@electric-sql', 'pglite', 'dist');
const destDir = path.join(__dirname, 'vendor', 'pglite');

// If vendor assets already exist (e.g. in repo or previous build), finish immediately
if (fs.existsSync(path.join(destDir, 'pglite.wasm'))) {
  console.log(`Vendor assets already populated at ${destDir}`);
  process.exit(0);
}

if (fs.existsSync(srcDir)) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  console.log(`Successfully copied PGlite assets to ${destDir}`);
} else if (fs.existsSync(destDir)) {
  console.log(`Vendor assets already exist at ${destDir}`);
} else {
  console.warn(`Source directory ${srcDir} not found.`);
}

process.exit(0);

