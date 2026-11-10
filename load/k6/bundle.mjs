#!/usr/bin/env node
// Builds load/k6/dpi-load.standalone.js: dpi-load.js with scenarios.json and thresholds.json inlined, because AWS
// Distributed Load Testing accepts ONE script file (no open() of sibling files). Run after editing either JSON:
//   node load/k6/bundle.mjs            (writes the file)
//   node load/k6/bundle.mjs --check    (exit 1 if the committed bundle is out of date)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

export function buildStandalone() {
  const script = read('dpi-load.js');
  const def = JSON.stringify(JSON.parse(read('../scenarios.json')));
  const thr = JSON.stringify(JSON.parse(read('../thresholds.json')));
  const re = /\/\/ >>> inputs[^\n]*\n[\s\S]*?\/\/ <<< inputs/;
  if (!re.test(script)) throw new Error('input markers not found in dpi-load.js');
  return script.replace(re, `// >>> inputs (inlined by bundle.mjs: DO NOT EDIT this generated file)\nconst DEF = ${def};\nconst THRESHOLDS = ${thr};\n// <<< inputs`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(dir, 'dpi-load.standalone.js');
  const next = buildStandalone();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (cur !== next) { console.error('dpi-load.standalone.js is out of date: run node load/k6/bundle.mjs'); process.exit(1); }
    console.log('standalone bundle is up to date');
  } else {
    fs.writeFileSync(out, next);
    console.log(`wrote ${out} (${next.length} bytes)`);
  }
}
