// Real Claude Code sessions across two isolated "computers": resume a conversation on the other
// computer, a memory written by Claude, hooks firing inside Claude, and the notice reaching Claude.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { TOOL, sandbox, claudeBin, testRepo, testToken, machineToken } from './env.mjs';

const ROOT = sandbox('claude');
const SLUG = testRepo('claude');
const REPO_URL = `https://github.com/${SLUG}.git`;
const CLAUDE_BIN = claudeBin();
const CREDENTIALS = path.join(process.env.USERPROFILE, '.claude', '.credentials.json');

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 30, ...opts });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const encodeKey = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}\n     ${String(detail).slice(0, 2000)}`); }
};
const waitFor = (fn, ms = 120e3) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; sleep(1000); } return false; };

const TOKEN = testToken();

function machine(name, home, label) {
  const m = { name, label, home, claude: path.join(home, '.claude'), sync: path.join(home, '.claude-sync'), desktop: path.join(home, 'Desktop') };
  m.env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: m.claude, CLAUDE_SYNC_FAKE_PROGRAMS: path.join(ROOT, 'programs.json'), CLAUDE_SYNC_CLAUDE_BIN: CLAUDE_BIN };
  m.project = path.join(m.claude, 'projects', encodeKey(m.desktop));
  m.tool = (args) => sh(process.execPath, [fs.existsSync(path.join(m.sync, 'claude-sync.mjs')) ? path.join(m.sync, 'claude-sync.mjs') : TOOL, ...args], { env: m.env, input: '' });
  m.idle = () => waitFor(() => !fs.existsSync(path.join(m.sync, 'sync.lock')));
  m.run = () => { m.idle(); const r = m.tool(['sync', '--quiet']); m.idle(); if (r.status) console.log(`     [${name}] sync: ${r.stderr}`); return r; };
  m.claudeP = (args) => {
    const r = sh(CLAUDE_BIN, ['-p', ...args, '--output-format', 'json'], { env: m.env, cwd: m.desktop, input: '', timeout: 5 * 60e3 });
    let j = {};
    try { j = JSON.parse(r.stdout); } catch { j = { result: r.stdout, error: r.stderr }; }
    console.log(`     [${name}] claude -> ${String(j.result).replace(/\s+/g, ' ').slice(0, 300)} (cost $${j.total_cost_usd ?? '?'})`);
    return j;
  };
  m.log = () => (fs.existsSync(path.join(m.sync, 'sync.log')) ? read(path.join(m.sync, 'sync.log')) : '');
  return m;
}

const office = machine('office', path.join(ROOT, 'office', 'Users', 'joao.silva'), 'One');
const house = machine('house', path.join(ROOT, 'house', 'Users', 'Ana Silva'), 'Two');

console.log('=== setup');
fs.rmSync(ROOT, { recursive: true, force: true });
{
  const env = { ...process.env, GH_TOKEN: TOKEN };
  sh('gh', ['repo', 'delete', SLUG, '--yes'], { env });
  sleep(4000);
  check('empty private test repository', sh('gh', ['repo', 'create', SLUG, '--private', '--description', 'claude-sync end-to-end test data'], { env }).status === 0);
  sleep(4000);
}
write(path.join(ROOT, 'programs.json'), JSON.stringify({ winget: [], npm: [], pip: [] }));
for (const m of [office, house]) {
  fs.mkdirSync(m.desktop, { recursive: true });
  fs.mkdirSync(m.claude, { recursive: true });
  fs.copyFileSync(CREDENTIALS, path.join(m.claude, '.credentials.json'));
}

try {
  console.log('\n=== house: Claude Code names its project folder for a user folder with an accent and a space');
  {
    const j = house.claudeP(['Reply only with: OK', '--model', 'haiku']);
    const dirs = fs.readdirSync(path.join(house.claude, 'projects'));
    check('Claude Code and claude-sync encode "João Silva" the same way', dirs.includes(encodeKey(house.desktop)), `claude: ${dirs.join(', ')} | claude-sync: ${encodeKey(house.desktop)} | ${JSON.stringify(j).slice(0, 300)}`);
  }

  console.log('\n=== office: install, then a real conversation');
  check('office install', office.tool(['install', '--repo', REPO_URL, '--name', office.label, '--token', machineToken(0), '--no-task']).status === 0);
  const logBefore = office.log().split('\n').length;
  const first = office.claudeP(['The code word for this project is ABACAXI-42. Reply only with: Noted.', '--model', 'haiku']);
  const sid = first.session_id;
  check('office: conversation created', !!sid && fs.existsSync(path.join(office.project, `${sid}.jsonl`)), JSON.stringify(first).slice(0, 500));
  check('office: Claude Code named the project folder like claude-sync does', fs.existsSync(office.project), fs.readdirSync(path.join(office.claude, 'projects')).join(', '));
  const hookSynced = waitFor(() => office.log().split('\n').slice(logBefore).some((l) => l.includes('sync ok')));
  check('office: the hooks inside Claude Code started a sync by themselves', hookSynced, office.log().split('\n').slice(logBefore).join('\n'));
  office.run();

  console.log('\n=== house: install and continue the office conversation');
  check('house install', house.tool(['install', '--repo', REPO_URL, '--name', house.label, '--token', machineToken(1), '--no-task']).status === 0);
  check('house: office conversation is on disk under the house project folder', fs.existsSync(path.join(house.project, `${sid}.jsonl`)));
  const resumed = house.claudeP(['--resume', sid, 'What is the code word for this project? Reply only with the code word.', '--model', 'haiku']);
  check('house: Claude remembers the office conversation', /ABACAXI-42/.test(String(resumed.result)), JSON.stringify(resumed).slice(0, 800));
  check('house: the conversation kept the same id', resumed.session_id === sid, resumed.session_id);
  house.idle();
  house.run();
  office.run();
  const back = office.claudeP(['--resume', sid, 'List, word for word, the questions I asked you in this conversation, one per line. Nothing else.', '--model', 'haiku']);
  check('office: sees the turn made at the house', /What is the code word for this project/i.test(String(back.result)) && back.session_id === sid, JSON.stringify(back).slice(0, 800));

  console.log('\n=== office: Claude writes a memory; the house learns it');
  office.idle();
  const mem = office.claudeP(['Save this to your auto memory so you remember it in future conversations: my favorite fruit is jabuticaba. Then reply only with: Saved.', '--model', 'sonnet', '--permission-mode', 'acceptEdits']);
  const memDir = path.join(office.project, 'memory');
  const memFiles = fs.existsSync(memDir) ? fs.readdirSync(memDir) : [];
  const saved = memFiles.some((f) => /jabuticaba/i.test(read(path.join(memDir, f))));
  check('office: Claude wrote the memory file', saved, `${memFiles.join(', ')} | ${JSON.stringify(mem).slice(0, 400)}`);
  office.idle();
  office.run();
  house.idle();
  house.run();
  check('house: memory file arrived', fs.existsSync(path.join(house.project, 'memory')) && fs.readdirSync(path.join(house.project, 'memory')).some((f) => /jabuticaba/i.test(read(path.join(house.project, 'memory', f)))));
  const notice = house.claudeP(['Does your context contain a message that starts with [claude-sync]? If yes, copy its first line exactly. If not, reply only: NONE', '--model', 'haiku']);
  // What Claude Code hands the model at session start is recorded in the session transcript as the
  // SessionStart hook's content; the model's own answer about its context is only logged above.
  const noticeRows = (() => {
    try { return read(path.join(house.project, `${notice.session_id}.jsonl`)).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  })();
  const delivered = noticeRows.some((o) => o.attachment?.hookEvent === 'SessionStart' && o.attachment?.type === 'hook_success'
    && String(o.attachment.content).startsWith("[claude-sync] Since the last session these changes arrived from the user's other computer"));
  check('house: the [claude-sync] notice reached Claude at session start', delivered, `${noticeRows.length} rows | ${JSON.stringify(notice).slice(0, 600)}`);
  house.idle();
  const fruit = house.claudeP(['What is my favorite fruit? Reply with one word.', '--model', 'haiku']);
  check('house: a new conversation knows the memory made at the office', /jabuticaba/i.test(String(fruit.result)), JSON.stringify(fruit).slice(0, 800));

  console.log('\n=== repository never received the login');
  office.run();
  const tree = sh('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: path.join(office.sync, 'repo') }).stdout;
  check('no credentials file in the repository', !/credentials/i.test(tree), tree);

  console.log('\n=== the repository is getting full: Claude asks the person, in their language, before anything moves');
  // GitHub reports the size twice a day; here it is set by hand, as if GitHub had said 900 MB.
  const houseState = () => JSON.parse(read(path.join(house.sync, 'state.json')));
  write(path.join(house.sync, 'repo-size.json'), JSON.stringify({ url: houseState().repoUrl, mb: 900, private: true, at: Date.now() }));
  fs.rmSync(path.join(house.sync, 'rotate-offer.json'), { force: true });
  house.idle();
  const ask = house.claudeP(['Olá, bom dia!', '--model', 'sonnet']);
  const said = String(ask.result);
  check('house: Claude tells the person the storage is filling up and asks before moving it', /\?/.test(said) && /(armazenamento|espaço|cheio|enchendo|novo)/i.test(said) && !/rotate|--yes|\.cmd/.test(said), said.slice(0, 700));
  check('house: nothing moved without an answer', houseState().repoUrl === REPO_URL || houseState().repoUrl === REPO_URL.replace(/\.git$/, ''), houseState().repoUrl);
} finally {
  for (const m of [office, house]) { m.idle(); fs.rmSync(path.join(m.claude, '.credentials.json'), { force: true }); }
  console.log('\ncredential copies removed');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
