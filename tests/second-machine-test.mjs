// Two real computers: an isolated profile on this machine as the first one, and a second Windows
// machine (a virtual machine driven through vmrun) as the other, installed from the single .cmd with no
// Node or Git on its PATH and with its own scheduled task. Nothing is typed on the second machine after
// the install: what arrives there has to arrive by itself. A window watcher runs there the whole time,
// because the sync must never show a window to the person using the computer.
//
// The second machine is described by the environment:
//   CLAUDE_SYNC_VM_VMX, CLAUDE_SYNC_VM_USER, CLAUDE_SYNC_VM_PASSWORD
//   CLAUDE_SYNC_VM_ENCRYPTION_PASSWORD  (only for an encrypted virtual machine)
//   CLAUDE_SYNC_VMRUN                   (only if vmrun is not in the usual place)
// It must already be running and logged in on the console, with portable copies of Node and Git under
// C:\Users\Public\ccsync\node and C:\Users\Public\ccsync\git. Everything else is shipped from here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOL, INSTALLER, PROJECT, sandbox, claudeBin, testRepo, testToken, machineToken, allTokens, secondMachine } from './env.mjs';

const VM = secondMachine();
if (!VM) {
  console.log('second machine not configured (CLAUDE_SYNC_VM_VMX, CLAUDE_SYNC_VM_USER, CLAUDE_SYNC_VM_PASSWORD); nothing to do');
  process.exit(0);
}
const VMRUN = VM.vmrun;
const VMX = VM.vmx;
const VMARGS = VM.args;
const ROOT = sandbox('second-machine');
const SLUG = testRepo('second');
const REPO = `https://github.com/${SLUG}.git`;
const CLAUDE_BIN = claudeBin();

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 30, ...opts });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const t0 = Date.now();
const el = () => `${Math.round((Date.now() - t0) / 1000)}s`;
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} (${el()})`); } else { fail++; console.log(`FAIL ${name} (${el()})\n     ${String(detail).slice(0, 1500)}`); }
};

const TOKEN = testToken();
const hide = (s) => allTokens().reduce((out, t) => out.split(t).join('***'), String(s ?? ''));

// The office: an isolated profile on this machine, never the real one.
const home = path.join(ROOT, 'first', 'Users', 'user-one');
const office = {
  home,
  claude: path.join(home, '.claude'),
  sync: path.join(home, '.claude-sync'),
  desktop: path.join(home, 'Desktop'),
  env: { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_SYNC_CLAUDE_BIN: CLAUDE_BIN, CLAUDE_SYNC_FAKE_PROGRAMS: path.join(ROOT, 'programs.json') },
};
office.project = path.join(office.claude, 'projects', office.desktop.replace(/[^a-zA-Z0-9]/g, '-'));
office.memory = path.join(office.project, 'memory');
delete office.env.CLAUDE_SYNC_DIR;
const tool = (args) => sh(process.execPath, [fs.existsSync(path.join(office.sync, 'claude-sync.mjs')) ? path.join(office.sync, 'claude-sync.mjs') : TOOL, ...args], { env: office.env, input: '', timeout: 20 * 60e3 });

// The second machine sleeps after its own idle time, like any computer. When it is found asleep it is
// woken up, and the sync there has to catch up by itself: that is part of what is being proven.
let wakeUps = 0;
function ensureVmOn() {
  if ((sh(VMRUN, ['-T', 'ws', 'list']).stdout || '').toLowerCase().includes(VMX.toLowerCase())) return;
  wakeUps++;
  console.log(`  the second machine was asleep; waking it up (${wakeUps}) (${el()})`);
  sh(VMRUN, [...VMARGS, 'start', VMX], { timeout: 300e3 });
  for (let i = 0; i < 60; i++) {
    if ((sh(VMRUN, [...VMARGS, 'checkToolsState', VMX]).stdout || '').trim() === 'running') return;
    sleep(5000);
  }
}
const guestRun = (cmdline, out) => { ensureVmOn(); return sh(VMRUN, [...VMARGS, 'runProgramInGuest', VMX, '-noWait', 'C:\\Windows\\System32\\cmd.exe', `/c ${cmdline} > ${out} 2>&1`], { timeout: 300e3 }); };
const guestGet = (guest, local) => { ensureVmOn(); return sh(VMRUN, [...VMARGS, 'copyFileFromGuestToHost', VMX, guest, local], { timeout: 300e3 }); };
const guestPut = (local, guest) => { ensureVmOn(); return sh(VMRUN, [...VMARGS, 'copyFileFromHostToGuest', VMX, local, guest], { timeout: 300e3 }); };
// Claude Code names a project folder after its path, with everything that is not a letter or a digit
// turned into a dash. The memory of the Desktop project on the second machine lives here.
const guestProject = `${VM.home}\\Desktop`.replace(/[^a-zA-Z0-9]/g, '-');
const guestMemory = (name) => `${VM.home}\\.claude\\projects\\${guestProject}\\memory\\${name}`;
const guestRead = (guest) => {
  const local = path.join(ROOT, `pull-${crypto.randomUUID().slice(0, 8)}.txt`);
  const r = guestGet(guest, local);
  if (r.status !== 0) return null;
  const text = fs.readFileSync(local, 'utf8');
  fs.rmSync(local, { force: true });
  return text;
};

console.log(`VM end-to-end, repository ${REPO}`);
ensureVmOn();
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
{
  // A fresh repository every run, and none of the ones an earlier move created next to it.
  const env = { ...process.env, GH_TOKEN: TOKEN };
  const [owner, name] = SLUG.split('/');
  const list = sh('gh', ['repo', 'list', owner, '--limit', '500', '--json', 'name', '--jq', '.[].name'], { env }).stdout.split(/\r?\n/).filter(Boolean);
  for (const n of list.filter((x) => x === name || x.startsWith(`${name}-`))) sh('gh', ['repo', 'delete', `${owner}/${n}`, '--yes'], { env });
  sleep(4000);
  const r = sh('gh', ['repo', 'create', SLUG, '--private', '--description', 'claude-sync second machine test data'], { env });
  check('test repository recreated (private)', r.status === 0, r.stderr);
  sleep(4000);
}
write(path.join(ROOT, 'programs.json'), JSON.stringify({ winget: ['Git.Git'], npm: [], pip: [] }));

// ---------------------------------------------------------------------------------------------
// The first computer, with the kind of content a person really has
write(path.join(office.claude, 'CLAUDE.md'), '# Global rules\r\n\r\n- Always answer in the language of the question.\r\n');
write(path.join(office.claude, 'skills', 'monthly-report', 'SKILL.md'), '---\nname: monthly-report\ndescription: builds the monthly report\n---\nBuilds the monthly report.\n');
write(path.join(office.memory, 'MEMORY.md'), '# Index\n- [Weekly meeting](project_meeting.md)\n');
write(path.join(office.memory, 'project_meeting.md'), `---\nname: project_meeting\n---\nMeeting every Monday. Files in ${office.desktop}\\Meeting\n`);
write(path.join(office.project, `${crypto.randomUUID()}.jsonl`), `${JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), cwd: office.desktop, message: { role: 'user', content: 'Summarise the minutes' } })}\n`);
write(path.join(office.claude, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--user-data-dir', `${office.home}\\pw`] } } }, null, 2));

// The first computer installs from the repository as Claude downloads it (the .cmd and its documents in
// the temporary folder), and ends with the package for the other computer on its Desktop.
const officeCmd = path.join(office.home, 'AppData', 'Local', 'Temp', 'claude-sync-setup', 'claude-sync-main', 'claude-sync.cmd');
const officeZip = path.join(office.desktop, 'claude-sync-computer-2.zip');
fs.mkdirSync(path.dirname(officeCmd), { recursive: true });
fs.copyFileSync(INSTALLER, officeCmd);
for (const doc of ['README.md', 'README.pt-BR.md']) fs.copyFileSync(path.join(PROJECT, doc), path.join(path.dirname(officeCmd), doc));
const cmdRun = (file, args) => sh('cmd.exe', ['/d', '/c', file, ...args], { env: office.env, input: '', timeout: 20 * 60e3 });
{
  const r = cmdRun(officeCmd, ['install', '--repo', REPO, '--name', 'One', '--token', machineToken(0), '--no-task']);
  check('office installs from the single file and pushes', r.status === 0 && /Health: ok/.test(r.stdout), hide(r.stderr + r.stdout));
  check('office leaves the package for the other computer on its Desktop', fs.existsSync(officeZip), fs.existsSync(office.desktop) ? fs.readdirSync(office.desktop).join('|') : 'no Desktop');
  // The file learns the other computer's own key as well, so nothing is typed over there.
  const m = cmdRun(officeCmd, ['remember', '--repo', REPO, '--carry-token', '--token', machineToken(1)]);
  check('the carried file learns the address and the key', m.status === 0 && fs.readFileSync(officeCmd, 'utf8').includes(REPO), hide(m.stderr + m.stdout));
  check('the installed copy does NOT carry the key', allTokens().every((t) => !fs.readFileSync(path.join(office.sync, 'claude-sync.mjs'), 'utf8').includes(t)));
  const put = guestPut(officeZip, `${VM.home}\\Desktop\\claude-sync-computer-2.zip`);
  check('the package reached the other computer', put.status === 0, put.stderr);
}

// ---------------------------------------------------------------------------------------------
// The VM: window watcher first, then the install from the single file
// Everything the second machine runs is shipped from here, so nothing has to be left there by hand.
const HERE = path.dirname(fileURLToPath(import.meta.url));
guestPut(path.join(HERE, 'watch-windows.ps1'), 'C:\\Users\\Public\\ccsync\\watch-windows.ps1');
guestPut(path.join(HERE, 'second-machine-install.cmd'), 'C:\\Users\\Public\\ccsync\\second-machine-install.cmd');
// Each run has its own output file: a watcher left running by an earlier run never writes into this one.
const WINDOWS_OUT = `C:\\Users\\Public\\ccsync\\windows-${Date.now()}.out`;
// -interactive is what puts the watcher on the logged-in desktop; without it it watches a window
// station where nothing the person could see ever appears, and the check below would pass for nothing.
// vmrun mangles the arguments of a program started directly, so the watcher goes through a .cmd.
guestPut(path.join(HERE, 'second-machine-watch.cmd'), 'C:\\Users\\Public\\ccsync\\second-machine-watch.cmd');
ensureVmOn();
sh(VMRUN, [...VMARGS, 'runProgramInGuest', VMX, '-noWait', '-interactive', 'C:\\Windows\\System32\\cmd.exe',
  `/c C:\\Users\\Public\\ccsync\\second-machine-watch.cmd 3000 ${WINDOWS_OUT}`], { timeout: 60e3 });
let watchStart = '';
for (let i = 0; i < 30 && !/WATCH START/.test(watchStart); i++) { sleep(2000); watchStart = guestRead(WINDOWS_OUT) || ''; }
// The desktop the person sees has the taskbar and several windows; a session no one sees shows about
// one. A handful is the sign that the watcher is looking at the right screen.
const visibleAtStart = Number((/WATCH START, visible windows: (\d+)/.exec(watchStart) || [])[1] || 0);
check('VM: the window watcher started, on the desktop the person sees', visibleAtStart >= 3, watchStart.slice(0, 300) || 'nothing written');
console.log(`window watcher started in the VM (${el()})`);

guestRun('C:\\Users\\Public\\ccsync\\second-machine-install.cmd "Two"', 'C:\\Users\\Public\\ccsync\\install5.out');
for (let i = 0; i < 60; i++) {
  sleep(10000);
  const out = guestRead('C:\\Users\\Public\\ccsync\\install5.out') || '';
  if (out.includes('DONE')) break;
  if (i % 3 === 0) console.log(`  installing in the VM... (${el()})`);
}
const installOut = guestRead('C:\\Users\\Public\\ccsync\\install5.out') || '';
fs.writeFileSync(path.join(ROOT, 'vm-install.out'), hide(installOut));
check('VM: unzips the package it received', /UNZIP_EXIT=0/.test(installOut), hide(installOut).slice(0, 1500));
check('VM: installs from the single .cmd with no Node or Git on the PATH', /INSTALL_EXIT=0/.test(installOut), hide(installOut).slice(-1500));
check('VM: makes no package of its own and is told to delete the one that carries the key', !installOut.includes('For the other computer') && installOut.includes('delete claude-sync-computer-2.zip'), hide(installOut).slice(-1500));
check('VM: reports it is private and healthy', /it is private/.test(installOut) && /Health: ok/.test(installOut), hide(installOut).slice(-800));
check('VM: scheduled task registered, not disabled', /Scheduled task: registered/.test(installOut) && !/DISABLED/.test(installOut), (installOut.match(/Scheduled task:.*/) || [''])[0]);
check('VM: all four hooks in place', /Claude Code hooks: 4 of 4/.test(installOut), (installOut.match(/Claude Code hooks:.*/) || [''])[0]);
check('VM: received the office content', /Tracked: [1-9]/.test(installOut), (installOut.match(/Tracked:.*/) || [''])[0]);

const skill = guestRead(`${VM.home}\\.claude\\skills\\monthly-report\\SKILL.md`);
check('VM: the office skill arrived', !!skill && skill.includes('monthly report'), skill);
const mem = guestRead(guestMemory('project_meeting.md'));
check('VM: the memory arrived with the path translated to this computer', !!mem && mem.includes(`${VM.home}\\Desktop\\Meeting`) && !mem.includes(office.home), mem);

// ---------------------------------------------------------------------------------------------
// Autonomy: something written at the office has to reach the VM with nobody touching the VM
const secret = `MELANCIA-${Math.floor(Math.random() * 9000 + 1000)}`;
write(path.join(office.memory, 'project_autonomy.md'), `---\nname: project_autonomy\n---\nProof word: ${secret}\n`);
write(path.join(office.claude, 'skills', 'new-skill', 'SKILL.md'), `---\nname: new-skill\n---\nCreated on computer one: ${secret}\n`);
const pushed = tool(['sync', '--quiet']);
check('office pushes the new memory and skill', pushed.status === 0, hide(pushed.stderr));
console.log(`waiting for the VM scheduled task to bring it over by itself (${el()})`);

let arrived = null;
let waited = 0;
for (let i = 0; i < 45; i++) {
  sleep(20000);
  waited += 20;
  arrived = guestRead(guestMemory('project_autonomy.md'));
  if (arrived && arrived.includes(secret)) break;
  if (i % 3 === 0) console.log(`  ${waited}s waiting, nothing typed in the VM (${el()})`);
}
check('VM: the new memory arrived on its own, with no command typed in the VM', !!arrived && arrived.includes(secret), `after ${waited}s: ${arrived}`);
const newSkill = guestRead(`${VM.home}\\.claude\\skills\\new-skill\\SKILL.md`);
check('VM: the new skill arrived on its own', !!newSkill && newSkill.includes(secret), newSkill);

// ---------------------------------------------------------------------------------------------
// The other direction, and the window watcher's verdict
const back = `ABACATE-${Math.floor(Math.random() * 9000 + 1000)}`;
write(path.join(ROOT, 'from-vm.md'), `---\nname: project_from_two\n---\nWritten on computer two: ${back}\n`);
guestPut(path.join(ROOT, 'from-vm.md'), guestMemory('project_from_two.md'));
console.log(`waiting for the VM to push it by itself (${el()})`);
let cameBack = '';
for (let i = 0; i < 30; i++) {
  sleep(20000);
  ensureVmOn(); // what comes back depends on the scheduled task there, so it has to be awake
  tool(['sync', '--quiet']);
  const p = path.join(office.memory, 'project_from_two.md');
  cameBack = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (cameBack.includes(back)) break;
}
check('office: what was written in the VM came back on its own', cameBack.includes(back), cameBack);

// ---------------------------------------------------------------------------------------------
// The office moves the sync to a fresh repository. The VM is never touched: its scheduled task has to
// find the note in the old repository, follow it, and keep syncing through the new one, with no window.
const oldRepo = JSON.parse(fs.readFileSync(path.join(office.sync, 'state.json'), 'utf8')).repoUrl;
const moved = tool(['rotate', '--yes']);
const newRepo = JSON.parse(fs.readFileSync(path.join(office.sync, 'state.json'), 'utf8')).repoUrl;
check('office moves the sync to a new repository', moved.status === 0 && newRepo !== oldRepo, hide(moved.stderr + moved.stdout).slice(-1200));
const word = `JABUTI-${Math.floor(Math.random() * 9000 + 1000)}`;
write(path.join(office.memory, 'project_after_move.md'), `---\nname: project_after_move\n---\nAfter the move: ${word}\n`);
tool(['sync', '--quiet']);
console.log(`waiting for the VM to follow the move by itself (${el()})`);
let vmState = null;
let followed = '';
for (let i = 0; i < 45; i++) {
  sleep(20000);
  try { vmState = JSON.parse(guestRead(`${VM.home}\\.claude-sync\\state.json`) || 'null'); } catch { vmState = null; }
  followed = guestRead(guestMemory('project_after_move.md')) || '';
  if (vmState?.repoUrl === newRepo && followed.includes(word)) break;
  if (i % 3 === 0) console.log(`  ${(i + 1) * 20}s, VM on ${vmState?.repoUrl || '?'} (${el()})`);
}
check('VM: followed the move to the new repository on its own', vmState?.repoUrl === newRepo && vmState?.previousRepoUrl === oldRepo, JSON.stringify({ repo: vmState?.repoUrl, previous: vmState?.previousRepoUrl }));
check('VM: what the office wrote after the move arrived through the new repository', followed.includes(word), followed);
const afterWord = `CAJU-${Math.floor(Math.random() * 9000 + 1000)}`;
write(path.join(ROOT, 'from-vm-after.md'), `---\nname: project_vm_after_move\n---\nWritten on computer two after the move: ${afterWord}\n`);
guestPut(path.join(ROOT, 'from-vm-after.md'), guestMemory('project_vm_after_move.md'));
let afterBack = '';
for (let i = 0; i < 30; i++) {
  sleep(20000);
  ensureVmOn();
  tool(['sync', '--quiet']);
  const p = path.join(office.memory, 'project_vm_after_move.md');
  afterBack = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (afterBack.includes(afterWord)) break;
}
check('office: what the VM wrote after the move came back through the new repository', afterBack.includes(afterWord), afterBack);

const windows = guestRead(WINDOWS_OUT) || '';
fs.writeFileSync(path.join(ROOT, 'windows.out'), windows);
// A window of the sync would belong to a console or terminal host, or to one of the programs the sync runs.
// Windows of other programs (Windows' own panels waking up after sleep, for example) are listed, not counted.
const OURS = /process=(node|git|git-remote-https|powershell|pwsh|conhost|openconsole|windowsterminal|cmd|winget|python|py|claude|npm|bash|sh)\.exe\b/i;
const newWindows = windows.split('\n').filter((l) => /NEW WINDOW/.test(l));
const bad = newWindows.filter((l) => OURS.test(l));
for (const l of newWindows.filter((x) => !OURS.test(x))) console.log(`  a window of another program appeared, not the sync: ${l.trim()}`);
// The watcher has to have been looking: an empty file would otherwise pass this for nothing.
check('VM: the window watcher was still watching at the end', /WATCH START/.test(windows) && !/WATCH DONE/.test(windows), windows.slice(0, 300));
check('VM: no window appeared while the sync ran by itself', bad.length === 0, bad.slice(0, 10).join('\n'));

const status = guestRead('C:\\Users\\Public\\ccsync\\install5.out');
console.log(`\nthe second machine was found asleep and woken up ${wakeUps} time(s)`);
console.log(`\n${pass} passed, ${fail} failed in ${el()}`);
if (status) fs.writeFileSync(path.join(ROOT, 'final-status.txt'), hide(status));
process.exitCode = fail ? 1 : 0;
