/* Copies non-TS assets (SQL migrations) into dist so the compiled runner can
 * find them at runtime. tsc does not copy non-code files. */
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
const destDir = path.join(__dirname, '..', 'dist', 'db', 'migrations');

fs.mkdirSync(destDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
  if (file.endsWith('.sql')) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
}
console.log('[copy-assets] migrations copied to dist');
