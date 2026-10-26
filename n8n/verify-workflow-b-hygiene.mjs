// High-confidence secret patterns only. Report filenames, never matching values
// or file contents. Does not read private .env files or the operator artifact.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const paths = [...readdirSync(here).filter(name => name.endsWith('.mjs') || name === 'workflow-b.env.example')
  .map(name => join(here, name)), ...process.argv.slice(2)];
const patterns = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\b\d{7,}:[A-Za-z0-9_-]{30,}\b/,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /["'](?:private_key|api_key|access_token|refresh_token|password)["']\s*:\s*["'][^"'\r\n]{20,}["']/i,
];
let failed = false;
for (const path of new Set(paths)) {
  try {
    const content = readFileSync(path, 'utf8');
    if (patterns.some(pattern => pattern.test(content))) {
      console.error(`Secret-pattern match; inspect privately: ${path}`); failed = true;
    }
  } catch {
    console.error(`Cannot complete secret scan: ${path}`); failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(JSON.stringify({ secret_hygiene: 'PASS', files_scanned: new Set(paths).size, matching_values_printed: false }));
