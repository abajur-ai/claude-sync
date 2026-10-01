// Tests the single-file guided setup: the runbook it prints in each stage, the address it writes
// into itself, and a full install driven through the .cmd exactly as Claude would run it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import os from 'node:os';

import { INSTALLER as CMD_SRC, PROJECT, sandbox, claudeBin, testRepo, testToken, machineToken, allTokens } from './env.mjs';

const ROOT = sandbox('setup');
const SLUG = testRepo('setup');
const REPO_URL = `https://github.com/${SLUG}.git`;
const CLAUDE_BIN = claudeBin();

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 30, ...opts });
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}\n     ${String(detail).slice(0, 1200)}`); }
};

const TOKEN = testToken();
const hide = (s) => allTokens().reduce((out, t) => out.split(t).join('***'), String(s ?? ''));

const ZIP_NAME = 'claude-sync-computer-2.zip';
const DOCS = ['README.md', 'README.pt-BR.md'];
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // reads zip files
const zipEntries = (zip) => sh(TAR, ['-tf', zip]).stdout.split(/\r?\n/).filter(Boolean).sort();
// Unzips the way Claude Code on the other computer would, with PowerShell.
const unzip = (zip, dest) => sh('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`]).status === 0;
const bytesEqual = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
const hasKey = (file) => { try { const t = fs.readFileSync(file, 'utf8'); return allTokens().some((k) => t.includes(k)); } catch { return false; } };
const loginOf = (token) => sh('gh', ['api', 'user', '--jq', '.login'], { env: { ...process.env, GH_TOKEN: token } }).stdout.trim();
// The tests must never write to the Desktop of the computer that runs them.
const REAL_ZIP = path.join(os.homedir(), 'Desktop', ZIP_NAME);
const realZipBefore = fs.existsSync(REAL_ZIP);

function machine(name, label, keyIndex = 0) {
  const home = path.join(ROOT, name, 'Users', name);
  const m = { name, label, home, token: machineToken(keyIndex), claude: path.join(home, '.claude'), sync: path.join(home, '.claude-sync') };
  m.desktop = path.join(home, 'Desktop');
  m.zip = path.join(m.desktop, ZIP_NAME);
  m.cmd = path.join(home, 'claude-sync.cmd'); // the single file the person carries
  m.env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: m.claude, CLAUDE_SYNC_FAKE_PROGRAMS: path.join(ROOT, 'programs.json'), CLAUDE_SYNC_CLAUDE_BIN: CLAUDE_BIN, CLAUDECODE: '1' };
  m.run = (...args) => {
    const r = sh('cmd.exe', ['/d', '/c', m.cmd, ...args], { env: m.env });
    return { ...r, stdout: hide(r.stdout), stderr: hide(r.stderr) };
  };
  return m;
}

console.log('=== setup');
fs.rmSync(ROOT, { recursive: true, force: true });
write(path.join(ROOT, 'programs.json'), JSON.stringify({ winget: [], npm: [], pip: [] }));
{
  const env = { ...process.env, GH_TOKEN: TOKEN };
  sh('gh', ['repo', 'delete', SLUG, '--yes'], { env });
  sleep(3000);
  check('empty private repository for the test', sh('gh', ['repo', 'create', SLUG, '--private'], { env }).status === 0);
  sleep(3000);
}
const office = machine('escritorio', 'One');
const house = machine('two', 'Two', 1);
// The first computer runs the repository as Claude downloads it: the clean file and its documentation,
// unzipped in the temporary folder, never on the Desktop.
office.cmd = path.join(office.home, 'AppData', 'Local', 'Temp', 'claude-sync-setup', 'claude-sync-main', 'claude-sync.cmd');
fs.mkdirSync(path.dirname(office.cmd), { recursive: true });
fs.copyFileSync(CMD_SRC, office.cmd);
for (const doc of DOCS) fs.copyFileSync(path.join(PROJECT, doc), path.join(path.dirname(office.cmd), doc));
for (const m of [office, house]) fs.mkdirSync(m.claude, { recursive: true });
// content that already exists on the first computer and must reach the second one
write(path.join(office.claude, 'CLAUDE.md'), '# Global rules\n');
write(path.join(office.claude, 'skills', 'relatorio', 'SKILL.md'), '---\nname: relatorio\n---\nGera o relatorio semanal.\n');
write(path.join(office.claude, 'projects', 'C--x', 'memory', 'MEMORY.md'), '- [Perfil](perfil.md) - quem e o usuario\n');
write(path.join(office.claude, 'projects', 'C--x', 'memory', 'profile.md'), 'Works at the company.\n');

console.log('\n=== first computer: what Claude is told to do');
{
  const r = office.run('setup', '--print');
  const out = r.stdout;
  check('runbook printed for the first computer', r.status === 0 && out.includes('SETUP RUNBOOK') && out.includes('Stage: first'), out.slice(0, 400) + r.stderr);
  check('it guides the account creation', out.includes('github.com/signup') && out.includes('Continue with Google'));
  check('it creates the organization', out.includes('account/organizations/new') && out.includes('every repository of theirs'));
  check('it creates a private repository inside the organization', out.includes('/repositories/new') && out.includes('Private'));
  check('it handles a blocked automated browser', out.includes('Access has been restricted') && out.includes('start ""'));
  check('it handles the Confirm access screen', out.includes('Confirm access'));
  check('it has a fallback for the access key', out.includes('gh auth login') && out.includes('gh auth token'));
  check('it creates a classic access key that reaches every repository, with no expiry', out.includes('settings/tokens/new') && out.includes('scopes=repo') && out.includes('No expiration'));
  check('it tells Claude not to show the token', out.includes('Never print it in the'));
  check('it installs and then writes the address into this same file', out.includes('" install --repo') && out.includes('" remember --repo'));
  check('it speaks to the person in plain language', out.includes('Speak to the person in their language'));
  check('it tells the person that the zip on the Desktop goes to the other computer', out.includes(`${ZIP_NAME}, on their Desktop, is what goes to the other computer`) && out.includes('unzip it'));
  check('it never tells Claude to use cmd /c on the file', !/cmd \/c "/.test(out) && !read(office.cmd).split('\n').some((l) => /^rem .*cmd \/c/.test(l)));
}

console.log('\n=== first computer: install exactly as Claude would run it');
{
  const r = office.run('install', '--repo', REPO_URL, '--name', office.label, '--token', office.token, '--no-task');
  check('install through the single file', r.status === 0 && /Installed\./.test(r.stdout), r.stdout + r.stderr);
  check('the file learned the address by itself', read(office.cmd).includes(`repoUrl: "${REPO_URL}"`), read(office.cmd).split('\n').filter((l) => l.includes('repoUrl')).join(' '));
  const login = loginOf(office.token);
  const stored = (/githubLogin: "([^"]*)"/.exec(read(office.cmd)) || [])[1];
  check('the stored login is the account that owns the key, not the organization', !!login && stored === login && stored !== SLUG.split('/')[0], `stored ${stored}, key owner ${login}, owner in the address ${SLUG.split('/')[0]}`);
  const settings = JSON.parse(read(path.join(office.claude, 'settings.json')));
  check('hooks point at the installed copy', JSON.stringify(settings.hooks).includes('.claude-sync'), JSON.stringify(settings.hooks));
  check('the long-term folder is the hidden one in the user profile', fs.existsSync(path.join(office.sync, 'state.json')) && fs.existsSync(path.join(office.sync, 'claude-sync.mjs')));
  const status = office.run('status').stdout;
  check('status shows the repository and no error', status.includes(REPO_URL) && /Last error: none/.test(status), status);

  // The package for the other computer
  check('install said where the package for the other computer is', r.stdout.includes(`For the other computer: ${office.zip}`), r.stdout.slice(-800));
  check('the package is on the Desktop', fs.existsSync(office.zip));
  check('the Desktop holds the package and nothing else', fs.existsSync(office.desktop) && fs.readdirSync(office.desktop).join('|') === ZIP_NAME, fs.existsSync(office.desktop) ? fs.readdirSync(office.desktop).join('|') : 'no Desktop');
  const entries = zipEntries(office.zip);
  check('it holds the setup file and both documents, inside one folder', entries.join('|') === ['claude-sync/README.md', 'claude-sync/README.pt-BR.md', 'claude-sync/claude-sync.cmd'].join('|'), entries.join(' | '));
  const opened = path.join(ROOT, 'escritorio-zip');
  check('it unzips with PowerShell', unzip(office.zip, opened));
  check('the setup file inside is byte for byte the one that installed this computer, address included', bytesEqual(path.join(opened, 'claude-sync', 'claude-sync.cmd'), office.cmd));
  check('the documents inside are the ones that came with it', DOCS.every((d) => bytesEqual(path.join(opened, 'claude-sync', d), path.join(PROJECT, d))));
  check('no access key inside the package', !hasKey(path.join(opened, 'claude-sync', 'claude-sync.cmd')) && !/carriedToken: "[^"]/.test(read(path.join(opened, 'claude-sync', 'claude-sync.cmd'))));
  check('nothing was written to the Desktop of the computer running the tests', fs.existsSync(REAL_ZIP) === realZipBefore);
}

console.log('\n=== remember on the first computer refreshes the package');
{
  const before = fs.statSync(office.zip).mtimeMs;
  sleep(1100);
  const r = office.run('remember', '--repo', REPO_URL, '--login', loginOf(office.token));
  check('remember runs and names the package', r.status === 0 && r.stdout.includes(`For the other computer: ${office.zip}`), r.stdout + r.stderr);
  check('the package was written again', fs.statSync(office.zip).mtimeMs > before);
  const opened = path.join(ROOT, 'escritorio-zip-2');
  unzip(office.zip, opened);
  check('and it still matches the setup file', bytesEqual(path.join(opened, 'claude-sync', 'claude-sync.cmd'), office.cmd));
  check('no leftover temporary file on the Desktop', fs.readdirSync(office.desktop).join('|') === ZIP_NAME, fs.readdirSync(office.desktop).join('|'));
}

console.log('\n=== the package taken to the second computer');
{
  // The person carries the zip and unzips it on the Desktop of the second computer.
  fs.mkdirSync(house.desktop, { recursive: true });
  fs.copyFileSync(office.zip, path.join(house.desktop, ZIP_NAME));
  check('the package unzips on the second computer', unzip(path.join(house.desktop, ZIP_NAME), house.desktop));
  house.cmd = path.join(house.desktop, 'claude-sync', 'claude-sync.cmd');
  const r = house.run('setup', '--print');
  const out = r.stdout;
  check('runbook printed for the second computer', r.status === 0 && out.includes('Stage: join'), out.slice(0, 400));
  check('it knows the file came in the package', out.includes(`usually inside ${ZIP_NAME}`));
  check('it names the account to sign in with', out.includes(`account: ${loginOf(office.token)}`), out.split('\n').filter((l) => l.includes('account')).join(' | '));
  check('it already knows the repository', out.includes(REPO_URL));
  check('it does not ask to create an account again', !out.includes('github.com/signup') && !out.includes('account/organizations/new'));
  check('it only asks for sign in and a new key', out.includes('github.com/login') && out.includes('settings/tokens/new'));
  check('it names the organization of the repository', out.includes(`organization: ${SLUG.split('/')[0]}`), out.split('\n').filter((l) => l.includes('organization')).join(' | '));
  check('it checks that the content arrived', out.includes('Tracked'));
}

console.log('\n=== second computer: install with no address typed by anyone');
{
  const carried = fs.statSync(path.join(house.desktop, ZIP_NAME)).mtimeMs;
  const r = house.run('install', '--name', house.label, '--token', house.token, '--no-task');
  check('install without --repo, using the address inside the file', r.status === 0, r.stdout + r.stderr);
  check('the second computer does not make a package of its own', !r.stdout.includes('For the other computer') && fs.statSync(path.join(house.desktop, ZIP_NAME)).mtimeMs === carried && fs.readdirSync(house.desktop).sort().join('|') === ['claude-sync', ZIP_NAME].join('|'), fs.readdirSync(house.desktop).join('|'));
  check('its long-term folder is the hidden one in the user profile too', fs.existsSync(path.join(house.sync, 'state.json')));
  check('the office CLAUDE.md arrived', read(path.join(house.claude, 'CLAUDE.md')).includes('# Global rules'));
  check('the office skill arrived', fs.existsSync(path.join(house.claude, 'skills', 'relatorio', 'SKILL.md')));
  check('the office memory arrived', read(path.join(house.claude, 'projects', 'C--x', 'memory', 'profile.md')).includes('Works at the company.'));
  const status = house.run('status').stdout;
  check('status shows the other computer', status.includes('One'), status);
}

console.log('\n=== running the file again on a computer already set up');
{
  write(path.join(office.claude, 'skills', 'novo', 'SKILL.md'), '---\nname: novo\n---\nCriado depois.\n');
  const r = office.run('setup');
  check('it just syncs and reports', r.status === 0 && r.stdout.includes('claude-sync version'), r.stdout + r.stderr);
  const r2 = house.run('setup');
  check('the other computer receives the new skill by running the same file', r2.status === 0 && fs.existsSync(path.join(house.claude, 'skills', 'novo', 'SKILL.md')), r2.stdout + r2.stderr);
}

console.log('\n=== the technician path: address and key given by hand, repository not created yet');
{
  const slug2 = `${SLUG}-byhand`;
  const url2 = `https://github.com/${slug2}`;
  const env = { ...process.env, GH_TOKEN: TOKEN };
  sh('gh', ['repo', 'delete', slug2, '--yes'], { env });
  sleep(3000);
  check('the repository really does not exist', sh('gh', ['repo', 'view', slug2], { env }).status !== 0);
  const tech = machine('tecnico', 'One');
  fs.mkdirSync(tech.claude, { recursive: true });
  fs.copyFileSync(CMD_SRC, tech.cmd);
  write(path.join(tech.claude, 'CLAUDE.md'), '# Rules from computer one\n');
  const r = tech.run('setup', '--repo', url2, '--name', 'One', '--token', tech.token, '--no-task');
  check('setup with address and key skips the browser and installs', r.status === 0 && /Installed\./.test(r.stdout), r.stdout + r.stderr);
  check('it created the private repository by itself', /does not exist yet; creating it as private/.test(r.stdout) && sh('gh', ['repo', 'view', slug2, '--json', 'visibility', '--jq', '.visibility'], { env }).stdout.trim() === 'PRIVATE', r.stdout);
  check('the file learned the address', read(tech.cmd).includes(`repoUrl: "${url2}"`));
  const kind = (p) => sh('gh', ['api', p, '--jq', '.type // .owner.type'], { env }).stdout.trim();
  check('it created the repository under the owner of the address, organization or person alike', kind(`repos/${slug2}`) !== '' && kind(`repos/${slug2}`) === kind(`users/${slug2.split('/')[0]}`), `${kind(`repos/${slug2}`)} / ${kind(`users/${slug2.split('/')[0]}`)}`);

  check('a file run on its own still leaves the package, with the setup file alone', zipEntries(tech.zip).join('|') === 'claude-sync/claude-sync.cmd', fs.existsSync(tech.zip) ? zipEntries(tech.zip).join('|') : 'no package');

  const carry = tech.run('remember', '--carry-token');
  check('the file can carry the key too', carry.status === 0 && /carries the access key/.test(carry.stdout), carry.stdout + carry.stderr);
  const second = machine('tecnico2', 'Two');
  fs.mkdirSync(second.claude, { recursive: true });
  fs.mkdirSync(second.desktop, { recursive: true });
  fs.copyFileSync(tech.zip, path.join(second.desktop, ZIP_NAME));
  unzip(path.join(second.desktop, ZIP_NAME), second.desktop);
  second.cmd = path.join(second.desktop, 'claude-sync', 'claude-sync.cmd');
  check('the package carries the key after remember --carry-token', /carriedToken: "[^"]+"/.test(read(second.cmd)) && bytesEqual(second.cmd, tech.cmd));
  const r2 = second.run('setup');
  check('the second computer installs from the package with no argument at all', r2.status === 0 && /Installed\./.test(r2.stdout), r2.stdout + r2.stderr);
  check('and it tells Claude that the package is a key to delete', r2.stdout.includes(`delete ${ZIP_NAME}`), r2.stdout.slice(-400));
  check('the content of the first computer arrived', read(path.join(second.claude, 'CLAUDE.md')).includes('# Rules from computer one'));
  const tree = sh('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: path.join(second.sync, 'repo') }).stdout;
  const leaked = tree.split('\n').filter(Boolean).some((f) => {
    try { const text = fs.readFileSync(path.join(second.sync, 'repo', f), 'utf8'); return allTokens().some((t) => text.includes(t)); } catch { return false; }
  });
  check('the key never reached the repository', !leaked);
  check('the installed copies never hold the key', !hasKey(path.join(tech.sync, 'claude-sync.mjs')) && !hasKey(path.join(second.sync, 'claude-sync.mjs')));
  sh('gh', ['repo', 'delete', slug2, '--yes'], { env });
}
check('the Desktop of the computer running the tests was never touched', fs.existsSync(REAL_ZIP) === realZipBefore);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
