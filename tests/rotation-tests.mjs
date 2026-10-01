// Moving the sync to a fresh repository: the size check, the offer to the user, the move itself, the
// other computer following on its own, and the situations that break a move in real life (both
// computers moving at once, a computer that stayed off through several moves, an unreachable or
// foreign note, notes pointing round in a circle, a move cut short, an old carried file).
// Uses real private GitHub repositories named after CLAUDE_SYNC_TEST_REPO with the suffix "-rot";
// every repository whose name starts with that is deleted and recreated by this test.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';

import { TOOL, sandbox, claudeBin, testRepo, testToken, machineToken } from './env.mjs';

const ROOT = sandbox('rotation');
const BASE = testRepo('rot');
const [OWNER, BASE_NAME] = BASE.split('/');
const url = (slug) => `https://github.com/${slug}`;
const slugOf = (u) => new URL(u).pathname.split('/').filter(Boolean).slice(0, 2).join('/').replace(/\.git$/, '');
const BASE_URL = url(BASE);
const CLAUDE_BIN = claudeBin();
const TOKEN = testToken();
const GH_ENV = { ...process.env, GH_TOKEN: TOKEN };
const GIT_ENV = {
  ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '5',
  GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
  GIT_CONFIG_KEY_2: 'core.autocrlf', GIT_CONFIG_VALUE_2: 'false',
  GIT_CONFIG_KEY_3: 'user.name', GIT_CONFIG_VALUE_3: 'rotation test',
  GIT_CONFIG_KEY_4: 'user.email', GIT_CONFIG_VALUE_4: 'rotation-test@users.noreply.github.com',
};

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 30, ...opts });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const encodeKey = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const jsonl = (rows) => `${rows.map((o) => JSON.stringify(o)).join('\n')}\n`;
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400e3;
const t0 = Date.now();

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `\n     ${String(detail).slice(0, 1500)}` : ''}`); }
}
const phase = (t) => console.log(`\n=== ${t} (${Math.round((Date.now() - t0) / 1000)}s)`);
function waitFor(fn, ms = 90e3) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; sleep(1000); }
  return false;
}

// ---------------------------------------------------------------------------------------------
// GitHub helpers: only repositories named BASE or BASE-* are ever created or deleted here.

const ours = (slug) => slug === BASE || slug.startsWith(`${BASE}-`);
function deleteRepo(slug) {
  if (!ours(slug)) throw new Error(`refusing to delete ${slug}`);
  sh('gh', ['repo', 'delete', slug, '--yes'], { env: GH_ENV });
}
function createRepo(slug) {
  if (!ours(slug)) throw new Error(`refusing to create ${slug}`);
  const r = sh('gh', ['repo', 'create', slug, '--private', '--description', 'claude-sync rotation test data'], { env: GH_ENV });
  sleep(3000);
  return r;
}
const isPrivate = (slug) => sh('gh', ['api', `repos/${slug}`, '--jq', '.private'], { env: GH_ENV }).stdout.trim() === 'true';
const ownerOfRepo = (slug) => sh('gh', ['api', `repos/${slug}`, '--jq', '.owner.login + " " + .owner.type'], { env: GH_ENV }).stdout.trim();
const tipOf = (slug) => (sh('git', ['ls-remote', url(slug), 'refs/heads/main'], { env: GIT_ENV }).stdout.split(/\s+/)[0] || '');

let cloneCount = 0;
function cloneOf(slug) {
  const dir = path.join(ROOT, 'clones', String(++cloneCount));
  const r = sh('git', ['clone', '-q', '--depth', '1', url(slug), dir], { env: GIT_ENV });
  if (r.status !== 0 || !fs.existsSync(path.join(dir, '.git'))) { fs.mkdirSync(dir, { recursive: true }); sh('git', ['init', '-q', '-b', 'main', dir]); sh('git', ['remote', 'add', 'origin', url(slug)], { cwd: dir }); }
  return dir;
}
function remoteFiles(slug) {
  const dir = cloneOf(slug);
  const out = new Set();
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d)) {
      if (n === '.git') continue;
      const p = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      if (fs.statSync(p).isDirectory()) walk(p, r); else out.add(r);
    }
  };
  walk(dir, '');
  return { files: out, dir, has: (rel) => [...out].some((f) => f === rel || f.startsWith(`${rel}.ccsync-part-`)), read: (rel) => read(path.join(dir, rel)) };
}
function pushChange(slug, change, message) {
  const dir = cloneOf(slug);
  change(dir);
  sh('git', ['add', '-A', '--force'], { cwd: dir, env: GIT_ENV });
  sh('git', ['commit', '-q', '-m', message], { cwd: dir, env: GIT_ENV });
  const r = sh('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: dir, env: GIT_ENV });
  if (r.status !== 0) console.log(`     push to ${slug} failed: ${r.stderr.trim()}`);
  return r.status === 0;
}
const setNote = (slug, note) => pushChange(slug, (d) => write(path.join(d, 'moved.json'), `${JSON.stringify(note, null, 2)}\n`), 'test: note');
const clearNote = (slug) => pushChange(slug, (d) => fs.rmSync(path.join(d, 'moved.json'), { force: true }), 'test: no note');

// ---------------------------------------------------------------------------------------------
// Computers

function machine(name, home, label, keyIndex) {
  const m = { name, label, home, token: machineToken(keyIndex) };
  m.claude = path.join(home, '.claude');
  m.sync = path.join(home, '.claude-sync');
  m.desktop = path.join(home, 'Desktop');
  m.programs = path.join(ROOT, `${name}-programs.json`);
  m.env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: m.claude, CLAUDE_SYNC_FAKE_PROGRAMS: m.programs, CLAUDE_SYNC_CLAUDE_BIN: CLAUDE_BIN };
  delete m.env.CLAUDE_SYNC_DIR;
  delete m.env.CLAUDE_SYNC_SELF;
  m.project = path.join(m.claude, 'projects', encodeKey(m.desktop));
  m.memory = path.join(m.project, 'memory');
  m.script = () => (fs.existsSync(path.join(m.sync, 'claude-sync.mjs')) ? path.join(m.sync, 'claude-sync.mjs') : TOOL);
  m.tool = (args, opts = {}) => sh(process.execPath, [opts.script || m.script(), ...args], { env: { ...m.env, ...(opts.env || {}) }, input: opts.input ?? '' });
  m.run = (...extra) => {
    const lock = path.join(m.sync, 'sync.lock');
    waitFor(() => !fs.existsSync(lock));
    const r = m.tool(['sync', '--quiet', ...extra]);
    waitFor(() => !fs.existsSync(lock));
    if (r.status !== 0) console.log(`     [${name}] sync exit ${r.status}: ${r.stderr.trim()}`);
    return r;
  };
  m.async = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [m.script(), ...args], { env: m.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  m.state = () => JSON.parse(read(path.join(m.sync, 'state.json')));
  m.setState = (patch) => write(path.join(m.sync, 'state.json'), JSON.stringify({ ...m.state(), ...patch }, null, 2));
  m.hook = (sub) => {
    const r = m.tool(['hook', sub], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'x' }) });
    waitFor(() => !fs.existsSync(path.join(m.sync, 'sync.lock')));
    return r.stdout;
  };
  m.conflicts = () => {
    const dir = path.join(m.sync, 'conflicts');
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out.push(p); } };
    walk(dir);
    return out;
  };
  m.installedConfigRepo = () => (/repoUrl: "([^"]*)"/.exec(read(path.join(m.sync, 'claude-sync.mjs'))) || [])[1];
  return m;
}

const office = machine('office', path.join(ROOT, 'office', 'Users', 'joao.silva'), 'One', 0);
const house = machine('house', path.join(ROOT, 'house', 'Users', 'Ana Silva'), 'Two', 1);
const third = machine('third', path.join(ROOT, 'third', 'Users', 'maria'), 'Three', 0);

const SID_NEW = 'aaaaaaaa-0000-4000-8000-000000000001';
const SID_OLD = 'aaaaaaaa-0000-4000-8000-000000000002';
const SID_NOTS = 'aaaaaaaa-0000-4000-8000-000000000003';
const SID_OLD2 = 'aaaaaaaa-0000-4000-8000-000000000004';
const convo = (m, sid, at, text = 'hello') => jsonl([
  { type: 'user', sessionId: sid, cwd: m.desktop, timestamp: iso(at - 60e3), message: { role: 'user', content: text } },
  { type: 'assistant', sessionId: sid, cwd: m.desktop, timestamp: iso(at), message: { role: 'assistant', content: `re: ${text}` } },
  { type: 'last-prompt', sessionId: sid, lastPrompt: text },
]);

// ---------------------------------------------------------------------------------------------
phase('setup: clean sandboxes and the test repositories');
fs.rmSync(ROOT, { recursive: true, force: true });
{
  const list = sh('gh', ['repo', 'list', OWNER, '--limit', '500', '--json', 'name', '--jq', '.[].name'], { env: GH_ENV }).stdout.split(/\r?\n/).filter(Boolean);
  const mine = list.filter((n) => n === BASE_NAME || n.startsWith(`${BASE_NAME}-`));
  for (const n of mine) deleteRepo(`${OWNER}/${n}`);
  if (mine.length) sleep(4000);
  const r = createRepo(BASE);
  check('base test repository created (private)', r.status === 0 && isPrivate(BASE), r.stderr);
}
const programs = JSON.stringify({ winget: ['Git.Git'], npm: ['npm'], pip: ['pip'] });
for (const m of [office, house, third]) write(m.programs, programs);

// ---------------------------------------------------------------------------------------------
phase('office and house installed on the same repository, with an old conversation among the new');
const OLD_AT = Date.now() - 400 * DAY;
write(path.join(office.claude, 'CLAUDE.md'), '# Rules\nBe brief.\n');
write(path.join(office.claude, 'settings.json'), JSON.stringify({ model: 'sonnet' }, null, 2));
write(path.join(office.claude, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: test\n---\nAlpha.\n');
write(path.join(office.memory, 'MEMORY.md'), '- [Profile](user_profile.md) - who the user is\n');
write(path.join(office.memory, 'user_profile.md'), '---\nname: user_profile\n---\nLikes short answers.\n');
for (const n of ['doomed_before', 'doomed_after', 'late']) write(path.join(office.memory, `${n}.md`), `${n}\n`);
write(path.join(office.project, `${SID_NEW}.jsonl`), convo(office, SID_NEW, Date.now() - DAY, 'recent'));
write(path.join(office.project, `${SID_OLD}.jsonl`), convo(office, SID_OLD, OLD_AT, 'old'));
write(path.join(office.project, `${SID_OLD2}.jsonl`), convo(office, SID_OLD2, OLD_AT - 30 * DAY, 'older, never picked up again'));
write(path.join(office.project, SID_OLD, 'tool-results', 'result-1.txt'), 'old tool output\n');
write(path.join(office.project, SID_OLD, 'subagents', 'agent-1.jsonl'), jsonl([{ type: 'user', timestamp: iso(OLD_AT), message: 'sub' }]));
// A transcript without dates inside: the file date decides.
write(path.join(office.project, `${SID_NOTS}.jsonl`), jsonl([{ type: 'user', message: 'no dates' }]));
const oldSecs = OLD_AT / 1000;
for (const p of [`${SID_OLD}.jsonl`, `${SID_OLD2}.jsonl`, `${SID_NOTS}.jsonl`, path.join(SID_OLD, 'tool-results', 'result-1.txt'), path.join(SID_OLD, 'subagents', 'agent-1.jsonl')]) {
  fs.utimesSync(path.join(office.project, p), oldSecs, oldSecs);
}
for (const m of [office, house]) {
  fs.mkdirSync(m.claude, { recursive: true });
  const r = m.tool(['install', '--repo', BASE_URL, '--name', m.label, '--token', m.token, '--no-task']);
  check(`${m.name}: install exits 0`, r.status === 0, r.stderr + r.stdout);
}
office.run(); house.run();
check('house received the old conversation', fs.existsSync(path.join(house.project, `${SID_OLD}.jsonl`)));
{
  const age = (Date.now() - fs.statSync(path.join(house.project, `${SID_OLD}.jsonl`)).mtimeMs) / DAY;
  // This is what makes file dates useless for the cut: at the house the old conversation is a new file.
  check('at the house the old conversation carries a new file date (it arrived today)', age < 1, `${age} days`);
}
// Each computer is compared with itself: a conversation holds folder paths, and each computer keeps
// them in its own form. Conflict copies made by the install itself (the note it adds to CLAUDE.md and
// the hooks it adds to settings.json, before it has seen the other computer) are not the move's doing.
const OLD_SHA = sha(path.join(office.project, `${SID_OLD}.jsonl`));
const HOUSE_OLD_SHA = sha(path.join(house.project, `${SID_OLD}.jsonl`));
const OLD2_SHA = { office: sha(path.join(office.project, `${SID_OLD2}.jsonl`)), house: sha(path.join(house.project, `${SID_OLD2}.jsonl`)) };
const baseConflicts = { office: office.conflicts().length, house: house.conflicts().length };
const noNewConflicts = (m) => m.conflicts().length === baseConflicts[m.name];

// ---------------------------------------------------------------------------------------------
phase('size check, the offer, "later", and a public repository');
{
  const r = office.tool(['sync', '--quiet', '--check-size']);
  const size = JSON.parse(read(path.join(office.sync, 'repo-size.json')));
  check('size read from GitHub and kept in its own file', r.status === 0 && size.url === BASE_URL && typeof size.mb === 'number' && size.private === true, JSON.stringify(size));
  check('status shows the measured size', /Repository size: \d+ MB, measured/.test(office.tool(['status']).stdout));
  write(path.join(office.sync, 'repo-size.json'), JSON.stringify({ url: url(`${BASE}-other`), mb: 950, private: true, at: Date.now() }));
  check('a size measured on another repository does not count', /Repository size: not measured yet/.test(office.tool(['status']).stdout));
  const offer = path.join(office.sync, 'rotate-offer.json');
  fs.rmSync(offer, { force: true });
  write(path.join(office.sync, 'repo-size.json'), JSON.stringify({ url: BASE_URL, mb: 900, private: true, at: Date.now() }));
  const first = office.hook('session-start');
  check('near the limit the session start asks the user', /is at 900 MB/.test(first) && /rotate --yes/.test(first) && /rotate --later/.test(first), first);
  check('the offer is recorded in its own file', !!JSON.parse(read(offer)).offeredAt);
  check('the offer is not repeated in the next session', !/is at 900 MB/.test(office.hook('session-start')));
  fs.rmSync(offer, { force: true });
  const later = office.tool(['rotate', '--later']);
  const until = JSON.parse(read(offer)).laterUntil;
  check('"later" postpones the offer for about a month', later.status === 0 && Math.abs(until - (Date.now() + 30 * DAY)) < DAY, later.stdout + later.stderr);
  check('a postponed offer is not made', !/is at 900 MB/.test(office.hook('session-start')));
  check('status says the move is postponed', /postponed until/.test(office.tool(['status']).stdout));
  write(path.join(office.sync, 'repo-size.json'), JSON.stringify({ url: BASE_URL, mb: 10, private: false, at: Date.now() }));
  const exposed = office.hook('session-start');
  check('a repository that became public is reported to the user', /is PUBLIC/.test(exposed) && /make it private/.test(exposed), exposed);
  // A move that already failed here is not offered again: it would fail the same way every 3 days.
  write(path.join(office.sync, 'repo-size.json'), JSON.stringify({ url: BASE_URL, mb: 900, private: true, at: Date.now() }));
  write(offer, JSON.stringify({ failedAt: Date.now(), failedFor: BASE_URL, failure: 'test failure' }));
  const failed = office.hook('session-start');
  check('after a failed move the user is told to call for help, not asked again', /did not work/.test(failed) && /contact/.test(failed) && !/rotate --yes/.test(failed), failed);
  // The offer was made for a repository this computer has left since (the other computer moved first).
  write(offer, JSON.stringify({ offeredAt: Date.now(), offeredFor: url(`${BASE}-somewhere-else`) }));
  const already = office.tool(['rotate', '--yes']);
  check('"rotate --yes" after the computer already moved does not move again', already.status === 0 && /already moved/.test(already.stdout)
    && office.state().repoUrl === BASE_URL && !office.state().rotateTarget, already.stdout + already.stderr);
  fs.rmSync(offer, { force: true });
  fs.rmSync(path.join(office.sync, 'repo-size.json'), { force: true });
}

// ---------------------------------------------------------------------------------------------
phase('the plan, and the moves that are refused');
{
  const tipBefore = tipOf(BASE);
  const plan = office.tool(['rotate']);
  check('without --yes it only explains, and changes nothing', plan.status === 0 && /would carry about/.test(plan.stdout) && /leave 2 older conversation/.test(plan.stdout)
    && office.state().repoUrl === BASE_URL && tipOf(BASE) === tipBefore, plan.stdout + plan.stderr);
  const foreign = office.tool(['rotate', '--yes', '--repo', 'https://github.com/someone-else-entirely/x']);
  check('a repository of another owner is refused', foreign.status !== 0 && /same owner/.test(foreign.stderr), foreign.stderr);
  const same = office.tool(['rotate', '--yes', '--repo', BASE_URL]);
  check('the current repository itself is refused', same.status !== 0 && /different one/.test(same.stderr), same.stderr);
  createRepo(`${BASE}-full`);
  pushChange(`${BASE}-full`, (d) => write(path.join(d, 'README.md'), 'someone else\n'), 'content');
  const full = office.tool(['rotate', '--yes', '--repo', url(`${BASE}-full`)]);
  check('a repository that already holds something is refused', full.status !== 0 && /already holds other content/.test(full.stderr), full.stderr);
  check('after a refused move nothing changed', office.state().repoUrl === BASE_URL && !remoteFiles(BASE).has('moved.json') && !office.state().rotateTarget);
}

// ---------------------------------------------------------------------------------------------
phase('the house works offline while the office moves');
write(path.join(house.memory, 'user_profile.md'), '---\nname: user_profile\n---\nLikes short answers. Edited at the house.\n');
write(path.join(house.claude, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: test\n---\nBeta.\n');
const R2 = `${BASE}-2`;
check('both computers have the files that will be removed around the move', ['doomed_before', 'doomed_after', 'late'].every((n) => fs.existsSync(path.join(house.memory, `${n}.md`))));
// Removed at the office right before it moves: the removal reaches the old repository only.
fs.rmSync(path.join(office.memory, 'doomed_before.md'));
{
  const r = office.tool(['rotate', '--yes']);
  check('office: the move finishes', r.status === 0 && /Done\. This computer now syncs through/.test(r.stdout), r.stdout + r.stderr);
  const s = office.state();
  check('office points at the next free name', s.repoUrl === url(R2), s.repoUrl);
  check('office remembers where it came from and the cut', s.previousRepoUrl === BASE_URL && Math.abs(s.transcriptsAfter - (Date.now() - 180 * DAY)) < DAY && !!s.rotatedAt && !s.rotateTarget && !s.pruneBase, JSON.stringify(s).slice(0, 400));
  check('the new repository is private', isPrivate(R2));
  check('the new repository sits next to the old one, same owner and same kind of owner', ownerOfRepo(R2) !== '' && ownerOfRepo(R2) === ownerOfRepo(BASE), `${ownerOfRepo(R2)} / ${ownerOfRepo(BASE)}`);
  const note = JSON.parse(remoteFiles(BASE).read('moved.json'));
  check('the old repository carries the note', note.to === url(R2) && note.keepAfter === s.transcriptsAfter && note.by === 'One', JSON.stringify(note));
  const fresh = remoteFiles(R2);
  for (const p of ['claude/CLAUDE.md', 'claude/settings.json', 'claude/skills/alpha/SKILL.md', 'claude/projects/{{HOME}}-Desktop/memory/MEMORY.md', `claude/projects/{{HOME}}-Desktop/${SID_NEW}.jsonl`, 'tool/claude-sync.mjs']) {
    check(`new repository holds ${p}`, fresh.has(p), [...fresh.files].join(', '));
  }
  for (const p of [`claude/projects/{{HOME}}-Desktop/${SID_OLD}.jsonl`, `claude/projects/{{HOME}}-Desktop/${SID_OLD2}.jsonl`, `claude/projects/{{HOME}}-Desktop/${SID_OLD}/tool-results/result-1.txt`, `claude/projects/{{HOME}}-Desktop/${SID_OLD}/subagents/agent-1.jsonl`]) {
    check(`new repository leaves out the old ${p.split('/').slice(3).join('/')}`, !fresh.has(p));
  }
  check('the old repository still holds the old conversation', remoteFiles(BASE).has(`claude/projects/{{HOME}}-Desktop/${SID_OLD}.jsonl`));
  check('the office still has the old conversation, untouched', sha(path.join(office.project, `${SID_OLD}.jsonl`)) === OLD_SHA && fs.existsSync(path.join(office.project, SID_OLD, 'tool-results', 'result-1.txt')));
  check('the installed copy now names the new repository', office.installedConfigRepo() === url(R2), office.installedConfigRepo());
  check('a conversation with no dates inside is carried (file dates do not agree between computers)', fresh.has(`claude/projects/{{HOME}}-Desktop/${SID_NOTS}.jsonl`));
  check('the note itself is not copied into the new repository', !fresh.has('moved.json'));
  // Removed at the office after the move, in the new repository.
  fs.rmSync(path.join(office.memory, 'doomed_after.md'));
  office.run();
}

// ---------------------------------------------------------------------------------------------
phase('the house follows by itself on its next sync');
{
  const oldTip = tipOf(BASE);
  house.run();
  const s = house.state();
  check('house moved to the new repository', s.repoUrl === url(R2), s.repoUrl);
  check('house took the same cut from the note', s.previousRepoUrl === BASE_URL && s.transcriptsAfter === office.state().transcriptsAfter);
  check('house wrote nothing more to the old repository', tipOf(BASE) === oldTip);
  const fresh = remoteFiles(R2);
  check("the house's offline edit reached the new repository", /Edited at the house/.test(fresh.read('claude/projects/{{HOME}}-Desktop/memory/user_profile.md')));
  check("the house's new skill reached the new repository", fresh.has('claude/skills/beta/SKILL.md'));
  check('no conflict copy was made at the house', noNewConflicts(house), house.conflicts().join(', '));
  check('a file removed at the office right before the move is removed at the house too', !fs.existsSync(path.join(house.memory, 'doomed_before.md')));
  check('a file removed at the office after the move is removed at the house too', !fs.existsSync(path.join(house.memory, 'doomed_after.md')));
  check('and neither came back to the new repository', !fresh.has('claude/projects/{{HOME}}-Desktop/memory/doomed_before.md') && !fresh.has('claude/projects/{{HOME}}-Desktop/memory/doomed_after.md'));
  // The old conversation is a new file at the house, but its content says it is old: it stays behind.
  check('the house does not carry the old conversation either (judged by its content)', !fresh.has(`claude/projects/{{HOME}}-Desktop/${SID_OLD}.jsonl`));
  check('the house keeps the old conversation on disk', sha(path.join(house.project, `${SID_OLD}.jsonl`)) === HOUSE_OLD_SHA);
  check('the house keeps the old conversation files', fs.existsSync(path.join(house.project, SID_OLD, 'tool-results', 'result-1.txt')));
  check('house: the installed copy names the new repository', house.installedConfigRepo() === url(R2));
  const notice = house.hook('session-start');
  check('house: the next session tells the user the storage was renewed', /renewed on the other computer/.test(notice), notice);
  office.run();
  check("office received the house's offline edit", /Edited at the house/.test(read(path.join(office.memory, 'user_profile.md'))));
  check("office received the house's new skill", fs.existsSync(path.join(office.claude, 'skills', 'beta', 'SKILL.md')));
}

// ---------------------------------------------------------------------------------------------
phase('everything keeps working after the move');
{
  write(path.join(office.memory, 'after_move.md'), 'written after the move\n');
  office.run(); house.run();
  check('a new memory travels office -> house', fs.existsSync(path.join(house.memory, 'after_move.md')));
  fs.rmSync(path.join(house.claude, 'skills', 'alpha'), { recursive: true, force: true });
  house.run(); office.run();
  check('a removal travels house -> office', !fs.existsSync(path.join(office.claude, 'skills', 'alpha', 'SKILL.md')));
  fs.appendFileSync(path.join(office.project, `${SID_OLD}.jsonl`), jsonl([{ type: 'user', sessionId: SID_OLD, timestamp: iso(Date.now()), message: 'picked up again' }]));
  office.run();
  check('an old conversation that is continued travels again', remoteFiles(R2).has(`claude/projects/{{HOME}}-Desktop/${SID_OLD}.jsonl`));
  house.run();
  const continued = read(path.join(house.project, `${SID_OLD}.jsonl`));
  check('the house gets the continued conversation', /picked up again/.test(continued) && continued.split('\n').length === read(path.join(office.project, `${SID_OLD}.jsonl`)).split('\n').length
    && continued.includes(JSON.stringify(house.desktop).slice(1, -1)), continued.slice(0, 400));
}

// ---------------------------------------------------------------------------------------------
phase('a move stopped at every step, the way a closed laptop would, is picked up again');
{
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stopAfter = (step) => office.tool(['rotate', '--yes'], { env: { CLAUDE_SYNC_TEST_STOP_AFTER: step } });

  // Right after creating the new repository: nothing moved, and the next try reuses it.
  let start = office.state().repoUrl;
  let r = stopAfter('created');
  const t1 = office.state().rotateTarget;
  check('stopped after "created": nothing moved yet', r.status === 3 && office.state().repoUrl === start && !!t1 && tipOf(slugOf(t1)) === '' && !remoteFiles(slugOf(start)).has('moved.json'), r.stdout + r.stderr);
  write(path.join(house.memory, 'during_stop.md'), 'x\n');
  house.run(); office.run();
  check('meanwhile both computers keep syncing where they are', fs.existsSync(path.join(office.memory, 'during_stop.md')));
  r = office.tool(['rotate', '--yes']);
  check('the next try reuses the repository it had created', r.status === 0 && new RegExp(`New repository: ${esc(t1)}`).test(r.stdout) && office.state().repoUrl === t1, r.stdout + r.stderr);
  house.run();
  check('and the house follows it', house.state().repoUrl === t1);

  // After filling the new repository, before the note: the house sends something to the current
  // repository in between, and the next try fills the new one again with it.
  start = office.state().repoUrl;
  r = stopAfter('seeded');
  const t2 = office.state().rotateTarget;
  check('stopped after "seeded": the new repository is filled, but nobody was told', r.status === 3 && office.state().repoUrl === start && tipOf(slugOf(t2)) !== '' && !remoteFiles(slugOf(start)).has('moved.json'), r.stdout + r.stderr);
  write(path.join(house.memory, 'between_fill_and_note.md'), 'written in between\n');
  house.run();
  check('the house is not sent anywhere yet', house.state().repoUrl === start);
  r = office.tool(['rotate', '--yes']);
  check('the next try finishes on the same repository', r.status === 0 && office.state().repoUrl === t2, r.stdout + r.stderr);
  check('and carries what the house wrote in between', remoteFiles(slugOf(t2)).has('claude/projects/{{HOME}}-Desktop/memory/between_fill_and_note.md'));
  house.run(); office.run();
  check('both keep it', house.state().repoUrl === t2 && fs.existsSync(path.join(house.memory, 'between_fill_and_note.md')) && fs.existsSync(path.join(office.memory, 'between_fill_and_note.md')));

  // Right after the note, before switching: each computer follows the note on its own.
  start = office.state().repoUrl;
  r = stopAfter('noted');
  const t3 = office.state().rotateTarget;
  check('stopped after "noted": the note is there, and the office has not switched', r.status === 3 && office.state().repoUrl === start && JSON.parse(remoteFiles(slugOf(start)).read('moved.json')).to === t3, r.stdout + r.stderr);
  write(path.join(office.memory, 'before_switching.md'), 'x\n');
  house.run(); office.run(); house.run();
  check('both end on the new repository', office.state().repoUrl === t3 && house.state().repoUrl === t3);
  check('what the office wrote before switching arrives', fs.existsSync(path.join(house.memory, 'before_switching.md')));
  check('no conflict copies from the stops', noNewConflicts(office) && noNewConflicts(house), [...office.conflicts(), ...house.conflicts()].join(', '));

  // The other computer picked the same new name and filled it first: this one never overwrites it.
  r = stopAfter('seeded');
  const t4 = office.state().rotateTarget;
  const officeFill = tipOf(slugOf(t4));
  house.setState({ rotateTarget: t4 });
  const h = house.tool(['rotate', '--yes']);
  check("a computer never overwrites the other computer's fill of the same new repository", h.status !== 0 && tipOf(slugOf(t4)) === officeFill && /already holds other content/.test(h.stderr), `${h.status} ${h.stderr}`);
  r = office.tool(['rotate', '--yes']);
  house.run();
  check('the office finishes its move and the house follows it', r.status === 0 && office.state().repoUrl === t4 && house.state().repoUrl === t4, r.stderr);
}

// ---------------------------------------------------------------------------------------------
phase('the house moves: it received the old conversations, so only their content says they are old');
{
  const r = house.tool(['rotate', '--yes']);
  check('house: the move finishes', r.status === 0, r.stdout + r.stderr);
  const fresh = remoteFiles(slugOf(house.state().repoUrl));
  check('the house left behind the old conversation it had received', !fresh.has(`claude/projects/{{HOME}}-Desktop/${SID_OLD2}.jsonl`));
  check('the house carried the recent and the continued conversations', fresh.has(`claude/projects/{{HOME}}-Desktop/${SID_NEW}.jsonl`) && fresh.has(`claude/projects/{{HOME}}-Desktop/${SID_OLD}.jsonl`));
  office.run();
  check('office followed the house', office.state().repoUrl === house.state().repoUrl);
}

// ---------------------------------------------------------------------------------------------
phase('both computers move at the same moment');
{
  const PREV = slugOf(office.state().repoUrl);
  const [a, b] = await Promise.all([office.async(['rotate', '--yes']), house.async(['rotate', '--yes'])]);
  check('office: exits 0', a.status === 0, a.stdout + a.stderr);
  check('house: exits 0', b.status === 0, b.stdout + b.stderr);
  const x = office.state().repoUrl;
  check('both end on the same repository', x === house.state().repoUrl && x !== url(PREV), `${x} / ${house.state().repoUrl}`);
  check('the note in the previous repository names that one', JSON.parse(remoteFiles(PREV).read('moved.json')).to === x);
  write(path.join(office.memory, 'race_office.md'), 'o\n');
  write(path.join(house.memory, 'race_house.md'), 'h\n');
  office.run(); house.run(); office.run();
  check('after the race both sides still sync', fs.existsSync(path.join(house.memory, 'race_office.md')) && fs.existsSync(path.join(office.memory, 'race_house.md')));
  check('no conflict copies after the race', noNewConflicts(office) && noNewConflicts(house), [...office.conflicts(), ...house.conflicts()].join(', '));
  const unused = [a, b].map((r) => /(\S+) was created for the move and is not used/.exec(r.stdout)?.[1]).filter(Boolean);
  for (const u of unused) check(`the repository made by the other computer (${u}) is reported and not used`, u !== x);
}

// ---------------------------------------------------------------------------------------------
phase('the other computer stays off through two moves, then follows the chain');
{
  office.tool(['rotate', '--yes']);
  write(path.join(office.memory, 'chain.md'), 'between moves\n');
  office.run();
  const second = office.tool(['rotate', '--yes']);
  check('office moved twice', second.status === 0, second.stderr);
  house.run();
  check('house followed the whole chain in one sync', house.state().repoUrl === office.state().repoUrl, `${house.state().repoUrl} / ${office.state().repoUrl}`);
  check('house got what was written between the moves', fs.existsSync(path.join(house.memory, 'chain.md')));
  const told = house.hook('session-start');
  check('the user is told once, not once per move', (told.match(/renewed on the other computer/g) || []).length === 1, told);
}

// ---------------------------------------------------------------------------------------------
phase('a computer that runs "rotate" after the other already moved just follows');
{
  const r = office.tool(['rotate', '--yes']);
  check('office moved', r.status === 0, r.stderr);
  const h = house.tool(['rotate', '--yes']);
  check('house follows instead of making another repository', h.status === 0 && /already moved the sync/.test(h.stdout) && house.state().repoUrl === office.state().repoUrl, h.stdout + h.stderr);
}

// ---------------------------------------------------------------------------------------------
phase('a note that cannot be followed');
const CURRENT = slugOf(office.state().repoUrl);
{
  setNote(CURRENT, { to: url(`${BASE}-does-not-exist`), at: Date.now(), by: 'test', keepAfter: 0 });
  office.run(); house.run();
  const s = office.state();
  check('office stays where it is when the new repository is unreachable', s.repoUrl === url(CURRENT) && s.moveBlocked?.to === url(`${BASE}-does-not-exist`) && /cannot reach/.test(s.moveBlocked?.why), JSON.stringify(s.moveBlocked));
  write(path.join(office.memory, 'waited.md'), 'x\n');
  const tipBefore = tipOf(CURRENT);
  office.run(); house.run();
  // Nobody reads a repository that carries a note: sending there would only be undone later.
  check('while it cannot follow, nothing is sent to the retired repository', tipOf(CURRENT) === tipBefore && !fs.existsSync(path.join(house.memory, 'waited.md')));
  check('the change waits, untouched, where it was made', fs.existsSync(path.join(office.memory, 'waited.md')));
  // Even with a full repository, a computer that cannot follow is not offered another move: that would
  // send the two computers to different repositories for good.
  write(path.join(office.sync, 'repo-size.json'), JSON.stringify({ url: url(CURRENT), mb: 900, private: true, at: Date.now() }));
  fs.rmSync(path.join(office.sync, 'rotate-offer.json'), { force: true });
  const warn = office.hook('session-start');
  check('the user is told the computers stopped following each other', /did not follow it/.test(warn), warn);
  check('and is not offered another move meanwhile', !/rotate --yes/.test(warn), warn);
  const refused = office.tool(['rotate', '--yes']);
  const noteNow = JSON.parse(remoteFiles(CURRENT).read('moved.json'));
  check('"rotate --yes" is refused while it cannot follow, and the note is left as it was', refused.status !== 0 && /already moved/.test(refused.stderr) && noteNow.to === url(`${BASE}-does-not-exist`), refused.stderr);
  fs.rmSync(path.join(office.sync, 'repo-size.json'), { force: true });
  fs.rmSync(path.join(office.sync, 'rotate-offer.json'), { force: true });
  check('status explains it', /not followed here/.test(office.tool(['status']).stdout));
  clearNote(CURRENT);
  office.run();
  check('once the note is gone the warning clears', !office.state().moveBlocked);
  house.run();
  check('and the change that waited arrives', fs.existsSync(path.join(house.memory, 'waited.md')));
  setNote(CURRENT, { to: 'https://github.com/someone-else-entirely/claude-sync', at: Date.now(), by: 'test' });
  office.run();
  check('a note sending the sync to another owner is never followed', office.state().repoUrl === url(CURRENT) && /another owner/.test(office.state().moveBlocked?.why), JSON.stringify(office.state().moveBlocked));
  clearNote(CURRENT);
  office.run(); house.run();
}

// ---------------------------------------------------------------------------------------------
phase('notes that point round in a circle');
{
  const LOOP = `${BASE}-loop`;
  createRepo(LOOP);
  setNote(LOOP, { to: url(CURRENT), at: Date.now(), by: 'test' });
  setNote(CURRENT, { to: url(LOOP), at: Date.now(), by: 'test' });
  const before = sha(path.join(house.memory, 'user_profile.md'));
  const r = house.run();
  check('house does not hang or fail', r.status === 0, r.stderr);
  check('house reports the circle', /circle/.test(house.state().moveBlocked?.why || ''), JSON.stringify(house.state().moveBlocked));
  check('nothing was lost at the house', sha(path.join(house.memory, 'user_profile.md')) === before && fs.existsSync(path.join(house.memory, 'after_move.md')));
  clearNote(CURRENT);
  pushChange(LOOP, (d) => write(path.join(d, 'moved.json'), `${JSON.stringify({ to: url(CURRENT), at: Date.now(), by: 'test' })}\n`), 'back');
  house.run();
  office.run();
  check('with the circle broken the house finds its way back', house.state().repoUrl === url(CURRENT) && !house.state().moveBlocked, house.state().repoUrl);
}

// ---------------------------------------------------------------------------------------------
phase('a note pointing at an empty repository is not followed');
{
  // The computer that moves fills the new repository before it writes the note, so an empty one means
  // something went wrong there. Filling it from here would put this computer's older copy in it.
  const EMPTY = `${BASE}-empty`;
  createRepo(EMPTY);
  setNote(CURRENT, { to: url(EMPTY), at: Date.now(), by: 'test' });
  write(path.join(house.memory, 'waits_too.md'), 'x\n');
  house.run();
  check('house stays and says why', house.state().repoUrl === url(CURRENT) && /still empty/.test(house.state().moveBlocked?.why || ''), JSON.stringify(house.state().moveBlocked));
  check('nothing was put into the empty repository', tipOf(EMPTY) === '');
  clearNote(CURRENT);
  house.run(); office.run();
  check('with the note gone, the change that waited arrives', fs.existsSync(path.join(office.memory, 'waits_too.md')));
}

// ---------------------------------------------------------------------------------------------
phase('a new computer installed with the very first address follows the chain');
{
  fs.mkdirSync(third.claude, { recursive: true });
  const r = third.tool(['install', '--repo', BASE_URL, '--name', third.label, '--token', third.token, '--no-task']);
  check('third: install exits 0', r.status === 0, r.stderr + r.stdout.slice(-800));
  check('third ends on the current repository', third.state().repoUrl === office.state().repoUrl, third.state().repoUrl);
  check('third has the memories', fs.existsSync(path.join(third.memory, 'after_move.md')) && fs.existsSync(path.join(third.memory, 'chain.md')));
  check('third got the continued conversation', fs.existsSync(path.join(third.project, `${SID_OLD}.jsonl`)));
  check('third was not sent the conversation that stayed behind', !fs.existsSync(path.join(third.project, `${SID_OLD2}.jsonl`)));
}

// ---------------------------------------------------------------------------------------------
phase('installing again from an old carried file keeps the current repository');
{
  const carried = path.join(ROOT, 'old-carried.mjs');
  write(carried, read(TOOL).replace(/const CONFIG = \{[\s\S]*?\n\};/, () => `const CONFIG = {\n  repoUrl: ${JSON.stringify(BASE_URL)},\n  githubLogin: "",\n  supportName: "",\n  carriedToken: "",\n};`));
  const current = office.state().repoUrl;
  const r = office.tool(['install', '--name', office.label, '--token', office.token, '--no-task'], { script: carried });
  check('office: reinstall exits 0', r.status === 0, r.stderr + r.stdout.slice(-600));
  check('office stays on the current repository', office.state().repoUrl === current, office.state().repoUrl);
  check('the installed copy names the current repository', office.installedConfigRepo() === current, office.installedConfigRepo());
  // Removed and set up again from the same old file: it starts from the address it is given, and the
  // notes bring it back to where the other computer is.
  const removed = office.tool(['uninstall']);
  const again = office.tool(['install', '--name', office.label, '--token', office.token, '--no-task'], { script: carried });
  check('after an uninstall, the old carried file still leads to the current repository', removed.status === 0 && again.status === 0 && office.state().repoUrl === current, again.stderr + office.state().repoUrl);
  write(path.join(office.memory, 'after_reinstall.md'), 'x\n');
  office.run(); house.run();
  check('and the two computers keep syncing after it', fs.existsSync(path.join(house.memory, 'after_reinstall.md')));
  // A carried file naming a repository that no longer exists: it is never created again, which would
  // leave this computer alone in an empty repository.
  const gone = path.join(ROOT, 'gone-carried.mjs');
  write(gone, read(TOOL).replace(/const CONFIG = \{[\s\S]*?\n\};/, () => `const CONFIG = {\n  repoUrl: ${JSON.stringify(url(`${BASE}-gone`))},\n  githubLogin: "",\n  supportName: "",\n  carriedToken: "",\n};`));
  third.tool(['uninstall']);
  const g = third.tool(['install', '--name', third.label, '--token', third.token, '--no-task'], { script: gone });
  const exists = sh('gh', ['api', `repos/${BASE}-gone`], { env: GH_ENV }).status === 0;
  check('a carried file whose repository is gone does not create it again', g.status !== 0 && /no longer exists/.test(g.stderr) && !exists, g.stderr + g.stdout.slice(-300));
}

// ---------------------------------------------------------------------------------------------
phase('nothing was ever lost');
{
  for (const m of [office, house]) {
    check(`${m.name}: the conversations left behind are still on disk`, [SID_OLD2, SID_NOTS].every((s) => fs.existsSync(path.join(m.project, `${s}.jsonl`))));
    check(`${m.name}: the oldest one is byte for byte what it was`, sha(path.join(m.project, `${SID_OLD2}.jsonl`)) === OLD2_SHA[m.name]);
    check(`${m.name}: its files are still on disk`, fs.existsSync(path.join(m.project, SID_OLD, 'subagents', 'agent-1.jsonl')));
    check(`${m.name}: no conflict copies from any move`, noNewConflicts(m), m.conflicts().join(', '));
  }
  check('both computers agree on the memory', ['MEMORY.md', 'user_profile.md', 'after_move.md', 'chain.md', 'race_office.md', 'race_house.md']
    .every((n) => fs.existsSync(path.join(house.memory, n)) && sha(path.join(house.memory, n)) === sha(path.join(office.memory, n))));
}

console.log(`\n${pass} passed, ${fail} failed (${Math.round((Date.now() - t0) / 1000)}s)`);
process.exitCode = fail ? 1 : 0;
