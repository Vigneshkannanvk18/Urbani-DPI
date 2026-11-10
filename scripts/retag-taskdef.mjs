#!/usr/bin/env node
// Reads a describe-task-definition `taskDefinition` JSON on stdin, swaps the container images and prints
// a register-task-definition input (read-only fields removed). Used by redeploy-dpi2.sh; no AWS calls.
//   node scripts/retag-taskdef.mjs [--backend IMAGE] [--frontend IMAGE] < current.json > next.json
import fs from 'node:fs';

const READ_ONLY = ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities',
  'registeredAt', 'registeredBy', 'deregisteredAt'];

export function retag(td, images) {
  const out = { ...td };
  for (const k of READ_ONLY) delete out[k];
  out.containerDefinitions = td.containerDefinitions.map((c) => (images[c.name] ? { ...c, image: images[c.name] } : c));
  return out;
}

if (process.argv[1]?.endsWith('retag-taskdef.mjs')) {
  const args = process.argv.slice(2);
  const images = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--backend') images.backend = args[i + 1];
    else if (args[i] === '--frontend') images.frontend = args[i + 1];
    else { console.error(`unknown argument ${args[i]}`); process.exit(2); }
  }
  const td = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(retag(td, images), null, 2)}\n`);
}
