// End-to-end test of claude-sync with two isolated "computers" on one machine.
// Model-free: every check reads files, git and the Claude Code CLI config directly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';

import { TOOL, sandbox, claudeBin, testRepo, testToken, machineToken, allTokens } from './env.mjs';

const ROOT = sandbox('main');
const SLUG = testRepo();
const REPO_URL = `https://github.com/${SLUG}.git`;
const CLAUDE_BIN = claudeBin();

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 30, ...opts });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const encodeKey = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const jsonl = (rows) => `${rows.map((o) => JSON.stringify(o)).join('\n')}\n`;
const t0 = Date.now();

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `\n     ${String(detail).slice(0, 1500)}` : ''}`); }
}
const phase = (t) => console.log(`\n=== ${t} (${Math.round((Date.now() - t0) / 1000)}s)`);

const TOKEN = testToken();

function machine(name, home, label, keyIndex) {
  const m = { name, label, home, token: machineToken(keyIndex) };
  m.claude = path.join(home, '.claude');
  m.sync = path.join(home, '.claude-sync');
  m.repo = path.join(m.sync, 'repo');
  m.desktop = path.join(home, 'Desktop');
  m.programs = path.join(ROOT, `${name}-programs.json`);
  m.env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: m.claude, CLAUDE_SYNC_FAKE_PROGRAMS: m.programs, CLAUDE_SYNC_CLAUDE_BIN: CLAUDE_BIN };
  delete m.env.CLAUDE_SYNC_DIR;
  m.key = encodeKey(m.desktop);
  m.project = path.join(m.claude, 'projects', m.key);
  m.script = () => (fs.existsSync(path.join(m.sync, 'claude-sync.mjs')) ? path.join(m.sync, 'claude-sync.mjs') : TOOL);
  m.tool = (args, opts = {}) => sh(process.execPath, [m.script(), ...args], { env: { ...m.env, ...(opts.env || {}) }, input: opts.input ?? '' });
  m.run = (...extra) => {
    const lock = path.join(m.sync, 'sync.lock');
    waitFor(() => !fs.existsSync(lock));
    const r = m.tool(['sync', '--quiet', ...extra]);
    waitFor(() => !fs.existsSync(lock)); // a background sync that held the lock reruns with these changes
    if (r.status !== 0) console.log(`     [${name}] sync exit ${r.status}: ${r.stderr.trim()}`);
    return r;
  };
  m.cli = (args, cwd) => sh(CLAUDE_BIN, args, { env: m.env, cwd: cwd || m.home });
  m.state = () => JSON.parse(read(path.join(m.sync, 'state.json')));
  m.git = (args) => sh('git', args, { cwd: m.repo, env: { ...m.env, GIT_TERMINAL_PROMPT: '0' } });
  m.mcp = () => { try { return JSON.parse(read(path.join(m.claude, '.claude.json'))).mcpServers || {}; } catch { return {}; } };
  m.hook = (sub, input, env) => m.tool(['hook', sub], { input: JSON.stringify(input || {}), env });
  return m;
}

const office = machine('office', path.join(ROOT, 'office', 'Users', 'joao.silva'), 'One', 0);
const house = machine('house', path.join(ROOT, 'house', 'Users', 'Ana Silva'), 'Two', 1);

// Expected translation of office text into house text.
const toHouse = (s) => s.split(office.home.replace(/\\/g, '\\\\')).join(house.home.replace(/\\/g, '\\\\')).split(office.home).join(house.home);

function repoTextFiles(m) {
  const out = [];
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir)) {
      if (n === '.git') continue;
      const p = path.join(dir, n);
      if (fs.statSync(p).isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(m.repo);
  return out;
}

function remoteTip() {
  return sh('git', ['ls-remote', REPO_URL, 'refs/heads/main'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}` },
  }).stdout.split(/\s+/)[0];
}

function waitFor(fn, ms = 90e3) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; sleep(1000); }
  return false;
}

// ---------------------------------------------------------------------------------------------
phase('setup: clean sandboxes and an empty private repository');
fs.rmSync(ROOT, { recursive: true, force: true });
{
  const env = { ...process.env, GH_TOKEN: TOKEN };
  sh('gh', ['repo', 'delete', SLUG, '--yes'], { env });
  sleep(4000);
  const r = sh('gh', ['repo', 'create', SLUG, '--private', '--description', 'claude-sync end-to-end test data'], { env });
  check('test repository recreated (private)', r.status === 0, r.stderr);
  sleep(4000);
}
const basePrograms = JSON.stringify({ winget: ['Git.Git', 'OpenJS.NodeJS'], npm: ['npm'], pip: ['pip'] });
write(office.programs, basePrograms);
write(house.programs, basePrograms);

// ---------------------------------------------------------------------------------------------
phase('office: existing Claude Code content, then install (first computer seeds the repository)');
const SID1 = '11111111-1111-4111-8111-111111111111';
const BIN = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), crypto.randomBytes(5000), Buffer.from(office.home)]);
write(path.join(office.claude, 'CLAUDE.md'), `# Office rules\r\nSave files in ${office.desktop}\r\n`);
write(path.join(office.claude, 'settings.json'), JSON.stringify({ model: 'sonnet', statusLine: { type: 'command', command: `node "${path.join(office.claude, 'statusline.mjs')}"` } }, null, 2));
write(path.join(office.claude, 'skills', 'hello-sync', 'SKILL.md'), '---\nname: hello-sync\ndescription: test skill\n---\nSay hello.\n');
write(path.join(office.claude, 'skills', 'hello-sync', 'scripts', 'run.py'), 'print("hi")\r\n');
fs.writeFileSync(path.join(office.claude, 'skills', 'hello-sync', 'logo.png'), BIN);
write(path.join(office.claude, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview v1.\n');
write(path.join(office.claude, 'commands', 'greet.md'), 'Greet the user.\n');
for (let i = 0; i < 25; i++) write(path.join(office.claude, 'rules', `rule-${i}.md`), `Rule ${i}\n`);
write(path.join(office.project, 'memory', 'MEMORY.md'), '- [Profile](user_profile.md) - who the user is\n');
write(path.join(office.project, 'memory', 'user_profile.md'), `---\nname: user_profile\n---\nWorks in sales. Files in ${office.desktop}.\n`);
write(path.join(office.project, `${SID1}.jsonl`), jsonl([
  { type: 'user', cwd: office.desktop, sessionId: SID1, message: 'hello' },
  { type: 'assistant', cwd: office.desktop, sessionId: SID1, message: 'hi' },
]));
write(path.join(office.project, SID1, 'subagents', 'agent-a.jsonl'), jsonl([{ cwd: office.desktop, t: 'sub' }]));
write(path.join(office.claude, '.credentials.json'), '{"secret":"never-sync"}');
write(path.join(office.claude, 'history.jsonl'), '{"x":1}\n');
write(path.join(office.claude, 'file-history', 'x', 'y.txt'), 'never-sync');
write(path.join(office.claude, 'settings.local.json'), '{"never":"sync"}');
write(path.join(office.claude, 'plugins', 'installed_plugins.json'), '{"version":2,"plugins":{}}');
{
  const r = office.cli(['mcp', 'add-json', 'fs-local', JSON.stringify({ type: 'stdio', command: 'node', args: [path.join(office.home, 'mcp', 'server.js')] }), '-s', 'user']);
  check('office: MCP server added through the Claude CLI', r.status === 0 && office.mcp()['fs-local'], r.stderr + r.stdout);
}
{
  const r = office.tool(['install', '--repo', REPO_URL, '--name', office.label, '--token', office.token, '--no-task']);
  check('office: install exits 0', r.status === 0, r.stderr + r.stdout);
  console.log(r.stdout.split('\n').map((l) => `     ${l}`).join('\n'));
}
{
  const files = repoTextFiles(office);
  const rel = files.map((f) => path.relative(office.repo, f).replace(/\\/g, '/'));
  const leaks = files.filter((f) => !f.endsWith('logo.png') && fs.readFileSync(f).toString('latin1').toLowerCase().includes('joao.silva'));
  check('repo: no office user path left in text files', leaks.length === 0, leaks.join('\n'));
  check('repo: never-sync files absent', !rel.some((r) => /credentials|history\.jsonl|file-history|settings\.local|installed_plugins/.test(r)), rel.join('\n'));
  check('repo: transcript under the {{HOME}} project name', rel.includes(`claude/projects/{{HOME}}-Desktop/${SID1}.jsonl`), rel.join('\n'));
  check('repo: memory under the {{HOME}} project name', rel.includes('claude/projects/{{HOME}}-Desktop/memory/user_profile.md'));
  check('repo: subagent transcript present', rel.includes(`claude/projects/{{HOME}}-Desktop/${SID1}/subagents/agent-a.jsonl`));
  check('repo: MCP server stored with a path token', read(path.join(office.repo, 'mcp', 'fs-local.json')).includes('{{CLAUDE_SYNC_HOME_JSON}}'));
  check('repo: status, programs, tool, meta files', ['status', 'programs', 'tool'].every((d) => fs.existsSync(path.join(office.repo, d))) && fs.existsSync(path.join(office.repo, 'meta', 'mtimes.json')));
  const settings = JSON.parse(read(path.join(office.claude, 'settings.json')));
  check('office: hooks and cleanupPeriodDays written', settings.cleanupPeriodDays === 3650 && ['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd'].every((e) => JSON.stringify(settings.hooks[e]).includes('hook.cmd')), JSON.stringify(settings));
  const md = read(path.join(office.claude, 'CLAUDE.md'));
  check('office: CLAUDE.md block appended keeping CRLF', md.includes('<!-- claude-sync:start -->') && md.includes('# Office rules\r\n') && md.includes('## Sync between computers\r\n'));
  check('office: the tool copied itself to .claude-sync', fs.existsSync(path.join(office.sync, 'claude-sync.mjs')));
}

// ---------------------------------------------------------------------------------------------
phase('house: a different user folder with its own content, then install (joins)');
write(path.join(house.claude, 'CLAUDE.md'), '# House fresh setup\n');
write(path.join(house.project, 'memory', 'MEMORY.md'), '- [House](house_only.md) - house note\n');
write(path.join(house.project, 'memory', 'house_only.md'), 'Only at house.\n');
house.cli(['mcp', 'add-json', 'house-mcp', JSON.stringify({ type: 'http', url: 'https://example.com/mcp' }), '-s', 'user']);
{
  const r = house.tool(['install', '--repo', REPO_URL, '--name', house.label, '--token', house.token, '--no-task']);
  check('house: install exits 0', r.status === 0, r.stderr + r.stdout);
}
{
  const md = read(path.join(house.claude, 'CLAUDE.md'));
  check('house: CLAUDE.md adopted from office with its own path', md.includes('# Office rules') && md.includes(`Save files in ${house.desktop}`) && !md.includes('joao.silva'), md);
  const conflicts = path.join(house.sync, 'conflicts');
  const saved = fs.existsSync(conflicts) ? sh('cmd', ['/c', 'dir', '/s', '/b', conflicts]).stdout : '';
  check('house: its previous CLAUDE.md kept in conflicts', /CLAUDE\.md/.test(saved), saved);
  check('house: skill files arrived', read(path.join(house.claude, 'skills', 'hello-sync', 'SKILL.md')).includes('Say hello'));
  check('house: CRLF text stays byte-exact', read(path.join(house.claude, 'skills', 'hello-sync', 'scripts', 'run.py')) === 'print("hi")\r\n');
  check('house: binary file byte-exact (not translated)', sha256(fs.readFileSync(path.join(house.claude, 'skills', 'hello-sync', 'logo.png'))) === sha256(BIN));
  check('house: memory arrived under its own project folder', read(path.join(house.project, 'memory', 'user_profile.md')).includes(`Files in ${house.desktop}.`));
  check('house: its local-only memory kept', fs.existsSync(path.join(house.project, 'memory', 'house_only.md')));
  const idx = read(path.join(house.project, 'memory', 'MEMORY.md'));
  check('house: MEMORY.md has lines from both computers', idx.includes('user_profile.md') && idx.includes('house_only.md'), idx);
  const t = read(path.join(house.project, `${SID1}.jsonl`));
  check('house: transcript translated to the house path', t === toHouse(read(path.join(office.project, `${SID1}.jsonl`))), t);
  check('house: subagent transcript arrived', fs.existsSync(path.join(house.project, SID1, 'subagents', 'agent-a.jsonl')));
  const mcp = house.mcp();
  check('house: MCP from office installed with the house path', mcp['fs-local']?.args?.[0] === path.join(house.home, 'mcp', 'server.js'), JSON.stringify(mcp));
  check('house: its own MCP kept', !!mcp['house-mcp']);
  const settings = JSON.parse(read(path.join(house.claude, 'settings.json')));
  check('house: settings adopted with house paths in commands', settings.statusLine.command.includes(house.claude) && JSON.stringify(settings.hooks).includes(house.sync.replace(/\\/g, '\\\\')), JSON.stringify(settings));
  check('house: never-sync files not created', !fs.existsSync(path.join(house.claude, 'history.jsonl')) && !fs.existsSync(path.join(house.claude, 'settings.local.json')));
  // The hook line travels inside settings.json: it has to point at this computer's own launcher, and
  // that launcher has to exist and know where Node is here.
  const hookCmds = Object.values(settings.hooks || {}).flat().flatMap((g) => (g.hooks || []).map((h) => h.command)).filter((c) => /hook\.cmd/i.test(c));
  const launcher = path.join(house.sync, 'hook.cmd');
  check('house: hook commands point at the house launcher', hookCmds.length === 4 && hookCmds.every((c) => c.includes(launcher)) && !hookCmds.some((c) => c.includes(office.home)), hookCmds.join(' | '));
  check('house: the launcher exists and carries an absolute node path', fs.existsSync(launcher) && /node\.exe/i.test(read(launcher)), fs.existsSync(launcher) ? read(launcher) : 'missing');
  check('house: the tool launcher exists too', fs.existsSync(path.join(house.sync, 'claude-sync.cmd')));
  check('house: first sync leaves no notices (setup, not news)', !fs.existsSync(path.join(house.sync, 'notices')) || fs.readdirSync(path.join(house.sync, 'notices')).length === 0);
}

// ---------------------------------------------------------------------------------------------
phase('office pulls what the house added');
office.run();
{
  check('office: house memory arrived', fs.existsSync(path.join(office.project, 'memory', 'house_only.md')));
  check('office: MEMORY.md union', read(path.join(office.project, 'memory', 'MEMORY.md')).includes('house_only.md'));
  check('office: house MCP arrived', !!office.mcp()['house-mcp']);
  const hook = office.hook('session-start', { source: 'startup' });
  check('office: session-start tells Claude what arrived', /\[claude-sync\]/.test(hook.stdout) && /MCP server "house-mcp" added/.test(hook.stdout) && /memory added/.test(hook.stdout) && hook.stdout.includes('Two'), hook.stdout);
  const again = office.hook('session-start', { source: 'startup' });
  check('office: notices are shown only once', !/arrived/.test(again.stdout), again.stdout);
}

// ---------------------------------------------------------------------------------------------
phase('stable state: syncing again without changes creates no commit');
{
  sleep(3000); // let the background sync spawned by the hook finish
  waitFor(() => !fs.existsSync(path.join(office.sync, 'sync.lock')));
  const before = remoteTip();
  house.run();
  office.run();
  house.run();
  check('no-op syncs do not push', remoteTip() === before, `${before} vs ${remoteTip()}`);
}

// ---------------------------------------------------------------------------------------------
phase('edits and deletions at the house reach the office');
write(path.join(house.project, 'memory', 'user_profile.md'), `---\nname: user_profile\n---\nWorks in sales. Likes jabuticaba. Files in ${house.desktop}.\n`);
fs.rmSync(path.join(house.claude, 'skills', 'hello-sync'), { recursive: true, force: true });
write(path.join(house.claude, 'skills', 'house-skill', 'SKILL.md'), '---\nname: house-skill\n---\nFrom house.\n');
house.run();
office.run();
{
  check('office: memory edit arrived, path back to office', read(path.join(office.project, 'memory', 'user_profile.md')).includes(`Likes jabuticaba. Files in ${office.desktop}.`));
  check('office: deleted skill removed with its folder', !fs.existsSync(path.join(office.claude, 'skills', 'hello-sync')));
  check('office: new skill arrived', fs.existsSync(path.join(office.claude, 'skills', 'house-skill', 'SKILL.md')));
  const hook = office.hook('session-start', { source: 'startup' });
  check('office: notice names the removed and added skills', /skill "hello-sync" removed/.test(hook.stdout) && /skill "house-skill" added/.test(hook.stdout), hook.stdout);
}

// ---------------------------------------------------------------------------------------------
phase('same file edited on both computers before syncing: the newest edit wins');
write(path.join(office.claude, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview v2 from office.\n');
sleep(1500);
write(path.join(house.claude, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview v3 from house (newer).\n');
office.run(); // office pushes first even though its edit is older
house.run();
office.run();
{
  check('house keeps its newer edit', read(path.join(house.claude, 'agents', 'reviewer.md')).includes('v3 from house'));
  check('office receives the newer house edit', read(path.join(office.claude, 'agents', 'reviewer.md')).includes('v3 from house'));
  const saved = sh('cmd', ['/c', 'dir', '/s', '/b', path.join(house.sync, 'conflicts')]).stdout;
  check('the older office edit is kept in conflicts', saved.split('\n').some((l) => l.includes('reviewer.md') && l.includes('from-other-computer')), saved);
}

// ---------------------------------------------------------------------------------------------
phase('MEMORY.md edited on both computers: lines from both are kept');
fs.appendFileSync(path.join(office.project, 'memory', 'MEMORY.md'), '- [Office B](office_b.md) - office line\n');
fs.appendFileSync(path.join(house.project, 'memory', 'MEMORY.md'), '- [House B](house_b.md) - house line\n');
office.run();
house.run();
office.run();
{
  const o = read(path.join(office.project, 'memory', 'MEMORY.md'));
  const h = read(path.join(house.project, 'memory', 'MEMORY.md'));
  check('both MEMORY.md have both new lines and are identical', o === h && o.includes('office_b.md') && o.includes('house_b.md'), `${o}\n---\n${h}`);
}

// ---------------------------------------------------------------------------------------------
phase('a conversation continues on the other computer, both ways');
fs.appendFileSync(path.join(office.project, `${SID1}.jsonl`), jsonl([{ type: 'user', cwd: office.desktop, sessionId: SID1, message: 'office turn 2' }]));
office.run();
house.run();
check('house: office turn arrived', read(path.join(house.project, `${SID1}.jsonl`)).includes('office turn 2'));
fs.appendFileSync(path.join(house.project, `${SID1}.jsonl`), jsonl([{ type: 'user', cwd: house.desktop, sessionId: SID1, message: 'house turn 3' }]));
house.run();
office.run();
{
  const o = read(path.join(office.project, `${SID1}.jsonl`));
  check('office: house turn arrived after the office turn', o.indexOf('office turn 2') < o.indexOf('house turn 3') && o.indexOf('office turn 2') > 0, o);
  check('office: the house turn carries the office path', o.includes(JSON.stringify(office.desktop)) && !o.includes('Jo\u00e3o'), o);
}
{
  // Half-written last line is not uploaded.
  fs.appendFileSync(path.join(office.project, `${SID1}.jsonl`), '{"type":"user","message":"half');
  office.run();
  house.run();
  check('house: a half-written line is not synced', !read(path.join(house.project, `${SID1}.jsonl`)).includes('"half'));
  const f = path.join(office.project, `${SID1}.jsonl`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('{"type":"user","message":"half', ''));
}

// ---------------------------------------------------------------------------------------------
phase('a conversation open in Claude Code is not overwritten');
{
  const dummy = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore', windowsHide: true });
  write(path.join(house.claude, 'sessions', `${dummy.pid}.json`), JSON.stringify({ pid: dummy.pid, sessionId: SID1 }));
  fs.appendFileSync(path.join(office.project, `${SID1}.jsonl`), jsonl([{ type: 'user', cwd: office.desktop, sessionId: SID1, message: 'office turn 4' }]));
  office.run();
  house.run();
  check('house: open conversation left untouched', !read(path.join(house.project, `${SID1}.jsonl`)).includes('office turn 4'));
  dummy.kill();
  sleep(1000);
  house.run();
  check('house: applied once the conversation is closed', read(path.join(house.project, `${SID1}.jsonl`)).includes('office turn 4'));
}

// ---------------------------------------------------------------------------------------------
phase('a transcript deleted on one computer (retention sweep) stays everywhere else');
{
  fs.rmSync(path.join(office.project, `${SID1}.jsonl`));
  office.run();
  house.run();
  check('repo still has the transcript', fs.existsSync(path.join(office.repo, 'claude', 'projects', '{{HOME}}-Desktop', `${SID1}.jsonl`)));
  check('house still has the transcript', fs.existsSync(path.join(house.project, `${SID1}.jsonl`)));
}

// ---------------------------------------------------------------------------------------------
phase('large transcript (150 MB) in parts, byte-exact, and only the last part changes on append');
{
  const SIDBIG = '22222222-2222-4222-8222-222222222222';
  const bigFile = path.join(office.project, `${SIDBIG}.jsonl`);
  fs.mkdirSync(path.dirname(bigFile), { recursive: true });
  const fd = fs.openSync(bigFile, 'w');
  let size = 0;
  while (size < 150 * 1024 * 1024) {
    const line = `${JSON.stringify({ type: 'user', cwd: office.desktop, sessionId: SIDBIG, image: crypto.randomBytes(300000).toString('base64') })}\n`;
    fs.writeSync(fd, line);
    size += Buffer.byteLength(line);
  }
  fs.closeSync(fd);
  let t = Date.now();
  const r = office.run();
  console.log(`     office upload of ${(size / 1048576).toFixed(0)} MB: ${Math.round((Date.now() - t) / 1000)}s`);
  check('office: sync with 150 MB transcript ok', r.status === 0);
  const parts = fs.readdirSync(path.join(office.repo, 'claude', 'projects', '{{HOME}}-Desktop')).filter((n) => n.startsWith(`${SIDBIG}.jsonl.ccsync-part-`));
  const maxPart = Math.max(...parts.map((n) => fs.statSync(path.join(office.repo, 'claude', 'projects', '{{HOME}}-Desktop', n)).size));
  check('repo: stored in parts of at most 8 MB', parts.length === Math.ceil(size / (8 * 1024 * 1024)) && maxPart <= 8 * 1024 * 1024, `${parts.length} parts, max ${maxPart}`);
  t = Date.now();
  house.run();
  console.log(`     house download: ${Math.round((Date.now() - t) / 1000)}s`);
  const expected = sha256(Buffer.from(toHouse(read(bigFile))));
  check('house: 150 MB transcript identical after translation', sha256(fs.readFileSync(path.join(house.project, `${SIDBIG}.jsonl`))) === expected);
  fs.appendFileSync(bigFile, jsonl([{ type: 'user', cwd: office.desktop, sessionId: SIDBIG, message: 'append' }]));
  office.run();
  const stat = office.git(['show', '--stat', '--format=', 'HEAD']).stdout;
  const changedParts = stat.split('\n').filter((l) => l.includes('ccsync-part-'));
  check('append rewrites only the last part', changedParts.length === 1, stat);
}

// ---------------------------------------------------------------------------------------------
phase('MCP removal and plugins');
{
  house.cli(['mcp', 'remove', 'house-mcp', '-s', 'user']);
  house.run();
  office.run();
  check('office: MCP removed at the house is removed here', !office.mcp()['house-mcp'] && !!office.mcp()['fs-local'], JSON.stringify(office.mcp()));
  const add = office.cli(['plugin', 'marketplace', 'add', 'DietrichGebert/ponytail']);
  const inst = office.cli(['plugin', 'install', 'ponytail@ponytail', '--scope', 'user', '--json']);
  check('office: plugin installed through the CLI', add.status === 0 && inst.status === 0, add.stderr + inst.stderr + inst.stdout);
  office.run();
  house.run();
  const installed = JSON.parse(read(path.join(house.claude, 'plugins', 'installed_plugins.json'))).plugins;
  check('house: plugin installed automatically', !!installed['ponytail@ponytail'], JSON.stringify(installed));
  const hook = house.hook('session-start', { source: 'startup' });
  check('house: notice mentions the plugin', /plugin "ponytail@ponytail" installed/.test(hook.stdout), hook.stdout);
}

// ---------------------------------------------------------------------------------------------
phase('programs installed on one computer become pending installs on the other');
{
  write(office.programs, JSON.stringify({ winget: ['Git.Git', 'OpenJS.NodeJS', 'Python.Python.3.12'], npm: ['npm', 'typescript'], pip: ['pip'] }));
  office.run('--scan-programs');
  house.run();
  const hook = house.hook('session-start', { source: 'startup' });
  check('house: Claude is told to install the missing programs', hook.stdout.includes('winget install --id Python.Python.3.12') && hook.stdout.includes('npm install -g typescript') && !hook.stdout.includes('Git.Git'), hook.stdout);
  const again = house.hook('session-start', { source: 'startup' });
  check('house: the same pending list is not repeated within 24 hours', !again.stdout.includes('Python.Python.3.12'), again.stdout);
  write(house.programs, JSON.stringify({ winget: ['Git.Git', 'OpenJS.NodeJS', 'Python.Python.3.12'], npm: ['npm', 'typescript'], pip: ['pip'] }));
  house.run('--scan-programs');
  office.run();
  const status = house.tool(['status']).stdout;
  check('house: nothing pending once it has the same programs', status.includes('Programs to install from other computers: 0'), status);
}

// ---------------------------------------------------------------------------------------------
phase('hooks trigger a background sync');
{
  const before = office.state().lastSuccessAt;
  write(path.join(office.claude, 'commands', 'from-hook.md'), 'Created before a PostToolUse hook.\n');
  office.hook('post-tool', { tool_name: 'Write', tool_input: { file_path: path.join(office.claude, 'commands', 'from-hook.md') } });
  const ok = waitFor(() => { try { return office.state().lastSuccessAt > before; } catch { return false; } });
  check('office: post-tool hook on a Claude file ran a sync', ok && fs.existsSync(path.join(office.repo, 'claude', 'commands', 'from-hook.md')));
  const before2 = office.state().lastSuccessAt;
  office.hook('post-tool', { tool_name: 'Write', tool_input: { file_path: path.join(office.desktop, 'report.txt') } });
  sleep(8000);
  check('office: post-tool hook on a project file does nothing', office.state().lastSuccessAt === before2);
}

// ---------------------------------------------------------------------------------------------
phase('concurrent syncs on the same computer');
{
  write(path.join(office.claude, 'commands', 'concurrent.md'), 'x\n');
  const runs = await Promise.all([0, 1, 2].map(() => new Promise((resolve) => {
    const p = spawn(process.execPath, [office.script(), 'sync', '--quiet'], { env: office.env, windowsHide: true });
    p.on('exit', (code) => resolve(code));
  })));
  waitFor(() => !fs.existsSync(path.join(office.sync, 'sync.lock')));
  check('three simultaneous syncs all exit 0', runs.every((c) => c === 0), runs.join(','));
  check('state is consistent afterwards', !office.state().lastError && fs.existsSync(path.join(office.repo, 'claude', 'commands', 'concurrent.md')));
}

// ---------------------------------------------------------------------------------------------
phase('safety stop when most synced files disappear');
{
  const tip = remoteTip();
  const rules = path.join(office.claude, 'rules');
  const skills = path.join(office.claude, 'skills');
  fs.renameSync(rules, `${rules}-away`);
  fs.renameSync(skills, `${skills}-away`);
  const r = office.tool(['sync', '--quiet']);
  check('sync refuses and exits 1', r.status === 1 && /safety stop/.test(r.stderr), r.stderr);
  check('remote untouched', remoteTip() === tip);
  fs.renameSync(`${rules}-away`, rules);
  fs.renameSync(`${skills}-away`, skills);
  check('sync works again after the files are back', office.run().status === 0);
}

// ---------------------------------------------------------------------------------------------
phase('failure is reported to Claude');
{
  const tokenFile = path.join(house.sync, 'token.dpapi');
  const good = fs.readFileSync(tokenFile);
  const bad = sh('powershell.exe', ['-NoProfile', '-Command', "ConvertTo-SecureString 'ghp_invalidinvalidinvalidinvalid00000000' -AsPlainText -Force | ConvertFrom-SecureString"]).stdout.trim();
  fs.writeFileSync(tokenFile, bad);
  const r = house.tool(['sync', '--quiet']);
  check('sync with a revoked token exits 1 without prompting', r.status === 1, r.stderr);
  check('token never printed', !r.stderr.includes('ghp_invalid') && allTokens().every((t) => !r.stderr.includes(t)));
  // One failure is not reported: the network is often not up yet when a computer starts. The warning is
  // for a problem that keeps happening, which is what a revoked token does.
  house.run();
  house.run();
  check('repeated failures are counted', (house.state().failStreak || 0) >= 3, String(house.state().failStreak));
  const hook = house.hook('session-start', { source: 'startup' }, { CLAUDE_SYNC_FAILURE_WARN_MS: '1' });
  check('session-start warns Claude and names the support person', /WARNING/.test(hook.stdout) && /contact the person who set it up/.test(hook.stdout), hook.stdout);
  fs.writeFileSync(tokenFile, good);
  check('sync recovers with the good token', house.run().status === 0 && !house.state().lastError);
}

// ---------------------------------------------------------------------------------------------
phase('self-update from the repository');
{
  office.run();
  const repoTool = path.join(office.repo, 'tool', 'claude-sync.mjs');
  const bumped = Number(/^const VERSION = (\d+);$/m.exec(read(repoTool))[1]) + 1;
  const text = read(repoTool).replace(/^const VERSION = (\d+);$/m, `const VERSION = ${bumped};`);
  fs.writeFileSync(repoTool, text);
  const env = { ...office.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`, GIT_CONFIG_KEY_2: 'user.email', GIT_CONFIG_VALUE_2: 'test@example.com' };
  sh('git', ['-c', 'user.name=test', 'commit', '-q', '-am', 'bump tool version'], { cwd: office.repo, env });
  const push = sh('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: office.repo, env });
  check('newer tool version pushed', push.status === 0, push.stderr);
  house.run();
  const v = /^const VERSION = (\d+);$/m.exec(read(path.join(house.sync, 'claude-sync.mjs')))[1];
  check('house: installed tool updated itself', Number(v) === bumped, `${v} vs ${bumped}`);
  check('house: updated tool still syncs', house.run().status === 0);
}

// ---------------------------------------------------------------------------------------------
phase('review 1: .gitignore, .gitattributes and a .git file inside a skill');
{
  const skill = path.join(office.claude, 'skills', 'git-files');
  write(path.join(skill, 'SKILL.md'), '---\nname: git-files\n---\nx\n');
  write(path.join(skill, '.gitignore'), '.env\noutput/\n');
  write(path.join(skill, '.env'), 'API_KEY=abc\n');
  write(path.join(skill, 'output', 'report.md'), 'report\n');
  write(path.join(skill, '.gitattributes'), '*.ps1 text eol=crlf\n');
  write(path.join(skill, 'run.ps1'), 'Write-Output 1\n');
  write(path.join(skill, '.git'), 'gitdir: C:/somewhere/else\n');
  office.run();
  office.run(); // the tool updated itself in the previous phase: its new version is written to status once
  const tipAfterFirst = remoteTip();
  office.run();
  office.run();
  check('office: ignored and special files still exist after repeated syncs', ['.env', 'output/report.md', '.gitignore', '.gitattributes', 'run.ps1', '.git'].every((f) => fs.existsSync(path.join(skill, f))));
  check('office: repeated syncs are stable (no commit loop)', remoteTip() === tipAfterFirst);
  house.run();
  const hs = path.join(house.claude, 'skills', 'git-files');
  check('house: all of them arrived byte-exact', read(path.join(hs, '.env')) === 'API_KEY=abc\n' && read(path.join(hs, 'output', 'report.md')) === 'report\n' && read(path.join(hs, 'run.ps1')) === 'Write-Output 1\n' && read(path.join(hs, '.git')).startsWith('gitdir:') && read(path.join(hs, '.gitignore')) === '.env\noutput/\n');
}

phase('review 2: renaming only the letter case of a folder deletes nothing');
{
  const from = path.join(office.claude, 'skills', 'house-skill');
  fs.renameSync(from, `${from}-tmp`);
  fs.renameSync(`${from}-tmp`, path.join(office.claude, 'skills', 'HOUSE-SKILL'));
  office.run();
  house.run();
  office.run();
  house.run();
  check('office: renamed skill still there', fs.existsSync(path.join(office.claude, 'skills', 'HOUSE-SKILL', 'SKILL.md')));
  check('house: skill still there', fs.existsSync(path.join(house.claude, 'skills', 'house-skill', 'SKILL.md')));
  write(path.join(office.claude, 'skills', 'HOUSE-SKILL', 'SKILL.md'), '---\nname: house-skill\n---\nEdited after the rename.\n');
  office.run();
  house.run();
  office.run();
  check('house: edit made after the rename arrived', read(path.join(house.claude, 'skills', 'house-skill', 'SKILL.md')).includes('Edited after the rename'));
  check('office: renamed skill still there after the edit round trip', read(path.join(office.claude, 'skills', 'HOUSE-SKILL', 'SKILL.md')).includes('Edited after the rename'));
}

phase('review 4: unreadable state file');
{
  const st = path.join(office.sync, 'state.json');
  fs.writeFileSync(st, Buffer.alloc(300));
  check('office: sync recovers from the backup state', office.run().status === 0 && !!office.state().baseInitialized);
  const good = read(st);
  fs.writeFileSync(st, Buffer.alloc(300));
  fs.writeFileSync(`${st}.bak`, Buffer.alloc(300));
  const hook = office.hook('session-start', { source: 'startup' });
  check('office: session-start warns when no state can be read', /cannot read its own state/.test(hook.stdout), hook.stdout);
  fs.writeFileSync(st, good);
  fs.writeFileSync(`${st}.bak`, good);
}

phase('review 5 and 7: token text and literal tokens in synced content');
{
  const SID5 = '55555555-5555-4555-8555-555555555555';
  const lines = jsonl([
    { type: 'user', sessionId: SID5, cwd: office.desktop, message: `install --token ${office.token}` },
    { type: 'user', sessionId: SID5, message: 'literal {{CLAUDE_SYNC_HOME}} and {{CLAUDE_SYNC_ESC_HOME}} text' },
    { type: 'user', sessionId: SID5, message: `other folder ${office.home} Backup` },
  ]);
  write(path.join(office.project, `${SID5}.jsonl`), lines);
  office.run();
  const repoFile = path.join(office.repo, 'claude', 'projects', '{{HOME}}-Desktop', `${SID5}.jsonl`);
  check('repo: the sync token is redacted', !read(repoFile).includes(office.token) && read(repoFile).includes('--token ***'));
  house.run();
  const h = read(path.join(house.project, `${SID5}.jsonl`));
  check('house: every line is still valid JSON', h.trim().split('\n').every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), h);
  check('house: literal token text arrives unchanged', h.includes('literal {{CLAUDE_SYNC_HOME}} and {{CLAUDE_SYNC_ESC_HOME}} text'), h);
  check('house: "<home> Backup" is not rewritten as a home path', h.includes(`${office.home.replace(/\\/g, '\\\\')} Backup`), h);
}

phase('review 8: project folder name longer than 200 characters');
{
  const base = encodeKey(office.desktop);
  const longKey = `${base}-${'x'.repeat(210 - base.length)}`;
  write(path.join(office.claude, 'projects', longKey, 'memory', 'long.md'), 'long key memory\n');
  office.run();
  house.run();
  office.run();
  house.run();
  check('office: memory in the long folder survives', fs.existsSync(path.join(office.claude, 'projects', longKey, 'memory', 'long.md')));
  check('repo: memory in the long folder survives', fs.readdirSync(path.join(office.repo, 'claude', 'projects')).some((d) => d.startsWith('{{HOME}}-Desktop-xxx')));
}

phase('review 9: .jsonl that is not a transcript keeps its last line');
{
  write(path.join(office.claude, 'skills', 'data-skill', 'SKILL.md'), '---\nname: data-skill\n---\nx\n');
  write(path.join(office.claude, 'skills', 'data-skill', 'data.jsonl'), '{"a":1}\n{"b":2}');
  office.run();
  house.run();
  check('house: data.jsonl complete', read(path.join(house.claude, 'skills', 'data-skill', 'data.jsonl')) === '{"a":1}\n{"b":2}');
}

phase('review 10: damaged local copy of the repository repairs itself');
{
  write(path.join(office.repo, '.git', 'index.lock'), '');
  write(path.join(office.claude, 'commands', 'after-lock.md'), 'x\n');
  check('office: sync with a stale index.lock', office.run().status === 0 && !fs.existsSync(path.join(office.repo, '.git', 'index.lock')));
  fs.writeFileSync(path.join(office.repo, '.git', 'HEAD'), 'garbage');
  write(path.join(office.claude, 'commands', 'after-head.md'), 'x\n');
  check('office: sync with a corrupt .git/HEAD', office.run().status === 0);
  house.run();
  check('house: changes made during both repairs arrived', fs.existsSync(path.join(house.claude, 'commands', 'after-lock.md')) && fs.existsSync(path.join(house.claude, 'commands', 'after-head.md')));
}

phase('review 11: .claude.json recreated without mcpServers does not remove servers elsewhere');
{
  const cfgFile = path.join(office.claude, '.claude.json');
  const saved = read(cfgFile);
  const cfg = JSON.parse(saved);
  delete cfg.mcpServers;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  office.run();
  house.run();
  check('house: MCP server kept', !!house.mcp()['fs-local'], JSON.stringify(house.mcp()));
  fs.writeFileSync(cfgFile, saved);
  office.run();
}

phase('review 12: an item that keeps failing becomes a warning');
{
  write(path.join(ROOT, 'fake-claude.js'), 'process.exit(1)\n');
  office.cli(['mcp', 'add-json', 'late-mcp', JSON.stringify({ type: 'http', url: 'https://example.org/mcp' }), '-s', 'user']);
  office.run();
  const fake = { CLAUDE_SYNC_CLAUDE_BIN: path.join(ROOT, 'fake-claude.js') };
  waitFor(() => !fs.existsSync(path.join(house.sync, 'sync.lock')));
  house.tool(['sync', '--quiet'], { env: fake });
  check('house: failure recorded for the MCP server', JSON.stringify(house.state().itemFailures).includes('late-mcp'), JSON.stringify(house.state().itemFailures));
  // The hook syncs before it reports, so the item has to keep failing for the warning to be right.
  const hook = house.hook('session-start', { source: 'startup' }, { ...fake, CLAUDE_SYNC_FAILURE_WARN_MS: '1' });
  check('house: session-start warns about the item', /could not be applied/.test(hook.stdout) && hook.stdout.includes('late-mcp'), hook.stdout);
  house.run();
  check('house: applied and cleared once the CLI works', !!house.mcp()['late-mcp'] && !JSON.stringify(house.state().itemFailures).includes('late-mcp'));
}

phase('review 13: profile copied to a computer with another name joins as a new computer');
{
  const stFile = path.join(house.sync, 'state.json');
  const st = JSON.parse(read(stFile));
  const oldId = st.machineId;
  st.hostname = 'OLD-PC';
  fs.writeFileSync(stFile, JSON.stringify(st));
  const skillsBefore = fs.readdirSync(path.join(house.claude, 'skills')).length;
  check('house: sync after the name change', house.run().status === 0);
  check('house: new identity and nothing deleted', house.state().machineId !== oldId && fs.readdirSync(path.join(house.claude, 'skills')).length === skillsBefore);
}

phase('review 14: a folder linked from outside Claude Code is never deleted through the link');
{
  const outside = path.join(ROOT, 'outside', 'linked-skill');
  write(path.join(outside, 'SKILL.md'), '---\nname: linked-skill\n---\nlives outside\n');
  const link = path.join(office.claude, 'skills', 'linked-skill');
  fs.symlinkSync(outside, link, 'junction');
  office.run();
  house.run();
  check('house: linked skill arrived as a normal folder', fs.existsSync(path.join(house.claude, 'skills', 'linked-skill', 'SKILL.md')));
  fs.rmSync(path.join(house.claude, 'skills', 'linked-skill'), { recursive: true, force: true });
  house.run();
  office.run();
  check('office: the file outside Claude Code still exists', fs.existsSync(path.join(outside, 'SKILL.md')));
  check('office: the refusal is recorded as a pending item', JSON.stringify(office.state().itemFailures).includes('linked-skill'));
}

// ---------------------------------------------------------------------------------------------
phase('the triggers repair each other');
{
  // Someone (or something) removed the hooks and the launcher: the next sync puts them back.
  const settingsFile = path.join(office.claude, 'settings.json');
  const s = JSON.parse(read(settingsFile));
  delete s.hooks;
  write(settingsFile, JSON.stringify(s, null, 2));
  fs.rmSync(path.join(office.sync, 'hook.cmd'), { force: true });
  fs.rmSync(path.join(office.sync, 'claude-sync.cmd'), { force: true });
  const st = office.state();
  delete st.triggersCheckedAt;
  fs.writeFileSync(path.join(office.sync, 'state.json'), JSON.stringify(st));
  check('a sync runs even with the hooks gone', office.run().status === 0);
  const back = JSON.parse(read(settingsFile));
  check('the sync put the four hooks back', ['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd'].every((e) => JSON.stringify(back.hooks?.[e] || '').includes('hook.cmd')), JSON.stringify(back.hooks));
  check('the sync put both launchers back', fs.existsSync(path.join(office.sync, 'hook.cmd')) && fs.existsSync(path.join(office.sync, 'claude-sync.cmd')));
  // The CLAUDE.md note too.
  const md = path.join(office.claude, 'CLAUDE.md');
  write(md, read(md).replace(/<!-- claude-sync:start -->[\s\S]*<!-- claude-sync:end -->/, ''));
  const st2 = office.state();
  delete st2.triggersCheckedAt;
  fs.writeFileSync(path.join(office.sync, 'state.json'), JSON.stringify(st2));
  office.run();
  check('the sync put the CLAUDE.md note back', read(md).includes('claude-sync:start'));
  check('and it does not rewrite them on every run', (() => {
    const before = fs.statSync(settingsFile).mtimeMs;
    office.run();
    office.run();
    return fs.statSync(settingsFile).mtimeMs === before;
  })());
}

// ---------------------------------------------------------------------------------------------
phase('uninstall');
{
  const r = house.tool(['uninstall']);
  const settings = JSON.parse(read(path.join(house.claude, 'settings.json')));
  check('uninstall removes hooks and CLAUDE.md block', r.status === 0 && !JSON.stringify(settings.hooks || {}).includes('claude-sync') && !read(path.join(house.claude, 'CLAUDE.md')).includes('claude-sync:start'), r.stderr);
  const tip = remoteTip();
  house.tool(['sync', '--quiet']);
  check('an uninstalled computer no longer pushes', remoteTip() === tip);
}

phase('review 3: reinstall pointing to another, empty repository deletes nothing');
{
  const slug2 = `${SLUG}-reinstall`;
  const env = { ...process.env, GH_TOKEN: TOKEN };
  sh('gh', ['repo', 'delete', slug2, '--yes'], { env });
  sleep(3000);
  check('second empty private repository created', sh('gh', ['repo', 'create', slug2, '--private'], { env }).status === 0);
  sleep(3000);
  const count = (dir) => { let n = 0; const walk = (d) => { for (const x of fs.readdirSync(d)) { const p = path.join(d, x); if (fs.statSync(p).isDirectory()) walk(p); else n++; } }; walk(dir); return n; };
  const skillsBefore = count(path.join(house.claude, 'skills'));
  const memBefore = count(path.join(house.project, 'memory'));
  const r = house.tool(['install', '--repo', `https://github.com/${slug2}.git`, '--name', house.label, '--token', house.token, '--no-task']);
  check('house: reinstall exits 0', r.status === 0, r.stderr + r.stdout);
  check('house: no skill or memory deleted', count(path.join(house.claude, 'skills')) === skillsBefore && count(path.join(house.project, 'memory')) === memBefore, `${skillsBefore}/${count(path.join(house.claude, 'skills'))} ${memBefore}/${count(path.join(house.project, 'memory'))}`);
  check('new repository received the content', fs.existsSync(path.join(house.repo, 'claude', 'skills', 'house-skill', 'SKILL.md')));
  sh('gh', ['repo', 'delete', slug2, '--yes'], { env });
}

console.log(`\n${pass} passed, ${fail} failed in ${Math.round((Date.now() - t0) / 1000)}s`);
process.exitCode = fail ? 1 : 0;
