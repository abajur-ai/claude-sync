// Checks the .cmd header guards: a payload that cannot be extracted must fail loudly, never run empty.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INSTALLER as SRC, sandbox } from './env.mjs';

const DIR = sandbox('installer-guard');
fs.mkdirSync(DIR, { recursive: true });
const run = (file, args) => spawnSync('cmd.exe', ['/d', '/c', file, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120e3, input: '' });
const text = fs.readFileSync(SRC, 'utf8');
const marker = ':::CLAUDE-SYNC-PAYLOAD:::';
const at = text.lastIndexOf(marker);

const cases = {
  intact: text,
  'no marker': `${text.slice(0, at)}XXX-NO-MARKER-XXX\r\n`,
  'truncated payload': `${text.slice(0, at + marker.length)}\r\nimport fs from 'node:fs';\r\n`,
  'empty payload': `${text.slice(0, at + marker.length)}\r\n`,
};
let bad = 0;
for (const [name, content] of Object.entries(cases)) {
  const file = path.join(DIR, `${name.replace(/\s+/g, '-')}.cmd`);
  fs.writeFileSync(file, content, 'utf8');
  const r = run(file, ['status']);
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0] || '(no output)';
  const ok = name === 'intact' ? r.status === 0 : r.status !== 0;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: exit ${r.status} :: ${out.slice(0, 110)}`);
}
// A stale boot file must never be run in place of the real payload.
const stale = path.join(process.env.TEMP, 'claude-sync-boot-STALE.mjs');
fs.writeFileSync(stale, 'console.log("STALE PAYLOAD RAN");\n');
const r = run(path.join(DIR, 'intact.cmd'), ['status']);
const usedStale = `${r.stdout}${r.stderr}`.includes('STALE PAYLOAD RAN');
console.log(`${usedStale ? 'FAIL' : 'PASS'} a leftover boot file is not used`);
fs.rmSync(stale, { force: true });
console.log(bad || usedStale ? 'GUARD FAILURES' : 'all guards ok');
process.exitCode = bad || usedStale ? 1 : 0;
