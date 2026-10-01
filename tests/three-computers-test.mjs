// Three computers of the same person on one private repository, built from the same pieces as tests/run-tests.mjs.
// Proves joins, propagation, deletion, newest-edit-wins, MEMORY.md union, notices and convergence with N = 3.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOOL, sandbox, claudeBin, testRepo, testToken, machineToken } from './env.mjs';

const ROOT = sandbox('three');
const SLUG = testRepo();
const REPO_URL = `https://github.com/${SLUG}.git`;
const CLAUDE_BIN = claudeBin();
const TOKEN = testToken();
const t0 = Date.now();

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 30, ...opts });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const encodeKey = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const jsonl = (rows) => `${rows.map((o) => JSON.stringify(o)).join('\n')}\n`;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `\n     ${String(detail).slice(0, 1200)}` : ''}`); }
};
const phase = (t) => console.log(`\n=== ${t} (${Math.round((Date.now() - t0) / 1000)}s)`);

function waitFor(fn, ms = 90e3) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; sleep(1000); }
  return false;
}

function machine(name, home, label, keyIndex) {
  const m = { name, label, home, token: machineToken(keyIndex) };
  m.claude = path.join(home, '.claude');
  m.sync = path.join(home, '.claude-sync');
  m.repo = path.join(m.sync, 'repo');
  m.desktop = path.join(home, 'Desktop');
  m.programs = path.join(ROOT, `${name}-programs.json`);
  m.env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: m.claude, CLAUDE_SYNC_FAKE_PROGRAMS: m.programs, CLAUDE_SYNC_CLAUDE_BIN: CLAUDE_BIN };
  delete m.env.CLAUDE_SYNC_DIR;
  m.project = path.join(m.claude, 'projects', encodeKey(m.desktop));
  m.memory = path.join(m.project, 'memory');
  m.script = () => (fs.existsSync(path.join(m.sync, 'claude-sync.mjs')) ? path.join(m.sync, 'claude-sync.mjs') : TOOL);
  m.tool = (args, opts = {}) => sh(process.execPath, [m.script(), ...args], { env: { ...m.env, ...(opts.env || {}) }, input: opts.input ?? '' });
  m.run = () => {
    const lock = path.join(m.sync, 'sync.lock');
    waitFor(() => !fs.existsSync(lock));
    const r = m.tool(['sync', '--quiet']);
    waitFor(() => !fs.existsSync(lock));
    if (r.status !== 0) console.log(`     [${name}] sync exit ${r.status}: ${r.stderr.trim()}`);
    return r;
  };
  m.hook = (sub, input) => m.tool(['hook', sub], { input: JSON.stringify(input || {}) });
  m.mcp = () => { try { return JSON.parse(read(path.join(m.claude, '.claude.json'))).mcpServers || {}; } catch { return {}; } };
  return m;
}

const A = machine('office', path.join(ROOT, 'office', 'Users', 'joao.silva'), 'One', 0);
const B = machine('house', path.join(ROOT, 'house', 'Users', 'Ana Silva'), 'Two', 1);
const C = machine('laptop', path.join(ROOT, 'laptop', 'Users', 'carla.souza'), 'Three', 2);
const ALL = [A, B, C];

// Everything a person would compare between computers, with each computer's own home folder made neutral.
function snapshot(m) {
  const out = {};
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      if (fs.statSync(p).isDirectory()) walk(p, r); else out[r] = read(p).split(m.home).join('{{HOME}}').split(m.home.replace(/\\/g, '\\\\')).join('{{HOME}}');
    }
  };
  for (const d of ['skills', 'agents', 'commands', 'rules']) walk(path.join(m.claude, d), d);
  walk(m.memory, 'memory');
  if (fs.existsSync(path.join(m.claude, 'CLAUDE.md'))) out['CLAUDE.md'] = read(path.join(m.claude, 'CLAUDE.md')).split(m.home).join('{{HOME}}');
  return out;
}
const differences = (x, y) => [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => x[k] !== y[k]);

phase('setup: clean sandboxes and an empty private repository');
fs.rmSync(ROOT, { recursive: true, force: true });
{
  const env = { ...process.env, GH_TOKEN: TOKEN };
  sh('gh', ['repo', 'delete', SLUG, '--yes'], { env });
  sleep(4000);
  const r = sh('gh', ['repo', 'create', SLUG, '--private', '--description', 'claude-sync three computers test data'], { env });
  check('test repository created (private)', r.status === 0, r.stderr);
  sleep(4000);
}
const basePrograms = JSON.stringify({ winget: ['Git.Git', 'OpenJS.NodeJS'], npm: ['npm'], pip: ['pip'] });
for (const m of ALL) write(m.programs, basePrograms);

phase('computer 1 (office) seeds the repository');
write(path.join(A.claude, 'CLAUDE.md'), `# Rules\nSave files in ${A.desktop}\n`);
write(path.join(A.claude, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: test\n---\nSay hello.\n');
write(path.join(A.claude, 'rules', 'shared.md'), 'v1 from office\n');
write(path.join(A.memory, 'MEMORY.md'), '- [Profile](user_profile.md) - who the user is\n');
write(path.join(A.memory, 'user_profile.md'), 'Works in sales.\n');
{
  const r = A.tool(['install', '--repo', REPO_URL, '--name', A.label, '--token', A.token, '--no-task']);
  check('office: install exits 0', r.status === 0, r.stderr + r.stdout);
}

phase('computer 2 (house) joins');
write(path.join(B.memory, 'MEMORY.md'), '- [House](house_only.md) - house note\n');
write(path.join(B.memory, 'house_only.md'), 'Only at house.\n');
{
  const r = B.tool(['install', '--repo', REPO_URL, '--name', B.label, '--token', B.token, '--no-task']);
  check('house: install exits 0', r.status === 0, r.stderr + r.stdout);
  check('house: received the office skill and memory', fs.existsSync(path.join(B.claude, 'skills', 'hello', 'SKILL.md')) && fs.existsSync(path.join(B.memory, 'user_profile.md')));
}

phase('computer 3 (laptop) joins the same repository, the same way as the second');
write(path.join(C.memory, 'MEMORY.md'), '- [Laptop](laptop_only.md) - laptop note\n');
write(path.join(C.memory, 'laptop_only.md'), 'Only at laptop.\n');
sh(CLAUDE_BIN, ['mcp', 'add-json', 'laptop-mcp', JSON.stringify({ type: 'http', url: 'https://example.com/mcp' }), '-s', 'user'], { env: C.env, cwd: C.home });
{
  const r = C.tool(['install', '--repo', REPO_URL, '--name', C.label, '--token', C.token, '--no-task']);
  check('laptop: install exits 0', r.status === 0, r.stderr + r.stdout);
  check('laptop: received what the office seeded', fs.existsSync(path.join(C.claude, 'skills', 'hello', 'SKILL.md')) && read(path.join(C.claude, 'CLAUDE.md')).includes(`Save files in ${C.desktop}`));
  check('laptop: received what the house added', fs.existsSync(path.join(C.memory, 'house_only.md')));
  check('laptop: kept its own memory', fs.existsSync(path.join(C.memory, 'laptop_only.md')));
  const idx = read(path.join(C.memory, 'MEMORY.md'));
  check('laptop: MEMORY.md has lines from all three computers', ['user_profile.md', 'house_only.md', 'laptop_only.md'].every((x) => idx.includes(x)), idx);
}

phase('the first two computers pull what the third brought');
A.run(); B.run();
for (const m of [A, B]) {
  check(`${m.name}: laptop memory arrived`, fs.existsSync(path.join(m.memory, 'laptop_only.md')));
  check(`${m.name}: laptop MCP server arrived`, !!m.mcp()['laptop-mcp'], JSON.stringify(m.mcp()));
  const idx = read(path.join(m.memory, 'MEMORY.md'));
  check(`${m.name}: MEMORY.md has lines from all three computers`, ['user_profile.md', 'house_only.md', 'laptop_only.md'].every((x) => idx.includes(x)), idx);
}
{
  const hook = A.hook('session-start', { source: 'startup' });
  check('office: Claude is told what arrived and from which computer', /\[claude-sync\]/.test(hook.stdout) && /Three/.test(hook.stdout), hook.stdout);
}

phase('an edit on computer 3 reaches computers 1 and 2');
write(path.join(C.memory, 'user_profile.md'), 'Works in sales and in marketing.\n');
C.run(); A.run(); B.run();
for (const m of [A, B]) check(`${m.name}: edit made on the laptop arrived`, read(path.join(m.memory, 'user_profile.md')).includes('marketing'));

phase('a deletion on computer 2 reaches computers 1 and 3');
fs.rmSync(path.join(B.memory, 'house_only.md'));
B.run(); A.run(); C.run();
for (const m of [A, C]) check(`${m.name}: file deleted at the house is gone`, !fs.existsSync(path.join(m.memory, 'house_only.md')));

phase('the same file edited on computers 1 and 3 before syncing: the newest edit wins everywhere');
write(path.join(A.claude, 'rules', 'shared.md'), 'v2 from office\n');
sleep(2500);
write(path.join(C.claude, 'rules', 'shared.md'), 'v3 from laptop\n');
A.run(); C.run(); B.run(); A.run();
for (const m of ALL) check(`${m.name}: shared.md holds the newest edit`, read(path.join(m.claude, 'rules', 'shared.md')) === 'v3 from laptop\n', read(path.join(m.claude, 'rules', 'shared.md')));

phase('MEMORY.md edited on all three before syncing: every line is kept');
for (const [m, line] of [[A, '- [A](a.md) - from office'], [B, '- [B](b.md) - from house'], [C, '- [C](c.md) - from laptop']]) {
  fs.appendFileSync(path.join(m.memory, 'MEMORY.md'), `${line}\n`);
}
A.run(); B.run(); C.run(); A.run(); B.run();
for (const m of ALL) {
  const idx = read(path.join(m.memory, 'MEMORY.md'));
  check(`${m.name}: MEMORY.md has the three new lines`, ['from office', 'from house', 'from laptop'].every((x) => idx.includes(x)), idx);
}

phase('a conversation started on computer 3 continues on computers 1 and 2');
const SID = '33333333-3333-4333-8333-333333333333';
write(path.join(C.project, `${SID}.jsonl`), jsonl([{ type: 'user', cwd: C.desktop, sessionId: SID, message: 'hello from the laptop' }]));
C.run(); A.run(); B.run();
for (const m of [A, B]) {
  const p = path.join(m.project, `${SID}.jsonl`);
  check(`${m.name}: laptop conversation arrived with its own path`, fs.existsSync(p) && read(p).includes(JSON.stringify(m.desktop).slice(1, -1)), fs.existsSync(p) ? read(p) : 'missing');
}

phase('all three computers converge');
const snaps = ALL.map(snapshot);
check('office and house hold the same content', differences(snaps[0], snaps[1]).length === 0, differences(snaps[0], snaps[1]).join(', '));
check('office and laptop hold the same content', differences(snaps[0], snaps[2]).length === 0, differences(snaps[0], snaps[2]).join(', '));
{
  const statusDir = path.join(A.repo, 'status');
  const labels = fs.readdirSync(statusDir).map((n) => JSON.parse(read(path.join(statusDir, n))).label).sort();
  check('repository keeps one status file per computer (3)', JSON.stringify(labels) === JSON.stringify(['One', 'Three', 'Two']), JSON.stringify(labels));
}

phase('cleanup: test repository and sandboxes');
{
  const r = sh('gh', ['repo', 'delete', SLUG, '--yes'], { env: { ...process.env, GH_TOKEN: TOKEN } });
  check('test repository deleted', r.status === 0, r.stderr);
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(fail ? 1 : 0);
