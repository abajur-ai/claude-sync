// Chaos test for claude-sync: two isolated "computers" with different user names, hundreds of rounds of
// random concurrent edits with injected faults (process killed mid-sync, remote unreachable, stale lock,
// corrupted state, deleted clone, open session, wrong clock, deleted branch, and against GitHub also moves
// to a fresh repository: plain, stopped after a step, killed at a random moment, and both at once),
// followed by a quiet settle.
// After every settle an oracle checks: both computers converged, every version ever written is either the
// final content or saved as a conflict copy (no silent loss), deletions propagated, syncs exit 0, and one
// more sync changes nothing. Model-free.
//
//   node chaos-tests.mjs                       150 rounds against a local bare repository (fast)
//   CHAOS_ROUNDS=40 CHAOS_SEED=7 node chaos-tests.mjs
//   CHAOS_REMOTE=https://github.com/<owner>/<throwaway-repo>.git node chaos-tests.mjs
//   CHAOS_MOVE_WEIGHT=4 with CHAOS_REMOTE makes moves about one round in three
// Against GitHub the repository, and every repository whose name starts with it and a dash, is deleted
// and recreated.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';

import { TOOL, sandbox, claudeBin, testToken, machineToken } from './env.mjs';

const ROOT = sandbox('chaos');
const CLAUDE_BIN = claudeBin();
const REMOTE_DIR = path.join(ROOT, 'remote.git');
const REMOTE_URL = process.env.CHAOS_REMOTE || `file:///${REMOTE_DIR.replace(/\\/g, '/')}`;
const ON_GITHUB = REMOTE_URL.startsWith('https://');
const ROUNDS = Number(process.env.CHAOS_ROUNDS || 150);
const SEED = Number(process.env.CHAOS_SEED || (Date.now() % 100000));
const NODE = process.execPath;

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 30, ...opts });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const encodeKey = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const t0 = Date.now();
const elapsed = () => `${Math.round((Date.now() - t0) / 1000)}s`;

// Seeded PRNG so a failing run can be replayed with the same CHAOS_SEED.
let rngState = SEED >>> 0 || 1;
const rand = () => { rngState = (rngState + 0x6D2B79F5) >>> 0; let t = rngState; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const weighted = (table) => { const total = table.reduce((s, [, w]) => s + w, 0); let x = rand() * total; for (const [v, w] of table) { x -= w; if (x <= 0) return v; } return table[table.length - 1][0]; };

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` :: ${String(detail).slice(0, 600)}` : ''}`); console.log(`FAIL ${name}${detail ? `\n     ${String(detail).slice(0, 1200)}` : ''}`); }
}

const TOKEN = ON_GITHUB ? testToken() : 'local-token';
// Each computer installs with its own key, as in a real setup.
const KEY = ON_GITHUB ? [machineToken(0), machineToken(1)] : [TOKEN, TOKEN];

// ---------------------------------------------------------------------------------------------
// Two computers

function machine(name, userName, label) {
  const home = path.join(ROOT, name, 'Users', userName);
  const m = { name, label, home };
  m.claude = path.join(home, '.claude');
  m.sync = path.join(home, '.claude-sync');
  m.repo = path.join(m.sync, 'repo');
  m.desktop = path.join(home, 'Desktop');
  m.key = encodeKey(m.desktop);
  m.project = path.join(m.claude, 'projects', m.key);
  m.memory = path.join(m.project, 'memory');
  m.claudeJson = path.join(m.claude, '.claude.json');
  m.programs = path.join(ROOT, `${name}-programs.json`);
  m.env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: m.claude, CLAUDE_SYNC_FAKE_PROGRAMS: m.programs, CLAUDE_SYNC_CLAUDE_BIN: CLAUDE_BIN };
  delete m.env.CLAUDE_SYNC_DIR;
  m.installed = path.join(m.sync, 'claude-sync.mjs');
  m.script = () => (exists(m.installed) ? m.installed : TOOL);
  m.lock = path.join(m.sync, 'sync.lock');
  m.tool = (args, opts = {}) => sh(NODE, [m.script(), ...args], { env: { ...m.env, ...(opts.env || {}) }, input: '', timeout: 10 * 60e3 });
  m.waitIdle = () => { const end = Date.now() + 120e3; while (exists(m.lock) && Date.now() < end) sleep(100); };
  m.run = (...extra) => { m.waitIdle(); const r = m.tool(['sync', '--quiet', ...extra]); m.waitIdle(); return r; };
  m.syncAsync = (...extra) => spawn(NODE, [m.script(), 'sync', '--quiet', ...extra], { env: m.env, stdio: 'ignore', windowsHide: true });
  m.state = () => { try { return JSON.parse(read(path.join(m.sync, 'state.json'))); } catch { try { return JSON.parse(read(path.join(m.sync, 'state.json.bak'))); } catch { return null; } } };
  m.log = () => { try { return read(path.join(m.sync, 'sync.log')); } catch { return ''; } };
  // Home path in the four forms the tool translates, so content can be compared across computers.
  const fwd = home.replace(/\\/g, '/');
  m.homeForms = [home.replace(/\\/g, '\\\\'), home, fwd, `/${fwd[0].toLowerCase()}${fwd.slice(2)}`].map((f) => Buffer.from(f, 'utf8').toString('latin1')); // files are read as latin1
  m.normalize = (text) => { let s = text; for (const f of m.homeForms) s = s.split(f).join('{{H}}'); return s; };
  m.normalizeKey = (rel) => rel.replace(new RegExp(`^projects/${encodeKey(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), 'projects/{{HOME}}');
  return m;
}

const office = machine('one', 'user-one', 'One');
const house = machine('two', 'User Two', 'Two');
const BOTH = [office, house];
const other = (m) => (m === office ? house : office);

const isTranscript = (logical) => /^projects\/[^/]+\/[^/]+\.jsonl$/.test(logical);
const isMemoryMd = (logical) => /^projects\/[^/]+\/memory\/MEMORY\.md$/.test(logical);

// Everything claude-sync is expected to carry, as { logical -> normalized content }.
function snapshot(m) {
  const out = new Map();
  const skipTop = new Set(['plugins', 'sessions', 'file-history', 'plans', 'debug', 'paste-cache', 'image-cache', 'uploads', 'session-env', 'tasks', 'shell-snapshots', 'backups', 'todos', 'statsig', 'logs', 'cache', 'ide', 'history.jsonl', 'settings.local.json']);
  const walk = (dir, rel) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const abs = path.join(dir, n);
      const st = fs.statSync(abs);
      const r = rel ? `${rel}/${n}` : n;
      if (!rel && (n.startsWith('.') || skipTop.has(n.toLowerCase()))) continue;
      if (st.isDirectory()) { walk(abs, r); continue; }
      if (/\.ccsync-tmp$/.test(n)) continue;
      if (/^projects\/[^/]+\/[^/]+\.jsonl$/.test(r) && n.includes('.orphaned-')) continue;
      out.set(m.normalizeKey(r), m.normalize(fs.readFileSync(abs, 'latin1')));
    }
  };
  walk(m.claude, '');
  try {
    const cfg = JSON.parse(read(m.claudeJson));
    for (const [name, server] of Object.entries(cfg.mcpServers || {})) out.set(`mcp/${name}`, m.normalize(mcpText(server)));
  } catch { /* no config */ }
  return out;
}
// Same text claude-sync stores and saves as a conflict copy, read back as latin1 like every file here.
const mcpText = (server) => Buffer.from(JSON.stringify(sortKeys(server), null, 2) + '\n', 'utf8').toString('latin1');
function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])); return v; }

function conflictsOf(m) {
  const out = new Set();
  const walk = (dir) => { let names = []; try { names = fs.readdirSync(dir); } catch { return; } for (const n of names) { const p = path.join(dir, n); if (fs.statSync(p).isDirectory()) walk(p); else out.add(m.normalize(fs.readFileSync(p, 'latin1'))); } };
  walk(path.join(m.sync, 'conflicts'));
  return out;
}

const authEnv = () => ({
  ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
});
const remoteTip = () => {
  // After a move the sync lives in another repository: follow the one the office is on.
  if (ON_GITHUB) return sh('git', ['ls-remote', '--heads', office.state()?.repoUrl || REMOTE_URL, 'main'], { env: authEnv() }).stdout.trim().split(/\s+/)[0] || '';
  return sh('git', ['--git-dir', REMOTE_DIR, 'rev-parse', '--verify', '-q', 'refs/heads/main']).stdout.trim();
};

// ---------------------------------------------------------------------------------------------
// Content generators (deterministic under the seed)

const words = ['memory', 'client', 'meeting', 'budget', 'proposal', 'board', 'action', 'report', 'monday', 'ç', 'ã', 'é', 'Ω', '日本語', 'emoji 🎯'];
const sentence = () => Array.from({ length: randInt(4, 12) }, () => pick(words)).join(' ');
const uuid = () => crypto.randomUUID();
let counter = 0;
const nextId = () => ++counter;
// Dates inside conversations are recent, as they are in real use: a move leaves behind only what has not
// been used for months. One seeded conversation is old on purpose, so the cut happens during the chaos.
const TS_BASE = Date.now() - 86400e3;
const jsonlLine = (m, i, base = TS_BASE) => JSON.stringify({ type: pick(['user', 'assistant']), uuid: uuid(), timestamp: new Date(base + i * 1000).toISOString(), cwd: m.desktop, message: { role: 'user', content: sentence() } });

function seedOffice(m) {
  write(path.join(m.claude, 'CLAUDE.md'), `# Global rules\n\n- Always answer in the language of the question.\n- Files in ${m.desktop}\n`);
  write(path.join(m.claude, 'rules', 'style.md'), 'Frases curtas.\n');
  write(path.join(m.claude, 'settings.json'), JSON.stringify({
    cleanupPeriodDays: 30,
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${m.home}\\.claude\\tools\\ponytail.mjs"` }] }] },
    enabledPlugins: {},
    permissions: { allow: ['Bash(git status)'] },
  }, null, 2));
  write(path.join(m.claude, 'keybindings.json'), '{\n  "bindings": []\n}\n');
  for (let i = 1; i <= 6; i++) {
    write(path.join(m.claude, 'skills', `skill-${i}`, 'SKILL.md'), `---\nname: skill-${i}\ndescription: skill ${i}\n---\n# Skill ${i}\n${sentence()}\n`);
    write(path.join(m.claude, 'skills', `skill-${i}`, 'helper.py'), `print("skill ${i}")\n`);
  }
  write(path.join(m.claude, 'skills', 'skill-2', '.gitignore'), '*\n');
  write(path.join(m.claude, 'skills', 'skill-3', 'data', '.gitattributes'), '* text=auto\n');
  write(path.join(m.claude, 'agents', 'revisor.md'), '---\nname: revisor\n---\nRevisa textos.\n');
  write(path.join(m.claude, 'commands', 'resumo.md'), 'Resuma o arquivo.\n');
  write(path.join(m.memory, 'MEMORY.md'), '# Índice\n- [Cliente A](project_cliente_a.md)\n');
  for (let i = 1; i <= 20; i++) write(path.join(m.memory, `project_item_${i}.md`), `---\nname: item ${i}\n---\n${sentence()}\nCaminho: ${m.desktop}\\doc${i}.docx\n`);
  for (let i = 0; i < 4; i++) write(path.join(m.project, `${uuid()}.jsonl`), Array.from({ length: 50 }, (_, k) => jsonlLine(m, k)).join('\n') + '\n');
  write(path.join(m.project, `${uuid()}.jsonl`), Array.from({ length: 20 }, (_, k) => jsonlLine(m, k, Date.now() - 400 * 86400e3)).join('\n') + '\n');
  write(m.claudeJson, JSON.stringify({ numStartups: 3, mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--user-data-dir', `${m.home}\\pw`] }, filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', m.desktop] } } }, null, 2));
  write(m.programs, JSON.stringify({ winget: ['Git.Git', 'OpenJS.NodeJS.LTS'], npm: ['@anthropic-ai/claude-code'], pip: ['playwright'] }));
}

function seedHouse(m) {
  write(path.join(m.claude, 'CLAUDE.md'), '# Older rules from computer two\n');
  write(path.join(m.claude, 'skills', 'house-only', 'SKILL.md'), '---\nname: house-only\n---\nSó da casa.\n');
  for (let i = 1; i <= 5; i++) write(path.join(m.memory, `house_item_${i}.md`), `Da casa ${i}: ${sentence()}\n`);
  write(path.join(m.memory, 'MEMORY.md'), '# Índice\n- [Casa](house_item_1.md)\n');
  write(path.join(m.project, `${uuid()}.jsonl`), Array.from({ length: 10 }, (_, k) => jsonlLine(m, k)).join('\n') + '\n');
  write(m.claudeJson, JSON.stringify({ numStartups: 1, mcpServers: { casa: { command: 'node', args: ['casa.js'] } } }, null, 2));
  write(m.programs, JSON.stringify({ winget: ['Git.Git'], npm: [], pip: [] }));
}

// ---------------------------------------------------------------------------------------------
// Mutations. Each records what it wrote in the round journal: { m, logical, content|null }.

function listMemory(m) { try { return fs.readdirSync(m.memory).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md'); } catch { return []; } }
function listSkills(m) { try { return fs.readdirSync(path.join(m.claude, 'skills')); } catch { return []; } }
function listTranscripts(m) { try { return fs.readdirSync(m.project).filter((n) => n.endsWith('.jsonl') && !n.includes('.orphaned-')); } catch { return []; } }
const rel = (m, abs) => m.normalizeKey(path.relative(m.claude, abs).replace(/\\/g, '/'));

function record(journal, m, abs, content) {
  journal.push({ m, logical: rel(m, abs), content: content === null ? null : m.normalize(Buffer.from(content, 'utf8').toString('latin1')), abs });
}

const MUTATIONS = [
  ['memAdd', 14], ['memEdit', 14], ['memDel', 6], ['memoryMd', 8], ['skillAdd', 5], ['skillEdit', 7], ['skillDel', 3], ['skillIgnore', 2],
  ['claudeMd', 5], ['settings', 4], ['transcriptAppend', 16], ['transcriptNew', 5], ['transcriptBig', ON_GITHUB ? 0 : 1],
  ['mcpAdd', 2], ['mcpDel', 1], ['rules', 3], ['command', 2],
];

function mutate(m, kind, journal) {
  const n = nextId();
  switch (kind) {
    case 'memAdd': { const p = path.join(m.memory, `note_${n}.md`); const c = `---\nname: note ${n}\n---\n${sentence()} (${m.label})\nArquivo: ${m.desktop}\\n${n}.txt\n`; write(p, c); record(journal, m, p, c); return `memAdd note_${n}`; }
    case 'memEdit': { const names = listMemory(m); if (!names.length) return mutate(m, 'memAdd', journal); const p = path.join(m.memory, pick(names)); const c = `${read(p)}Edição ${n} em ${m.label}: ${sentence()}\n`; write(p, c); record(journal, m, p, c); return `memEdit ${path.basename(p)}`; }
    case 'memDel': { const names = listMemory(m); if (names.length < 4) return mutate(m, 'memAdd', journal); const p = path.join(m.memory, pick(names)); fs.rmSync(p); record(journal, m, p, null); return `memDel ${path.basename(p)}`; }
    case 'memoryMd': { const p = path.join(m.memory, 'MEMORY.md'); const c = `${exists(p) ? read(p) : '# Índice\n'}- [Linha ${n} de ${m.label}](note_${n}.md)\n`; write(p, c); record(journal, m, p, c); return `memoryMd +line ${n}`; }
    case 'skillAdd': { const d = path.join(m.claude, 'skills', `skill-${m.name}-${n}`); const c1 = `---\nname: skill-${n}\n---\n${sentence()}\n`; const c2 = `# ${n}\n`; write(path.join(d, 'SKILL.md'), c1); write(path.join(d, 'src', 'main.py'), c2); record(journal, m, path.join(d, 'SKILL.md'), c1); record(journal, m, path.join(d, 'src', 'main.py'), c2); return `skillAdd ${path.basename(d)}`; }
    case 'skillEdit': { const names = listSkills(m); if (!names.length) return mutate(m, 'skillAdd', journal); const p = path.join(m.claude, 'skills', pick(names), 'SKILL.md'); const c = `${exists(p) ? read(p) : ''}Ajuste ${n} (${m.label}): ${sentence()}\n`; write(p, c); record(journal, m, p, c); return `skillEdit ${path.basename(path.dirname(p))}`; }
    case 'skillDel': { const names = listSkills(m).filter((s) => s.startsWith('skill-') && s !== 'skill-1'); if (names.length < 3) return mutate(m, 'skillAdd', journal); const d = path.join(m.claude, 'skills', pick(names)); const files = []; const walk = (x) => { for (const y of fs.readdirSync(x)) { const q = path.join(x, y); if (fs.statSync(q).isDirectory()) walk(q); else files.push(q); } }; walk(d); fs.rmSync(d, { recursive: true, force: true }); for (const f of files) record(journal, m, f, null); return `skillDel ${path.basename(d)}`; }
    case 'skillIgnore': { const names = listSkills(m); if (!names.length) return mutate(m, 'skillAdd', journal); const p = path.join(m.claude, 'skills', pick(names), '.gitignore'); const c = `*.log\n# ${n}\n`; write(p, c); record(journal, m, p, c); return `skillIgnore ${path.basename(path.dirname(p))}`; }
    case 'claudeMd': { const p = path.join(m.claude, 'CLAUDE.md'); const c = `${exists(p) ? read(p) : ''}\n## Regra ${n} (${m.label})\n${sentence()}\n`; write(p, c); record(journal, m, p, c); return `claudeMd +rule ${n}`; }
    case 'settings': { const p = path.join(m.claude, 'settings.json'); const s = JSON.parse(read(p)); s[`chaos_${n}`] = sentence(); const c = JSON.stringify(s, null, 2); write(p, c); record(journal, m, p, c); return `settings +chaos_${n}`; }
    case 'transcriptAppend': { const names = listTranscripts(m); if (!names.length) return mutate(m, 'transcriptNew', journal); const p = path.join(m.project, pick(names)); const c = `${read(p)}${Array.from({ length: randInt(1, 5) }, (_, k) => jsonlLine(m, n * 10 + k)).join('\n')}\n`; write(p, c); record(journal, m, p, c); return `transcriptAppend ${path.basename(p).slice(0, 8)}`; }
    case 'transcriptNew': { const p = path.join(m.project, `${uuid()}.jsonl`); const c = `${Array.from({ length: randInt(3, 30) }, (_, k) => jsonlLine(m, k)).join('\n')}\n`; write(p, c); record(journal, m, p, c); return `transcriptNew ${path.basename(p).slice(0, 8)}`; }
    case 'transcriptBig': { const p = path.join(m.project, `${uuid()}.jsonl`); const big = Array.from({ length: 30000 }, (_, k) => JSON.stringify({ i: k, pad: crypto.randomBytes(120).toString('base64'), cwd: m.desktop })).join('\n') + '\n'; write(p, big); record(journal, m, p, big); return `transcriptBig ${(big.length / 1e6).toFixed(1)}MB`; }
    case 'mcpAdd': { const cfg = JSON.parse(read(m.claudeJson)); cfg.mcpServers ||= {}; const name = `chaos-${n}`; cfg.mcpServers[name] = { command: 'node', args: [`${m.home}\\mcp\\${name}.js`, String(n)], env: { CHAOS: String(n) } }; write(m.claudeJson, JSON.stringify(cfg, null, 2)); journal.push({ m, logical: `mcp/${name}`, content: m.normalize(mcpText(cfg.mcpServers[name])) }); return `mcpAdd ${name}`; }
    case 'mcpDel': { const cfg = JSON.parse(read(m.claudeJson)); const names = Object.keys(cfg.mcpServers || {}).filter((x) => x.startsWith('chaos-')); if (!names.length) return mutate(m, 'mcpAdd', journal); const name = pick(names); delete cfg.mcpServers[name]; write(m.claudeJson, JSON.stringify(cfg, null, 2)); journal.push({ m, logical: `mcp/${name}`, content: null }); return `mcpDel ${name}`; }
    case 'rules': { const p = path.join(m.claude, 'rules', `regra-${n}.md`); const c = `${sentence()}\n`; write(p, c); record(journal, m, p, c); return `rules regra-${n}`; }
    case 'command': { const p = path.join(m.claude, 'commands', `cmd-${n}.md`); const c = `${sentence()}\n`; write(p, c); record(journal, m, p, c); return `command cmd-${n}`; }
    default: throw new Error(kind);
  }
}

// ---------------------------------------------------------------------------------------------
// Faults

const FAULTS = [
  ['none', 30], ['concurrent', 16], ['kill', 16], ['netdown', ON_GITHUB ? 0 : 8], ['stalelock', 5], ['corruptstate', 5],
  ['repodel', 5], ['sessionopen', 6], ['clockskew', 5], ['branchdel', ON_GITHUB ? 0 : 3], ['doubleconcurrent', 4],
  // Moving to a fresh repository needs the GitHub API, so it only happens against GitHub.
  // CHAOS_MOVE_WEIGHT makes moves more frequent for a run dedicated to them.
  ...[['move', 3], ['moveStop', 3], ['moveKill', 3], ['moveRace', 2]].map(([k, w]) => [k, ON_GITHUB ? w * Number(process.env.CHAOS_MOVE_WEIGHT || 1) : 0]),
];

function killTree(child) { sh('taskkill', ['/PID', String(child.pid), '/T', '/F']); }
const waitExit = (child) => new Promise((resolve) => { if (child.exitCode !== null) return resolve(child.exitCode); child.on('exit', (code) => resolve(code)); });

async function applyFault(fault, journal, roundInfo) {
  const m = pick(BOTH);
  switch (fault) {
    case 'none': { pick(BOTH).run(); return; }
    case 'concurrent': { const a = office.syncAsync(); const b = house.syncAsync(); await Promise.all([waitExit(a), waitExit(b)]); return; }
    case 'doubleconcurrent': { const cs = [office.syncAsync(), office.syncAsync(), house.syncAsync(), house.syncAsync()]; await Promise.all(cs.map(waitExit)); return; }
    case 'kill': {
      const child = m.syncAsync();
      const delay = randInt(100, 2500);
      await new Promise((r) => setTimeout(r, delay));
      if (child.exitCode === null) { killTree(child); roundInfo.killed = `${m.name} after ${delay}ms`; }
      await waitExit(child);
      other(m).run();
      return;
    }
    case 'netdown': {
      fs.renameSync(REMOTE_DIR, `${REMOTE_DIR}.down`);
      const ra = office.run(); const rb = house.run();
      fs.renameSync(`${REMOTE_DIR}.down`, REMOTE_DIR);
      check('netdown: both syncs fail loudly (exit 1) while the remote is unreachable', ra.status === 1 && rb.status === 1, `${ra.status}/${rb.status} ${ra.stderr}`);
      check('netdown: the failure is recorded in state.lastError', !!office.state()?.lastError && !!house.state()?.lastError);
      return;
    }
    case 'stalelock': {
      write(m.lock, JSON.stringify({ pid: 999999, at: Date.now() - 3600e3 }));
      const old = new Date(Date.now() - 3600e3); fs.utimesSync(m.lock, old, old);
      const r = m.run();
      check('stalelock: a lock from a dead process is removed and the sync runs', r.status === 0 && !exists(m.lock), r.stderr);
      return;
    }
    case 'corruptstate': {
      const sf = path.join(m.sync, 'state.json');
      if (exists(`${sf}.bak`)) { write(sf, '{"machineId": "gar'); const r = m.run(); check('corruptstate: sync survives a truncated state.json using the backup', r.status === 0 && !!m.state()?.repoUrl, r.stderr); }
      return;
    }
    case 'repodel': { fs.rmSync(m.repo, { recursive: true, force: true }); const r = m.run(); check('repodel: a deleted local clone is fetched again', r.status === 0 && exists(path.join(m.repo, '.git')), r.stderr); return; }
    case 'sessionopen': {
      const names = listTranscripts(m);
      if (!names.length) return;
      const sid = pick(names).replace(/\.jsonl$/, '');
      const f = path.join(m.claude, 'sessions', `${process.pid}.json`);
      write(f, JSON.stringify({ pid: process.pid, sessionId: sid, cwd: m.desktop, startedAt: Date.now() }));
      m.run(); other(m).run(); m.run();
      fs.rmSync(f, { force: true });
      roundInfo.sessionOpen = `${m.name}:${sid.slice(0, 8)}`;
      return;
    }
    case 'clockskew': {
      const skew = pick([2 * 86400e3, -3 * 86400e3, 365 * 86400e3]);
      for (const j of journal) if (j.m === m && j.abs && j.content !== null && exists(j.abs)) { const d = new Date(Date.now() + skew); fs.utimesSync(j.abs, d, d); }
      m.run(); other(m).run();
      roundInfo.skew = `${m.name} ${skew / 86400e3}d`;
      return;
    }
    case 'move': {
      const r = m.tool(['rotate', '--yes']);
      check('move: rotate exits 0', r.status === 0, `${r.stderr}\n${r.stdout.slice(-600)}`);
      roundInfo.moved = `${m.name} -> ${(m.state()?.repoUrl || '').split('/').pop()}`;
      return;
    }
    case 'moveStop': {
      // Stopped right after one of the steps, like a laptop closed at that moment; a later move or the
      // next sync has to pick it up.
      const step = pick(['created', 'seeded', 'noted']);
      const r = m.tool(['rotate', '--yes'], { env: { CLAUDE_SYNC_TEST_STOP_AFTER: step } });
      check(`moveStop: rotate stops after "${step}" as asked`, r.status === 3, `${r.status} ${r.stderr}`);
      roundInfo.moveStopped = `${m.name} after ${step}`;
      return;
    }
    case 'moveKill': {
      const child = spawn(NODE, [m.script(), 'rotate', '--yes'], { env: m.env, stdio: 'ignore', windowsHide: true });
      const delay = randInt(500, 25000);
      await new Promise((r) => setTimeout(r, delay));
      if (child.exitCode === null) { killTree(child); roundInfo.moveKilled = `${m.name} after ${delay}ms`; }
      await waitExit(child);
      other(m).run();
      return;
    }
    case 'moveRace': {
      const spawnRotate = (x) => spawn(NODE, [x.script(), 'rotate', '--yes'], { env: x.env, stdio: 'ignore', windowsHide: true });
      const a = spawnRotate(office); const b = spawnRotate(house);
      const codes = await Promise.all([waitExit(a), waitExit(b)]);
      check('moveRace: both moves exit 0', codes.every((c) => c === 0), codes.join('/'));
      roundInfo.moveRace = codes.join('/');
      return;
    }
    case 'branchdel': {
      sh('git', ['--git-dir', REMOTE_DIR, 'update-ref', '-d', 'refs/heads/main']);
      const r1 = m.run(); const r2 = other(m).run();
      check('branchdel: both computers recover after the remote branch disappears', r1.status === 0 && r2.status === 0 && !!remoteTip(), `${r1.stderr} ${r2.stderr}`);
      return;
    }
    default: throw new Error(fault);
  }
}

// ---------------------------------------------------------------------------------------------
// Oracle

const lines = (s) => new Set(s.split('\n').map((x) => x.trimEnd()).filter((x) => x.trim()));
const subset = (a, b) => [...a].every((x) => b.has(x));

function oracle(round, journal, prevFinal, snapA, snapB, roundInfo) {
  const finalA = snapshot(office);
  const finalB = snapshot(house);
  const conflicts = new Set([...conflictsOf(office), ...conflictsOf(house)]);
  const keys = new Set([...finalA.keys(), ...finalB.keys(), ...snapA.keys(), ...snapB.keys()]);

  // 1. Convergence.
  const diverged = [];
  for (const k of keys) if (finalA.get(k) !== finalB.get(k)) diverged.push(`${k} A=${finalA.has(k) ? sha(finalA.get(k)) : '-'} B=${finalB.has(k) ? sha(finalB.get(k)) : '-'}`);
  check(`round ${round}: both computers converged`, !diverged.length, diverged.slice(0, 8).join('\n     '));
  const final = finalA;

  // 2. The final content of every path is explainable from what each side had before the settle.
  for (const k of keys) {
    const a = snapA.get(k); const b = snapB.get(k); const f = final.get(k); const p = prevFinal.get(k);
    let ok; let why = '';
    if (isTranscript(k)) {
      ok = f !== undefined && [a, b].filter((x) => x !== undefined).every((x) => f.startsWith(x) || f.length >= x.length);
      if (a !== undefined && b !== undefined && a !== b && !(a.startsWith(b) || b.startsWith(a))) ok = ok && (conflicts.has(a) || conflicts.has(b));
      why = 'transcript: never deleted, longer side wins, other side saved as conflict';
    } else if (a === b) { ok = f === a; why = 'same on both sides before settle'; }
    else if (a === undefined || b === undefined) {
      const present = a === undefined ? b : a;
      ok = present === p ? f === undefined : f === present;
      why = present === p ? 'deleted on one side, untouched on the other: gone' : 'added or edited on one side, absent on the other: kept';
    } else if (a === p) { ok = f === b; why = 'only house changed'; }
    else if (b === p) { ok = f === a; why = 'only office changed'; }
    else if (isMemoryMd(k)) { ok = f !== undefined && subset(lines(a), lines(f)) && subset(lines(b), lines(f)); why = 'MEMORY.md: union of lines'; }
    else { ok = (f === a && conflicts.has(b)) || (f === b && conflicts.has(a)); why = 'both changed: one wins, the loser is a conflict copy'; }
    if (!ok) check(`round ${round}: ${k} (${why})`, false, `prev=${p === undefined ? '-' : sha(p)} A=${a === undefined ? '-' : sha(a)} B=${b === undefined ? '-' : sha(b)} final=${f === undefined ? '-' : sha(f)} conflicts=${[a, b].map((x) => (x !== undefined && conflicts.has(x) ? 'y' : 'n')).join('')}`);
    else pass++;
  }

  // 3. No silent loss: every version written this round is final, a prefix/subset of final, or a conflict copy.
  const lastWrite = new Map(); // per machine+path, the last content the harness wrote this round
  for (const j of journal) lastWrite.set(`${j.m.name}|${j.logical}`, j);
  for (const j of lastWrite.values()) {
    if (j.content === null) continue;
    const f = final.get(j.logical);
    let ok = f === j.content || conflicts.has(j.content);
    if (!ok && f !== undefined && isTranscript(j.logical)) ok = f.startsWith(j.content);
    if (!ok && f !== undefined && isMemoryMd(j.logical)) ok = subset(lines(j.content), lines(f));
    if (!ok && j.logical.startsWith('mcp/')) ok = f === j.content || f === undefined; // an MCP entry can lose to a delete on the other side
    check(`round ${round}: no silent loss of ${j.logical} written on ${j.m.name}`, ok, `final=${f === undefined ? '-' : sha(f)} written=${sha(j.content)}`);
  }

  // 4. Deletions propagate unless the other side wrote the path in the same round.
  for (const j of lastWrite.values()) {
    if (j.content !== null || isTranscript(j.logical)) continue;
    const otherWrote = lastWrite.get(`${other(j.m).name}|${j.logical}`);
    if (otherWrote && otherWrote.content !== null) continue;
    check(`round ${round}: deletion of ${j.logical} on ${j.m.name} propagated`, !final.has(j.logical), `still present: ${final.has(j.logical) ? sha(final.get(j.logical)) : ''}`);
  }
  return final;
}

// ---------------------------------------------------------------------------------------------
// Run

console.log(`chaos: ${ROUNDS} rounds, seed ${SEED}, remote ${REMOTE_URL}`);
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
if (!ON_GITHUB) sh('git', ['init', '-q', '--bare', '-b', 'main', REMOTE_DIR]);
else {
  const env = { ...process.env, GH_TOKEN: TOKEN };
  const slug = REMOTE_URL.replace('https://github.com/', '').replace(/\.git$/, '');
  // The repository, and every one a move made next to it in an earlier run.
  const [owner, name] = slug.split('/');
  const list = sh('gh', ['repo', 'list', owner, '--limit', '500', '--json', 'name', '--jq', '.[].name'], { env }).stdout.split(/\r?\n/).filter(Boolean);
  for (const n of list.filter((x) => x === name || x.startsWith(`${name}-`))) sh('gh', ['repo', 'delete', `${owner}/${n}`, '--yes'], { env });
  sleep(2000);
  sh('gh', ['repo', 'create', slug, '--private'], { env });
  sleep(3000);
}
seedOffice(office);
seedHouse(house);

{
  const r = office.tool(['install', '--repo', REMOTE_URL, '--name', office.label, '--token', KEY[0], '--no-task']);
  check('office installs', r.status === 0, r.stderr + r.stdout);
  const r2 = house.tool(['install', '--repo', REMOTE_URL, '--name', house.label, '--token', KEY[1], '--no-task']);
  check('house installs and joins', r2.status === 0, r2.stderr + r2.stdout);
  office.run(); house.run(); office.run();
  const a = snapshot(office); const b = snapshot(house);
  const diff = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
  check('after joining, both computers are identical', !diff.length, diff.slice(0, 10).join('\n     '));
  check('house kept its own memories and skill after joining', exists(path.join(house.memory, 'house_item_1.md')) && exists(path.join(house.claude, 'skills', 'house-only', 'SKILL.md')));
  check('office received the house-only skill', exists(path.join(office.claude, 'skills', 'house-only', 'SKILL.md')));
  check('office CLAUDE.md won on the house (office is the source of truth), house copy saved as conflict', read(path.join(house.claude, 'CLAUDE.md')).includes('Global rules') && [...conflictsOf(house)].some((c) => c.includes('Older rules from computer two')));
  check('house sees office paths translated to its own user folder', read(path.join(house.memory, 'project_item_1.md')).includes(house.desktop) && !read(path.join(house.memory, 'project_item_1.md')).includes(office.desktop));
  check('MEMORY.md merged both indexes', read(path.join(house.memory, 'MEMORY.md')).includes('Cliente A') && read(path.join(house.memory, 'MEMORY.md')).includes('[Casa]'));
  const hj = JSON.parse(read(house.claudeJson));
  check('house has office MCP servers with translated paths', !!hj.mcpServers?.playwright && JSON.stringify(hj.mcpServers.playwright).includes(house.home.replace(/\\/g, '\\\\')));
  check('office has the house MCP server', !!JSON.parse(read(office.claudeJson)).mcpServers?.casa);
}

let prevFinal = snapshot(office);
const faultCount = {};
const mutationCount = {};
for (let round = 1; round <= ROUNDS; round++) {
  const journal = [];
  const roundInfo = {};
  const ops = [];
  for (const m of BOTH) {
    const n = weighted([[0, 2], [1, 5], [2, 5], [3, 3], [5, 1]]);
    for (let i = 0; i < n; i++) { const kind = weighted(MUTATIONS); mutationCount[kind] = (mutationCount[kind] || 0) + 1; ops.push(`${m.name}:${mutate(m, kind, journal)}`); }
  }
  // Both sides may hit the same file on purpose (a real conflict) about one round in five.
  if (rand() < 0.2) { const kind = pick(['memEdit', 'claudeMd', 'settings', 'memoryMd', 'transcriptAppend']); for (const m of BOTH) ops.push(`${m.name}:${mutate(m, kind, journal)}`); }
  const fault = weighted(FAULTS);
  faultCount[fault] = (faultCount[fault] || 0) + 1;
  await applyFault(fault, journal, roundInfo);

  // Settle: no faults, both sides sync until quiet.
  const snapA = snapshot(office); const snapB = snapshot(house);
  const rs = [office.run(), house.run(), office.run(), house.run()];
  check(`round ${round}: settle syncs exit 0`, rs.every((r) => r.status === 0), rs.map((r) => r.stderr).filter(Boolean).join(' | '));
  check(`round ${round}: no lastError after settle`, !office.state()?.lastError && !house.state()?.lastError, `${office.state()?.lastError} / ${house.state()?.lastError}`);
  prevFinal = oracle(round, journal, prevFinal, snapA, snapB, roundInfo);
  const tip = remoteTip();
  office.run(); house.run();
  check(`round ${round}: an extra sync on each side changes nothing (idempotent)`, remoteTip() === tip, `${tip} -> ${remoteTip()}`);
  const info = Object.entries(roundInfo).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`round ${round}/${ROUNDS} [${fault}] ${ops.length} ops ${info} :: ${pass} pass ${fail} fail (${elapsed()})`);
  if (round % 25 === 0) console.log(office.tool(['status']).stdout.trim().split('\n').slice(0, 6).join(' | '));
  if (fail > 40) { console.log('too many failures, stopping early'); break; }
}

console.log(`\nfaults: ${JSON.stringify(faultCount)}`);
console.log(`mutations: ${JSON.stringify(mutationCount)}`);
console.log(`conflict copies: office ${conflictsOf(office).size}, house ${conflictsOf(house).size}`);
console.log(`tracked: ${Object.keys(office.state()?.base || {}).length} items; repo objects: ${sh('git', ['-C', office.repo, 'count-objects', '-vH']).stdout.trim().replace(/\n/g, ', ')}`);
if (failures.length) console.log(`\nFAILURES:\n${failures.join('\n')}`);
console.log(`\n${pass} passed, ${fail} failed in ${elapsed()} (seed ${SEED})`);
process.exitCode = fail ? 1 : 0;
