@echo off
rem  claude-sync: keeps Claude Code identical on both computers of the same person.
rem
rem  For Claude Code: run  "%~f0" setup --print  and follow the runbook it prints.
rem  For a person: double click this file and follow what appears on the screen.
rem
setlocal enableextensions
set "CLAUDE_SYNC_SELF=%~f0"
set "NODE_EXE="
for %%N in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.claude-sync\node\node.exe" set "NODE_EXE=%USERPROFILE%\.claude-sync\node\node.exe"
if not defined NODE_EXE (
  echo Node.js nao foi encontrado neste computador, e o claude-sync precisa dele.
  echo Instale com este comando e rode este arquivo de novo:
  echo   winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  if "%~1"=="" pause
  exit /b 1
)
set "CLAUDE_SYNC_BOOT=%TEMP%\claude-sync-boot-%RANDOM%%RANDOM%.mjs"
del "%CLAUDE_SYNC_BOOT%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $t=[IO.File]::ReadAllText($env:CLAUDE_SYNC_SELF); $i=$t.LastIndexOf(':::CLAUDE-SYNC-PAYLOAD:::'); if ($i -lt 0) { throw 'marker not found' }; $p=$t.Substring($t.IndexOf([char]10,$i)+1); if ($p.Length -lt 10000) { throw 'payload too small' }; [IO.File]::WriteAllText($env:CLAUDE_SYNC_BOOT,$p,(New-Object Text.UTF8Encoding($false))) } catch { exit 1 }"
set "BOOT_OK="
for %%A in ("%CLAUDE_SYNC_BOOT%") do if %%~zA GTR 10000 set "BOOT_OK=1"
if not defined BOOT_OK (
  del "%CLAUDE_SYNC_BOOT%" >nul 2>&1
  echo Nao foi possivel preparar o arquivo claude-sync. Copie o arquivo para a area de trabalho e rode de novo.
  if "%~1"=="" pause
  exit /b 1
)
"%NODE_EXE%" "%CLAUDE_SYNC_BOOT%" %*
set "CLAUDE_SYNC_EXIT=%ERRORLEVEL%"
del "%CLAUDE_SYNC_BOOT%" >nul 2>&1
if "%~1"=="" pause
exit /b %CLAUDE_SYNC_EXIT%

:::CLAUDE-SYNC-PAYLOAD:::
#!/usr/bin/env node
// claude-sync keeps Claude Code identical across one person's computers.
//
// A private Git repository (GitHub) is the source of truth. Every computer runs
// `sync` from a Windows scheduled task (at logon and every 5 minutes) and from
// Claude Code hooks, so the person never has to do anything by hand.
//
// Synced: CLAUDE.md, rules, skills, agents, commands, output styles, workflows,
// themes, agent memory, keybindings, settings.json, auto memory, conversation
// transcripts, user-scope MCP servers and plugins. Programs installed after
// setup (winget, npm -g, pip) are reported to Claude on the other computers,
// which installs them with the person present.
//
// The repository size is read from GitHub twice a day. Near 1 GB the person is
// asked, through Claude, whether the sync can move to a fresh repository; the
// move leaves a note in the old one and the other computer follows by itself.
//
// Usage:
//   node claude-sync.mjs install --repo <https url> --name <label> --token <token> [--support <name>] [--no-task]
//   node claude-sync.mjs sync [--scan-programs] [--force] [--quiet] [--check-size]
//   node claude-sync.mjs rotate [--yes] [--later] [--repo <https url>] [--keep-days <n>] [--keep-all]
//   node claude-sync.mjs status
//   node claude-sync.mjs uninstall
//   node claude-sync.mjs hook <session-start|post-tool|stop|session-end>

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = 6;
const SCRIPT = fileURLToPath(import.meta.url);
const HOME = os.homedir();
const CLAUDE_DIR = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'));
const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR ? path.join(CLAUDE_DIR, '.claude.json') : path.join(HOME, '.claude.json');
const SYNC_DIR = path.resolve(process.env.CLAUDE_SYNC_DIR || path.join(HOME, '.claude-sync'));
const REPO_DIR = path.join(SYNC_DIR, 'repo');
const STATE_FILE = path.join(SYNC_DIR, 'state.json');
const NOTICES_DIR = path.join(SYNC_DIR, 'notices');
const NOTIFIED_FILE = path.join(SYNC_DIR, 'notified.json');
const LOCK_FILE = path.join(SYNC_DIR, 'sync.lock');
const RERUN_FILE = path.join(SYNC_DIR, 'rerun.flag');
const LOG_FILE = path.join(SYNC_DIR, 'sync.log');
const TOKEN_FILE = path.join(SYNC_DIR, 'token.dpapi');
const CONFLICTS_DIR = path.join(SYNC_DIR, 'conflicts');
const SIZE_FILE = path.join(SYNC_DIR, 'repo-size.json');
const OFFER_FILE = path.join(SYNC_DIR, 'rotate-offer.json');
const INSTALLED_SCRIPT = path.join(SYNC_DIR, 'claude-sync.mjs');
// Hooks call this launcher, so settings.json (which is synced) never holds a path that belongs to one computer.
const HOOK_LAUNCHER = path.join(SYNC_DIR, 'hook.cmd');
// Runs any command of the tool on this computer without needing Node on the PATH.
const TOOL_LAUNCHER = path.join(SYNC_DIR, 'claude-sync.cmd');
const TASK_NAME = 'claude-sync';
// Saved on the Desktop at the end of the setup: what the person takes to the other computer.
const CARRY_ZIP = 'claude-sync-computer-2.zip';
const BRANCH = 'main';
// Parts stay far below GitHub's 100 MB file limit, and a growing transcript only rewrites its last part.
const CHUNK_SIZE = 8 * 1024 * 1024;
const PART_MARK = '.ccsync-part-';
const TMP_SUFFIX = '.ccsync-tmp';
const FAILURE_WARN_MS = Number(process.env.CLAUDE_SYNC_FAILURE_WARN_MS) || 6 * 3600e3;
const PROGRAM_SCAN_MS = 3600e3;
const STATUS_EVERY_MS = 6 * 3600e3;
const MAINTENANCE_EVERY_MS = 24 * 3600e3;
const NOTIFY_AGAIN_MS = 24 * 3600e3;
// A lock is only taken from a process that still exists after this long (a recycled process id).
const LOCK_STALE_MS = 3 * 3600e3;
const MCP_REAPPLY_MS = 24 * 3600e3;
// A large history goes up in several commits: one push stays well under GitHub's 2 GB limit and a
// slow line never has to finish everything inside one run.
const UPLOAD_BUDGET = Number(process.env.CLAUDE_SYNC_UPLOAD_BUDGET) || 200 * 1024 * 1024;
const RUN_BUDGET_MS = Number(process.env.CLAUDE_SYNC_RUN_BUDGET_MS) || 20 * 60e3;
const TRIGGER_CHECK_MS = 3600e3;
const SESSION_START_WAIT_MS = 15e3;
const MAX_NOTICE_LINES = 25;
// GitHub asks repositories to stay under 1 GB. The size is read from the GitHub API (the local copy is
// shallow and does not know how big the repository really is) and the move to a fresh repository is
// offered well before the limit, so it happens calmly and only when the user agrees.
const SIZE_CHECK_MS = Number(process.env.CLAUDE_SYNC_SIZE_CHECK_MS) || 12 * 3600e3;
const ROTATE_SUGGEST_MB = Number(process.env.CLAUDE_SYNC_ROTATE_MB) || 800;
const ROTATE_OFFER_AGAIN_MS = 3 * 24 * 3600e3;
const ROTATE_LATER_MS = 30 * 24 * 3600e3;
// Conversations older than this are left where they are (on both computers and in the retired
// repository) instead of being carried into the new one, which is what actually frees space.
const ROTATE_KEEP_DAYS = Number(process.env.CLAUDE_SYNC_ROTATE_KEEP_DAYS) || 180;
// The retired repository carries this file: the other computer reads it and follows by itself.
const MOVE_FILE = 'moved.json';
const MAX_MOVE_HOPS = 30;
const CLAUDE_MD_START = '<!-- claude-sync:start -->';
const CLAUDE_MD_END = '<!-- claude-sync:end -->';
const MANAGERS = ['winget', 'npm', 'pip'];

// ==== setup configuration: written by the guided setup on the first computer, so the next computer
// ==== joins the same repository by itself. Do not edit by hand.
const CONFIG = {
  repoUrl: '',
  githubLogin: '',
  supportName: '',
  carriedToken: '',
};
const CONFIG_BLOCK = (c) => `const CONFIG = {\n  repoUrl: ${JSON.stringify(c.repoUrl || '')},\n  githubLogin: ${JSON.stringify(c.githubLogin || '')},\n  supportName: ${JSON.stringify(c.supportName || '')},\n  carriedToken: ${JSON.stringify(c.carriedToken || '')},\n};`;
const INSTALL_CMD = {
  winget: (id) => `winget install --id ${id} -e --accept-package-agreements --accept-source-agreements`,
  npm: (name) => `npm install -g ${name}`,
  pip: (name) => `py -3 -m pip install ${name}`,
};

// Claude Code application data that is machine-specific or disposable (see the "Application data"
// section of https://code.claude.com/docs/en/claude-directory). Plugins and MCP servers are
// reconciled through the Claude Code CLI instead of copied.
const SKIP_TOP = new Set([
  'plugins', 'sessions', 'file-history', 'plans', 'debug', 'paste-cache', 'image-cache', 'uploads',
  'session-env', 'tasks', 'shell-snapshots', 'backups', 'feedback-bundles', 'feedback', 'usage-data',
  'todos', 'statsig', 'logs', 'cache', 'telemetry', 'ide', 'chrome', 'jobs', 'daemon', 'downloads',
  'history.jsonl', 'stats-cache.json', 'remote-settings.json', 'policy-limits.json',
  'policy-limits.json.stamp.json', 'settings.local.json', 'mcp-needs-auth-cache.json', 'config.json',
  'claude_desktop_config.json',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.pytest_cache']);
const SKIP_FILE_RE = /(\.lock|\.tmp|\.swp|\.ccsync-tmp)$|^~\$|^(thumbs\.db|desktop\.ini|\.ds_store)$/i;

// ---------------------------------------------------------------------------------------------
// Small helpers

const now = () => Date.now();
const exists = (p) => fs.existsSync(p);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Some editors save JSON with a byte order mark, which JSON.parse refuses.
const parseJson = (text) => JSON.parse(text.replace(/^﻿/, ''));
const readJson = (p, fallback = null) => {
  try { return parseJson(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fileStamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const stableStringify = (v) => JSON.stringify(sortKeys(v), null, 2);

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function writeFileMk(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + TMP_SUFFIX;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i < 10) { sleep(100 * (i + 1)); continue; }
      // The target stays open without delete sharing: overwrite in place.
      try { fs.writeFileSync(file, data); } finally { fs.rmSync(tmp, { force: true }); }
      return;
    }
  }
}

function pruneEmptyDirs(dir, root) {
  while (isInside(dir, root) && path.relative(root, dir).split(path.sep).length >= 2) {
    try {
      if (fs.readdirSync(dir).length) return;
      fs.rmdirSync(dir);
    } catch { return; }
    dir = path.dirname(dir);
  }
}

const SECRETS = [];
function redact(text) {
  let s = String(text ?? '');
  for (const x of SECRETS) if (x) s = s.split(x).join('***');
  return s;
}

function log(msg) {
  try {
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    if (exists(LOG_FILE) && fs.statSync(LOG_FILE).size > 5e6) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${redact(msg)}\n`);
  } catch { /* logging never breaks a sync */ }
}

const loadState = () => readJson(STATE_FILE, null) || readJson(`${STATE_FILE}.bak`, null);
function saveState(state) {
  if (readJson(STATE_FILE, null)) fs.copyFileSync(STATE_FILE, `${STATE_FILE}.bak`);
  writeFileAtomic(STATE_FILE, JSON.stringify(state));
}
const lowerKeys = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase(), v]));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
  }
  return out;
}

function psRun(script, input) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { input, encoding: 'utf8', windowsHide: true, timeout: 120e3 });
}

// ---------------------------------------------------------------------------------------------
// Token: stored with Windows DPAPI (only this Windows user on this computer can read it).

function saveToken(token) {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  if (process.platform !== 'win32') {
    // ponytail: plain file outside Windows; add an OS keychain if non-Windows computers need this
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return;
  }
  const r = psRun('$t = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $t -AsPlainText -Force | ConvertFrom-SecureString', token);
  if (r.status !== 0 || !(r.stdout || '').trim()) throw new Error(`could not protect the token with Windows DPAPI: ${(r.stderr || r.stdout || r.error?.message || 'PowerShell did not answer').trim()}`);
  fs.writeFileSync(TOKEN_FILE, r.stdout.trim());
}

function loadToken() {
  if (!exists(TOKEN_FILE)) return null;
  const data = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (process.platform !== 'win32') return data;
  const r = psRun('$c = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString $c; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))', data);
  if (r.status !== 0 || !(r.stdout || '').trim()) throw new Error(`could not read the saved token: ${(r.stderr || r.error?.message || 'PowerShell did not answer').trim()}`);
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------------------------
// Git: never interactive. The token goes through GIT_CONFIG_* variables, so it never reaches the
// command line, the credential manager or the repository config.

let TOKEN;
// Loads the token once; it and its Basic form are redacted from logs, errors and every synced file.
function loadSecrets() {
  if (TOKEN === undefined) {
    TOKEN = loadToken() || '';
    if (TOKEN) SECRETS.push(TOKEN, Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
  }
  return TOKEN ? SECRETS[SECRETS.indexOf(TOKEN) + 1] : '';
}

function gitEnv(state, net) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C', LANGUAGE: 'C' };
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete env[k];
  const cfg = [
    ['credential.helper', ''],
    ['core.autocrlf', 'false'],
    ['core.safecrlf', 'false'],
    ['core.longpaths', 'true'],
    ['core.quotepath', 'false'],
    ['commit.gpgsign', 'false'],
    ['gc.auto', '0'],
    ['user.name', `claude-sync (${state.label})`],
    ['user.email', 'claude-sync@users.noreply.github.com'],
  ];
  if (net) {
    const basic = loadSecrets();
    if (basic) cfg.push([`http.${new URL(state.repoUrl).origin}/.extraheader`, `AUTHORIZATION: basic ${basic}`]);
  }
  env.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}

function git(state, args, { net = false, allowFail = false, encoding = 'utf8', env = {}, input } = {}) {
  let r;
  for (let attempt = 1; ; attempt++) {
    r = spawnSync(gitExe(state), args, {
      cwd: REPO_DIR, env: { ...gitEnv(state, net), ...env }, encoding, maxBuffer: 1 << 30, windowsHide: true, input,
      timeout: net ? 60 * 60e3 : 10 * 60e3,
    });
    // Brief network or server hiccups are retried on the spot instead of waiting for the next run.
    const transient = net && r.status !== 0 && /empty reply|could not resolve host|connection (reset|refused|timed out)|timed out|operation timed out|early eof|unexpected disconnect|RPC failed|HTTP 5\d\d|The requested URL returned error: 5\d\d|SSL_ERROR|schannel/i.test(String(r.stderr));
    if (!transient || attempt >= 3) break;
    log(`git ${args[0]}: network error, retrying (${attempt})`);
    sleep(5000 * attempt);
  }
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args[0]} failed: ${redact(String(r.stderr || r.stdout)).trim()}`);
  }
  return r;
}

// Creates the private repository when the address does not exist yet, using the access key given at
// install. Works for a repository owned by a person or by an organization.
function githubApi(repoUrl) {
  const url = new URL(repoUrl);
  const [owner, nameRaw] = url.pathname.split('/').filter(Boolean);
  const name = (nameRaw || '').replace(/\.git$/, '');
  if (!owner || !name) throw new Error(`address without owner and repository name: ${repoUrl}`);
  const api = url.origin === 'https://github.com' ? 'https://api.github.com' : `${url.origin}/api/v3`;
  const headers = {
    Authorization: `token ${loadToken()}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'claude-sync',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  return { api, owner, name, headers };
}

// Everything the person ever typed to Claude Code goes into this repository: a public one is refused.
async function assertPrivate(repoUrl) {
  if (!/^https:/i.test(repoUrl)) return;
  let info;
  try {
    const { api, owner, name, headers } = githubApi(repoUrl);
    const r = await fetch(`${api}/repos/${owner}/${name}`, { headers, signal: AbortSignal.timeout(30e3) });
    if (!r.ok) { log(`could not confirm that ${repoUrl} is private (HTTP ${r.status}); continuing`); return; }
    info = await r.json();
  } catch (e) {
    log(`could not confirm that ${repoUrl} is private (${e.message}); continuing`);
    return;
  }
  if (info.private === false) {
    throw new Error(`${repoUrl} is PUBLIC, so nothing was uploaded. Make it private on GitHub (repository Settings, General, Danger Zone, "Change repository visibility") and run this again`);
  }
}

// The GitHub account the access key belongs to. The owner in the address is often an organization,
// which nobody signs in with.
async function keyOwner(repoUrl) {
  if (!/^https:/i.test(repoUrl)) return '';
  try {
    const { api, headers } = githubApi(repoUrl);
    const r = await fetch(`${api}/user`, { headers, signal: AbortSignal.timeout(30e3) });
    return r.ok ? String((await r.json()).login || '') : '';
  } catch { return ''; }
}

async function createRemoteRepo(state, repoUrl) {
  const { api, owner, name, headers } = githubApi(repoUrl);
  const ownerInfo = await fetch(`${api}/users/${owner}`, { headers });
  const isOrg = ownerInfo.ok && (await ownerInfo.json()).type === 'Organization';
  const endpoint = isOrg ? `${api}/orgs/${owner}/repos` : `${api}/user/repos`;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: true, auto_init: false, description: 'Claude Code sync' }),
  });
  if (!r.ok) {
    throw new Error(`${repoUrl} does not exist, or this access key cannot see it, and the key is not allowed to create it (HTTP ${r.status}: ${redact(await r.text()).slice(0, 200)}). Create the repository as private in the browser, or give the key access to it, and run this again`);
  }
  log(`created private repository ${repoUrl}`);
  return true;
}

// Asks GitHub how big the repository really is. The copy kept here is shallow, so it cannot answer
// this, and the number is what decides when to offer the move to a fresh repository.
const repoKey = (url) => {
  try {
    const u = new URL(url);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase()}`;
  } catch { return String(url || '').toLowerCase(); }
};
const sameRepo = (a, b) => !!a && !!b && repoKey(a) === repoKey(b);
const ownerOf = (url) => {
  try { return `${new URL(url).host}/${new URL(url).pathname.split('/').filter(Boolean)[0] || ''}`.toLowerCase(); } catch { return ''; }
};

// The size lives in its own small file, written whole, so asking GitHub never competes with the sync
// over the state file. A number measured on another repository does not count for this one.
function readRepoSize(state) {
  const s = readJson(SIZE_FILE);
  return s && typeof s.mb === 'number' && sameRepo(s.url, state.repoUrl) ? s : null;
}

async function updateRepoSize(state, force) {
  const known = readRepoSize(state);
  if (!force && known && now() - known.at < SIZE_CHECK_MS) return known;
  if (!/^https:/i.test(state.repoUrl || '')) return known;
  try {
    const { api, owner, name, headers } = githubApi(state.repoUrl);
    const r = await fetch(`${api}/repos/${owner}/${name}`, { headers, signal: AbortSignal.timeout(30e3) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const info = await r.json();
    if (typeof info.size !== 'number') return known;
    const size = { url: state.repoUrl, mb: Math.round(info.size / 1024), private: info.private !== false, at: now() };
    writeFileAtomic(SIZE_FILE, JSON.stringify(size));
    log(`repository size: ${size.mb} MB${size.private ? '' : ', and it is PUBLIC'}`);
    return size;
  } catch (e) {
    // No network, no answer, or a key that cannot read it: try again later, never fail the sync.
    log(`could not read the repository size (${e.message})`);
    return known;
  }
}

// ---------------------------------------------------------------------------------------------
// Moving to a fresh repository. The retired repository keeps a note saying where the sync went, so
// the other computer follows on its own the next time it runs, without anyone touching it.

const moveNotePath = () => path.join(REPO_DIR, MOVE_FILE);

// Returns the note in the repository just fetched, or null. A note is only followed to a repository
// next to this one (same host, same owner): it can never send someone's conversations elsewhere.
function readMoveNote(state) {
  const note = readJson(moveNotePath());
  if (!note || typeof note.to !== 'string' || !note.to) return null;
  let to;
  try { to = new URL(note.to); } catch { return null; }
  if (to.protocol !== 'https:' || sameRepo(note.to, state.repoUrl)) return null;
  if (ownerOf(note.to) !== ownerOf(state.repoUrl)) return { ...note, refused: 'it belongs to another owner' };
  return note;
}

// The access key is sent per host, so a repository on the same host is reachable with what this
// computer already has. Checked before following a move, so a wrong address never strands anyone.
const remoteHeads = (state, url) => git(state, ['ls-remote', '--heads', url], { net: true, allowFail: true });

// Points this computer at another repository. Nothing local is touched, and what this computer agreed
// on is kept: items are identified by their content, not by the repository, so an edit made here while
// the other computer was moving still wins over the older copy the new repository holds.
function pointAt(state, url, { keepAfter } = {}) {
  const from = state.repoUrl;
  state.repoUrl = url;
  state.previousRepoUrl = from;
  if (typeof keepAfter === 'number') state.transcriptsAfter = keepAfter;
  delete state.uploadPending;
  delete state.rotateTarget;
  delete state.rotateSeed;
  delete state.moveBlocked;
  fs.rmSync(REPO_DIR, { recursive: true, force: true });
  try { writeConfig({ repoUrl: url }); } catch { /* the address is already in the state file */ }
  ensureRepo(state);
  log(`sync moved from ${from} to ${url}`);
}

function ensureRepo(state) {
  fs.mkdirSync(REPO_DIR, { recursive: true });
  if (!exists(path.join(REPO_DIR, '.git'))) git(state, ['init', '-q', '-b', BRANCH]);
  const current = git(state, ['remote', 'get-url', 'origin'], { allowFail: true }).stdout.trim();
  if (current !== state.repoUrl) git(state, ['remote', current ? 'set-url' : 'add', 'origin', state.repoUrl]);
}

// The local clone is a disposable cache: stale git locks are removed (this process holds the sync
// lock), and a copy git can no longer read is deleted and fetched again.
function repairRepo(state) {
  const gitDir = path.join(REPO_DIR, '.git');
  if (exists(gitDir)) {
    const walk = (dir) => {
      for (const n of fs.readdirSync(dir)) {
        if (n === 'objects') continue;
        const p = path.join(dir, n);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (n.endsWith('.lock')) { fs.rmSync(p, { force: true }); log(`removed stale git lock ${p}`); }
      }
    };
    try { walk(gitDir); } catch { /* checked below */ }
    if (git(state, ['status', '--porcelain', '-uno'], { allowFail: true }).status === 0) return;
    log('local copy of the repository is damaged; fetching it again');
  }
  fs.rmSync(REPO_DIR, { recursive: true, force: true });
}

function remoteTip(state) {
  const r = git(state, ['ls-remote', '--heads', 'origin', BRANCH], { net: true });
  const line = r.stdout.split('\n').find((l) => l.trim().endsWith(`refs/heads/${BRANCH}`));
  return line ? line.split(/\s+/)[0] : null;
}

function resetToRemote(state, tip) {
  if (tip) {
    const have = git(state, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${BRANCH}`], { allowFail: true }).stdout.trim();
    if (have !== tip) {
      git(state, ['fetch', '-q', '--depth=1', '--no-tags', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`], { net: true });
    }
    git(state, ['reset', '-q', '--hard', `refs/remotes/origin/${BRANCH}`]);
  } else {
    if (git(state, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }).status === 0) git(state, ['update-ref', '-d', 'HEAD']);
    git(state, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']);
  }
  git(state, ['clean', '-q', '-ffdx']);
}

// ---------------------------------------------------------------------------------------------
// Path translation. Content and project folder names store the Windows profile path as a token,
// so a computer whose user folder has another name reads its own path back.

const TOKENS = {
  json: '{{CLAUDE_SYNC_HOME_JSON}}', raw: '{{CLAUDE_SYNC_HOME}}',
  fwd: '{{CLAUDE_SYNC_HOME_FWD}}', posix: '{{CLAUDE_SYNC_HOME_POSIX}}',
};
const KEY_TOKEN = '{{HOME}}';
const TOKEN_PREFIX = '{{CLAUDE_SYNC_';
const TOKEN_ESCAPED = '{{CLAUDE_SYNC_ESC_';
const encodeKey = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const toLatin = (s) => Buffer.from(s, 'utf8').toString('latin1');
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function homeForms(home) {
  const fwd = home.replace(/\\/g, '/');
  const forms = { json: home.replace(/\\/g, '\\\\'), raw: home, fwd };
  if (/^[A-Za-z]:\//.test(fwd)) forms.posix = `/${fwd[0].toLowerCase()}${fwd.slice(2)}`;
  return forms;
}

function shortPathOf(p) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:CCS_TARGET).ShortPath',
  ], { encoding: 'utf8', windowsHide: true, timeout: 60e3, env: { ...process.env, CCS_TARGET: p } });
  const out = (r.stdout || '').trim();
  return r.status === 0 && out ? out : null;
}

let TRANSLATOR;
function translator(state) {
  if (TRANSLATOR) return TRANSLATOR;
  const homes = [HOME];
  if (state?.shortHome && state.shortHome.toLowerCase() !== HOME.toLowerCase()) homes.push(state.shortHome);
  // A home path only matches when the next character cannot continue a folder name.
  const boundary = '(?![A-Za-z0-9_ \\x80-\\xff-]|\\.[A-Za-z0-9])';
  const rules = [];
  for (const kind of ['json', 'raw', 'fwd', 'posix']) {
    for (const h of homes) {
      const form = homeForms(h)[kind];
      if (form) rules.push([new RegExp(reEscape(toLatin(form)) + boundary, 'gi'), TOKENS[kind]]);
    }
  }
  const canonical = homeForms(HOME);
  const keyHomes = homes.map((h) => encodeKey(h).toLowerCase());
  TRANSLATOR = {
    get fingerprint() {
      return `${homes.join('|')}|${crypto.createHash('sha1').update(SECRETS.join('|')).digest('hex').slice(0, 8)}`;
    },
    tokenize(buf) {
      if (buf.includes(0)) return buf;
      let s = buf.toString('latin1');
      let changed = false;
      // Literal token text is escaped first, so detokenize(tokenize(x)) always gives x back.
      if (s.includes(TOKEN_PREFIX)) { s = s.split(TOKEN_PREFIX).join(TOKEN_ESCAPED); changed = true; }
      for (const secret of SECRETS) {
        if (secret && s.includes(secret)) { s = s.split(secret).join('***'); changed = true; }
      }
      for (const [re, token] of rules) {
        const next = s.replace(re, token);
        if (next !== s) { s = next; changed = true; }
      }
      return changed ? Buffer.from(s, 'latin1') : buf;
    },
    detokenize(buf) {
      if (buf.includes(0) || !buf.includes(TOKEN_PREFIX)) return buf;
      let s = buf.toString('latin1');
      for (const kind of ['json', 'raw', 'fwd', 'posix']) {
        if (canonical[kind]) s = s.split(TOKENS[kind]).join(toLatin(canonical[kind]));
      }
      s = s.split(TOKEN_ESCAPED).join(TOKEN_PREFIX);
      return Buffer.from(s, 'latin1');
    },
    tokenizeKey(key) {
      // Names over 200 characters end in a hash of the full path; they are translated anyway so the
      // same item keeps the same name on every computer.
      const lower = key.toLowerCase();
      for (const kh of keyHomes) {
        if (lower.startsWith(kh) && (key.length === kh.length || key[kh.length] === '-')) return KEY_TOKEN + key.slice(kh.length);
      }
      return key;
    },
    detokenizeKey(key) {
      return key.startsWith(KEY_TOKEN) ? encodeKey(HOME) + key.slice(KEY_TOKEN.length) : key;
    },
  };
  return TRANSLATOR;
}

// ---------------------------------------------------------------------------------------------
// Content descriptors: the Git blob id of each part, so remote ids come straight from `git ls-tree`.

const gitBlobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

function splitParts(buf) {
  if (buf.length <= CHUNK_SIZE) return [buf];
  const parts = [];
  for (let i = 0; i < buf.length; i += CHUNK_SIZE) parts.push(buf.subarray(i, i + CHUNK_SIZE));
  return parts;
}
const describe = (buf) => splitParts(buf).map(gitBlobSha).join(',');

// ---------------------------------------------------------------------------------------------
// Local side

function sessionIdOf(logical) {
  const m = /^claude\/projects\/[^/]+\/([^/]+?)(?:\.jsonl$|\/)/.exec(logical);
  return m && m[1] !== 'memory' ? m[1] : null;
}

function topLevelAllowed(name) {
  const n = name.toLowerCase();
  if (n.startsWith('.') || SKIP_TOP.has(n)) return false;
  return !/cache|lock|te?mp\b|\.log$|backup|\.bak|\.old$|\.pid$/i.test(n);
}

function allowed(rel, isDir) {
  const name = rel[rel.length - 1];
  if (isDir ? SKIP_DIRS.has(name.toLowerCase()) : SKIP_FILE_RE.test(name)) return false;
  if (rel.length === 1) return name.toLowerCase() === 'projects' ? isDir : topLevelAllowed(name);
  if (rel[0].toLowerCase() !== 'projects') return true;
  if (rel.length === 2) return isDir;
  if (rel.length === 3) return isDir || (name.endsWith('.jsonl') && !name.includes('.orphaned-'));
  if (rel[2] === 'memory') return true;
  if (rel.length === 4) return isDir && (name === 'subagents' || name === 'tool-results');
  return true;
}

// When a conversation was last used, read from its own entries, so both computers reach the same answer:
// a conversation that arrived from the other computer is a new file here, with today's date on it.
function lastActivity(buf) {
  const mark = Buffer.from('"timestamp":"');
  let best = null;
  let at = buf.length;
  for (let found = 0; found < 5 && at > 0; found++) {
    at = buf.lastIndexOf(mark, at - 1);
    if (at < 0) break;
    const end = buf.indexOf(0x22, at + mark.length);
    if (end < 0 || end - at > 60) continue;
    const t = Date.parse(buf.toString('utf8', at + mark.length, end));
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

// A conversation is judged as a whole, by its main transcript, so the files that belong to an old one
// (subagents, tool results) stay behind with it.
function sessionActivity(entries) {
  const out = new Map();
  for (const e of entries.values()) {
    const m = /^claude\/projects\/[^/]+\/([^/]+)\.jsonl$/.exec(e.logical || '');
    if (m && e.activeAt) out.set(m[1].toLowerCase(), e.activeAt);
  }
  return out;
}

// Only the dates inside a conversation count; one with none is carried. File dates would not agree
// between the two computers.
function leftBehind(item, activity, keepAfter) {
  const sid = keepAfter ? sessionIdOf(item.logical || '') : null;
  if (!sid) return false;
  const at = activity.get(sid.toLowerCase()) ?? (item.transcript ? item.activeAt : null);
  return at !== null && at !== undefined && at < keepAfter;
}

function localFileContent(abs, tr, transcript) {
  let buf = fs.readFileSync(abs);
  // A transcript can be mid-write: only its complete lines are synced.
  if (transcript) buf = buf.subarray(0, buf.lastIndexOf(10) + 1);
  return tr.tokenize(buf);
}

function scanClaude(state, tr) {
  if (!exists(CLAUDE_DIR)) throw new Error(`Claude Code folder not found: ${CLAUDE_DIR}`);
  const entries = new Map();
  const cache = state.cache || {};
  const newCache = {};
  // Folders that could not be listed right now: what sync knows under them is left alone, never deleted.
  const blocked = [];
  const seen = new Set([fs.realpathSync.native(CLAUDE_DIR).toLowerCase()]);
  const walk = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) {
      if (!rel.length) throw new Error(`cannot list ${dir}: ${e.message}`);
      const parts = rel.slice();
      if (parts[0] === 'projects' && parts.length > 1) parts[1] = tr.tokenizeKey(parts[1]);
      blocked.push(`claude/${parts.join('/')}/`.toLowerCase());
      log(`cannot list ${dir} right now (${e.code || e.message}); its content is left as it was`);
      return;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      const childRel = rel.concat(name);
      let st;
      try { st = fs.statSync(abs); } catch (e) {
        // Gone between the listing and now, or a broken link: nothing to sync. Anything else (access
        // denied, busy, cloud placeholder) still exists and must not be read as a deletion.
        if (e.code === 'ENOENT') continue;
        const parts = childRel.slice();
        if (parts[0] === 'projects' && parts.length > 1) parts[1] = tr.tokenizeKey(parts[1]);
        const logical = `claude/${parts.join('/')}`;
        entries.set(logical.toLowerCase(), { kind: 'file', logical, abs, unreadable: true });
        blocked.push(`${logical}/`.toLowerCase());
        log(`cannot inspect ${abs} right now (${e.code || e.message}); it is left as it was`);
        continue;
      }
      const isDir = st.isDirectory();
      if (!allowed(childRel, isDir)) continue;
      if (isDir) {
        let real;
        try { real = fs.realpathSync.native(abs).toLowerCase(); } catch { real = abs.toLowerCase(); }
        if (seen.has(real)) continue;
        seen.add(real);
        walk(abs, childRel);
        continue;
      }
      if (!st.isFile()) continue;
      const parts = childRel.slice();
      if (parts[0] === 'projects') parts[1] = tr.tokenizeKey(parts[1]);
      const logical = `claude/${parts.join('/')}`;
      const transcript = !!sessionIdOf(logical) && name.endsWith('.jsonl');
      const c = cache[abs];
      let desc;
      let activeAt = null;
      if (c && c.s === st.size && c.m === st.mtimeMs && c.f === tr.fingerprint && (!transcript || c.t !== undefined)) {
        desc = c.d;
        activeAt = c.t;
      } else {
        try {
          const buf = localFileContent(abs, tr, transcript);
          desc = describe(buf);
          if (transcript) activeAt = lastActivity(buf);
        } catch (e) {
          // Held by another program right now (antivirus, editor, cloud folder): that is not a deletion.
          log(`cannot read ${abs} right now (${e.code || e.message}); it is left as it was`);
          entries.set(logical.toLowerCase(), { kind: 'file', logical, abs, transcript, mtimeMs: st.mtimeMs, size: st.size, unreadable: true });
          continue;
        }
      }
      newCache[abs] = { s: st.size, m: st.mtimeMs, f: tr.fingerprint, d: desc, ...(transcript ? { t: activeAt } : {}) };
      entries.set(logical.toLowerCase(), { kind: 'file', logical, abs, transcript, mtimeMs: st.mtimeMs, size: st.size, desc, activeAt });
    }
  };
  walk(CLAUDE_DIR, []);
  return { entries, cache: newCache, blocked };
}

const mcpPath = (name) => `mcp/${encodeURIComponent(name).replace(/\*/g, '%2A')}.json`;
const mcpName = (logical) => decodeURIComponent(logical.slice(4, -5));

function scanMcp(tr, base) {
  const baseHasMcp = Object.keys(base).some((p) => p.startsWith('mcp/'));
  let cfg;
  try { cfg = parseJson(fs.readFileSync(CLAUDE_JSON, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT' && !baseHasMcp) cfg = {};
    else return null; // being rewritten right now: leave MCP servers for the next run
  }
  // A config recreated with defaults has no mcpServers key at all: not a deliberate removal.
  if (cfg.mcpServers === undefined && baseHasMcp) return null;
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(CLAUDE_JSON).mtimeMs; } catch { /* no config yet */ }
  const entries = new Map();
  for (const [name, server] of Object.entries(cfg.mcpServers || {})) {
    const content = tr.tokenize(Buffer.from(stableStringify(server) + '\n'));
    const logical = mcpPath(name);
    entries.set(logical.toLowerCase(), { kind: 'mcp', logical, name, content, mtimeMs, desc: describe(content) });
  }
  return entries;
}

function activeSessionIds() {
  const ids = new Set();
  const dir = path.join(CLAUDE_DIR, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return ids; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const j = readJson(path.join(dir, n));
    if (j?.sessionId && j.pid && isAlive(j.pid)) ids.add(j.sessionId);
  }
  return ids;
}

let CLAUDE_BIN;
function claudeBin() {
  if (CLAUDE_BIN !== undefined) return CLAUDE_BIN;
  const candidates = [];
  if (process.env.CLAUDE_SYNC_CLAUDE_BIN) candidates.push(process.env.CLAUDE_SYNC_CLAUDE_BIN);
  // The editor extension comes first: it is the Claude Code the person actually runs, and it updates itself.
  const version = (n) => (n.match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const dir = path.join(HOME, editor, 'extensions');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    names.filter((n) => n.toLowerCase().startsWith('anthropic.claude-code-'))
      .sort((a, b) => { const x = version(a); const y = version(b); return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]); })
      .forEach((n) => candidates.push(path.join(dir, n, 'resources', 'native-binary', 'claude.exe')));
  }
  const where = spawnSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true });
  for (const found of where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []) {
    if (/\.exe$/i.test(found)) { candidates.push(found); continue; }
    // npm install: claude.cmd next to node_modules/@anthropic-ai/claude-code
    const pkg = path.join(path.dirname(found), 'node_modules', '@anthropic-ai', 'claude-code');
    candidates.push(path.join(pkg, 'bin', 'claude.exe'), path.join(pkg, 'cli.js'));
  }
  candidates.push(path.join(HOME, '.local', 'bin', 'claude.exe'));
  CLAUDE_BIN = candidates.find((c) => exists(c)) || null;
  return CLAUDE_BIN;
}

function runClaude(args) {
  const bin = claudeBin();
  if (!bin) throw new Error('Claude Code CLI not found');
  const [cmd, argv] = bin.endsWith('.js') ? [process.execPath, [bin, ...args]] : [bin, args];
  return spawnSync(cmd, argv, { encoding: 'utf8', windowsHide: true, timeout: 5 * 60e3, env: process.env });
}

function applyMcp(name, content, tr) {
  if (content === null) {
    const r = runClaude(['mcp', 'remove', name, '-s', 'user']);
    if (r.status !== 0 && !/not found|no mcp server/i.test(`${r.stdout}${r.stderr}`)) {
      throw new Error(`claude mcp remove ${name}: ${(r.stderr || r.stdout).trim()}`);
    }
    return;
  }
  const json = JSON.stringify(JSON.parse(tr.detokenize(content).toString('utf8')));
  runClaude(['mcp', 'remove', name, '-s', 'user']);
  const r = runClaude(['mcp', 'add-json', name, json, '-s', 'user']);
  if (r.status !== 0) throw new Error(`claude mcp add-json ${name}: ${(r.stderr || r.stdout).trim()}`);
}

const localAbsOf = (logical, tr) => {
  const parts = logical.slice('claude/'.length).split('/');
  if (parts[0] === 'projects' && parts.length > 1) parts[1] = tr.detokenizeKey(parts[1]);
  return path.join(CLAUDE_DIR, ...parts);
};
const localItemContent = (L, tr) => (L.kind === 'mcp' ? L.content : localFileContent(L.abs, tr, L.transcript));

// ---------------------------------------------------------------------------------------------
// Remote side (the working tree of the local clone, reset to the remote branch)

// Names git treats specially are stored with a suffix, so a synced .gitignore or .gitattributes never
// changes what git stores.
const GIT_SPECIAL = new Set(['.git', '.gitignore', '.gitattributes', '.gitmodules']);
const ESCAPED = '.ccsync-escaped';
const toRepoPath = (logical) => logical.split('/').map((s) => (GIT_SPECIAL.has(s.toLowerCase()) ? s + ESCAPED : s)).join('/');
const fromRepoPath = (file) => file.split('/').map((s) => (s.endsWith(ESCAPED) && GIT_SPECIAL.has(s.slice(0, -ESCAPED.length).toLowerCase()) ? s.slice(0, -ESCAPED.length) : s)).join('/');

// Groups blobs from `ls-tree -r -z` (mode type sha<TAB>path) or `ls-files -s -z` (mode sha stage<TAB>path)
// into logical items keyed in lower case.
function groupBlobs(output, format) {
  const out = new Map();
  for (const rec of output.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const fields = rec.slice(0, tab).split(' ');
    const sha = format === 'tree' ? fields[2] : fields[1];
    if (format === 'tree' && fields[1] !== 'blob') continue;
    const file = rec.slice(tab + 1);
    if (!(file.startsWith('claude/') || file.startsWith('mcp/'))) continue;
    const mark = file.lastIndexOf(PART_MARK);
    const logical = fromRepoPath(mark === -1 ? file : file.slice(0, mark));
    const index = mark === -1 ? -1 : Number(file.slice(mark + PART_MARK.length));
    const key = logical.toLowerCase();
    const e = out.get(key) || { logical, files: [] };
    e.files.push({ file, sha, index });
    out.set(key, e);
  }
  for (const e of out.values()) {
    e.files.sort((a, b) => a.index - b.index);
    e.desc = e.files.map((f) => f.sha).join(',');
  }
  return out;
}

function listRemote(state) {
  if (git(state, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }).status !== 0) return new Map();
  return groupBlobs(git(state, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { encoding: 'buffer' }).stdout, 'tree');
}

const listIndex = (state) => groupBlobs(git(state, ['ls-files', '-s', '-z'], { encoding: 'buffer' }).stdout, 'index');

const remoteContent = (R) => Buffer.concat(R.files.map((f) => fs.readFileSync(path.join(REPO_DIR, f.file))));

function removeRemote(R) {
  for (const f of R?.files || []) {
    const abs = path.join(REPO_DIR, f.file);
    fs.rmSync(abs, { force: true });
    pruneEmptyDirs(path.dirname(abs), REPO_DIR);
  }
}

function writeRemote(logical, buf, R) {
  removeRemote(R);
  const target = toRepoPath(R?.logical || logical); // an existing item keeps its spelling in the repository
  const parts = splitParts(buf);
  if (parts.length === 1) { writeFileMk(path.join(REPO_DIR, target), buf); return; }
  parts.forEach((part, i) => writeFileMk(path.join(REPO_DIR, target + PART_MARK + String(i).padStart(4, '0')), part));
}

// ---------------------------------------------------------------------------------------------
// Three-way reconciliation per item: local (L), remote (R) and base (the agreed state after the
// last successful sync of this computer).

// Keeps every line of both sides. A line only this computer has goes right after the line that precedes
// it here, so it stays inside its section instead of landing at the end of the file.
function unionLines(remoteBuf, localBuf) {
  const norm = (s) => s.trimEnd();
  const out = remoteBuf.toString('utf8').split('\n');
  if (out[out.length - 1] === '') out.pop();
  const have = new Set(out.map(norm));
  let pos = -1;
  let added = false;
  for (const line of localBuf.toString('utf8').split('\n')) {
    const key = norm(line);
    if (!key.trim()) continue;
    if (have.has(key)) {
      let at = out.findIndex((x, i) => i > pos && norm(x) === key);
      if (at === -1) at = out.findIndex((x) => norm(x) === key);
      if (at !== -1) pos = at;
      continue;
    }
    out.splice(pos + 1, 0, line);
    have.add(key);
    pos++;
    added = true;
  }
  return added ? Buffer.from(`${out.join('\n')}\n`) : remoteBuf;
}

function saveConflict(ctx, logical, buf, who) {
  const abs = path.join(CONFLICTS_DIR, ctx.stamp, who, ...logical.split('/').map((s) => s.replace(/[{}]/g, '_')));
  writeFileMk(abs, ctx.tr.detokenize(buf));
  log(`conflict on ${logical}: kept one version, the other is in ${abs}`);
  if (!ctx.joining) ctx.changes.push({ p: logical, a: 'conflict' });
}

function resolveConflict(ctx, key, p, L, R) {
  if (!L) return 'remote';
  if (!R) return 'local';
  const sid = sessionIdOf(p);
  if (sid) {
    if (ctx.active.has(sid)) return 'defer';
    const lc = localItemContent(L, ctx.tr);
    const rc = remoteContent(R);
    if (rc.length >= lc.length && rc.subarray(0, lc.length).equals(lc)) return 'remote';
    if (lc.length > rc.length && lc.subarray(0, rc.length).equals(rc)) return 'local';
    const win = lc.length > rc.length ? 'local' : 'remote';
    saveConflict(ctx, p, win === 'local' ? rc : lc, win === 'local' ? 'from-other-computer' : 'from-this-computer');
    return win;
  }
  if (path.posix.basename(p) === 'MEMORY.md') return { merged: unionLines(remoteContent(R), localItemContent(L, ctx.tr)) };
  const remoteMs = ctx.meta[key] ?? ctx.remoteTime();
  const win = ctx.joining ? 'remote' : (L.mtimeMs >= remoteMs ? 'local' : 'remote');
  const loser = win === 'local' ? remoteContent(R) : localItemContent(L, ctx.tr);
  saveConflict(ctx, p, loser, win === 'local' ? 'from-other-computer' : 'from-this-computer');
  return win;
}

function writeLocalItem(ctx, key, p, buf, L) {
  if (key.startsWith('mcp/')) {
    applyMcp(mcpName(p), buf, ctx.tr);
    ctx.state.mcpApplied ||= {};
    ctx.state.mcpApplied[key] = { d: describe(buf), at: now() };
    return;
  }
  const abs = L?.abs || localAbsOf(p, ctx.tr);
  writeFileAtomic(abs, ctx.tr.detokenize(buf));
  const st = fs.statSync(abs);
  ctx.cache[abs] = { s: st.size, m: st.mtimeMs, f: ctx.tr.fingerprint, d: describe(buf) };
}

function throughLink(abs) {
  for (let dir = path.dirname(abs); isInside(dir, CLAUDE_DIR); dir = path.dirname(dir)) {
    try { if (fs.lstatSync(dir).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
}

function deleteLocalItem(ctx, key, p, L) {
  if (key.startsWith('mcp/')) { applyMcp(mcpName(p), null, ctx.tr); return; }
  const abs = L?.abs || localAbsOf(p, ctx.tr);
  // A linked folder points outside Claude Code; its files are never deleted by sync.
  if (throughLink(abs)) throw new Error('removed on another computer, but here it lives in a linked folder that sync does not delete');
  fs.rmSync(abs, { force: true });
  delete ctx.cache[abs];
  pruneEmptyDirs(path.dirname(abs), CLAUDE_DIR);
}

// Keys are lower-case logical paths (Windows paths ignore case); L.logical and R.logical keep the spelling.
function reconcile(ctx, local, remote, base) {
  const newBase = {};
  const keep = (key, d) => { if (d !== undefined) newBase[key] = d; };
  const recentlyApplied = (key, b) => {
    const x = ctx.state.mcpApplied?.[key];
    return !!x && x.d === b && now() - x.at < MCP_REAPPLY_MS;
  };
  // Small things first (memory, skills, settings), then conversations from the most recent to the oldest,
  // so a large history uploaded in several runs delivers what matters before the archive.
  const keys = [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)])];
  const rank = (key) => {
    const item = local.get(key);
    return sessionIdOf(item?.logical || key) ? [1, -(item?.mtimeMs || 0)] : [0, 0];
  };
  const ranks = new Map(keys.map((key) => [key, rank(key)]));
  keys.sort((x, y) => (ranks.get(x)[0] - ranks.get(y)[0]) || (ranks.get(x)[1] - ranks.get(y)[1]));
  for (const key of keys) {
    const L = local.get(key);
    const R = remote.get(key);
    const b = base[key];
    const l = L?.desc;
    const r = R?.desc;
    const p = L?.logical || R?.logical || key;
    if (key.startsWith('mcp/') && ctx.mcpUnavailable) { keep(key, b); continue; }
    // After a move to a fresh repository, conversations older than the cut are left alone: they stay
    // on both computers and in the retired repository, and simply do not travel any more. One that is
    // reopened and continued gets a new date, so it starts being carried again.
    if (ctx.keepAfter && !R && L && leftBehind(L, ctx.activity, ctx.keepAfter)) { keep(key, b); continue; }
    // Could not be read this time: it keeps its agreed state, and is looked at again on the next run.
    if (L?.unreadable || (!L && ctx.blocked.some((prefix) => key.startsWith(prefix)))) { keep(key, b); continue; }
    if (l === r) { keep(key, l); continue; }
    const sid = sessionIdOf(p);
    try {
      let action;
      if (l === b) action = 'remote';
      else if (r === b) action = 'local';
      else action = resolveConflict(ctx, key, p, L, R);

      if (action === 'defer') { keep(key, b); continue; }
      if (action.merged) {
        writeLocalItem(ctx, key, p, action.merged, L);
        writeRemote(p, action.merged, R);
        ctx.meta[key] = now();
        keep(key, describe(action.merged));
        ctx.changes.push({ p, a: 'updated' });
        continue;
      }
      if (action === 'remote') {
        if (!R) {
          if (sid) { keep(key, l); continue; } // transcripts are never deleted by sync
          deleteLocalItem(ctx, key, p, L);
          ctx.pulled[key] = null;
          ctx.changes.push({ p, a: 'removed' });
          continue;
        }
        if (sid && ctx.active.has(sid)) { keep(key, b); continue; } // open in Claude Code right now
        writeLocalItem(ctx, key, p, remoteContent(R), L);
        ctx.pulled[key] = r;
        ctx.changes.push({ p, a: L ? 'updated' : 'added' });
        keep(key, r);
        continue;
      }
      // action === 'local'
      if (!L) {
        if (sid) { keep(key, r); continue; }
        if (key.startsWith('mcp/') && recentlyApplied(key, b)) {
          // Claude Code rewrote its config over a server this sync had just added: apply it again.
          writeLocalItem(ctx, key, p, remoteContent(R), L);
          keep(key, r);
          continue;
        }
        removeRemote(R);
        delete ctx.meta[key];
        continue;
      }
      const bytes = L.kind === 'mcp' ? L.content.length : (L.size || 0);
      if (ctx.uploadBytes > 0 && ctx.uploadBytes + bytes > ctx.uploadBudget) { ctx.deferred++; keep(key, b); continue; }
      ctx.uploadBytes += bytes;
      writeRemote(p, localItemContent(L, ctx.tr), R);
      ctx.uploads[key] = { desc: l, base: b };
      if (!sid) ctx.meta[key] = L.mtimeMs;
      keep(key, l);
    } catch (e) {
      log(`could not apply ${p}: ${e.message}`);
      ctx.failures[key] = { p, msg: e.message };
      keep(key, b);
    }
  }
  for (const [key, x] of Object.entries(ctx.state.mcpApplied || {})) {
    if (local.get(key)?.desc === x.d || now() - x.at > MCP_REAPPLY_MS) delete ctx.state.mcpApplied[key];
  }
  return newBase;
}

function massDeletionGuard(base, local, remote, force) {
  if (force) return;
  const tracked = Object.keys(base).filter((p) => p.startsWith('claude/') && !sessionIdOf(p));
  // Everything that was agreed is gone on one side: never a real edit, whatever the count.
  if (tracked.length && tracked.every((p) => !remote.has(p))) {
    throw new Error('safety stop: the repository no longer holds any of the synced files; nothing was changed here');
  }
  if (tracked.length && tracked.every((p) => !local.has(p))) {
    throw new Error('safety stop: none of the synced files can be found on this computer; nothing was changed');
  }
  if (tracked.length < 6) return;
  const goneLocal = tracked.filter((p) => !local.has(p)).length;
  const goneRemote = tracked.filter((p) => !remote.has(p)).length;
  if (goneLocal > tracked.length / 2) {
    throw new Error(`safety stop: ${goneLocal} of ${tracked.length} synced files are missing on this computer; nothing was changed (run "sync --force" if the removal is intended)`);
  }
  if (goneRemote > tracked.length / 2) {
    throw new Error(`safety stop: ${goneRemote} of ${tracked.length} synced files are missing in the repository; nothing was changed (run "sync --force" if the removal is intended)`);
  }
}

// ---------------------------------------------------------------------------------------------
// Programs installed after setup

function scanPrograms() {
  if (process.env.CLAUDE_SYNC_FAKE_PROGRAMS) return readJson(process.env.CLAUDE_SYNC_FAKE_PROGRAMS, {});
  const out = { winget: null, npm: null, pip: null };
  const tmp = path.join(SYNC_DIR, 'winget-export.json');
  spawnSync('winget', ['export', '-o', tmp, '--accept-source-agreements', '--disable-interactivity'], { windowsHide: true, timeout: 5 * 60e3, stdio: 'ignore' });
  const exported = readJson(tmp);
  fs.rmSync(tmp, { force: true });
  if (exported) out.winget = [...new Set((exported.Sources || []).flatMap((s) => (s.Packages || []).map((p) => p.PackageIdentifier)))].sort();
  const npm = spawnSync('cmd.exe', ['/d', '/c', 'npm ls -g --depth=0 --json'], { encoding: 'utf8', windowsHide: true, timeout: 2 * 60e3, maxBuffer: 64 << 20 });
  try { out.npm = Object.keys(JSON.parse(npm.stdout).dependencies || {}).sort(); } catch { /* npm not available */ }
  for (const cmd of [['py', '-3'], ['python']]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), '-m', 'pip', 'list', '--not-required', '--format=json', '--disable-pip-version-check'], { encoding: 'utf8', windowsHide: true, timeout: 2 * 60e3 });
    try { out.pip = JSON.parse(r.stdout).map((x) => x.name.toLowerCase()).sort(); break; } catch { /* try the next interpreter */ }
  }
  return out;
}

function updatePrograms(state) {
  const programs = (state.programs ||= {});
  const current = scanPrograms();
  programs.scannedAt = now();
  programs.baseline ||= {};
  programs.current ||= {};
  for (const m of MANAGERS) {
    if (!Array.isArray(current[m])) continue; // manager unavailable right now: keep the last known list
    if (!Array.isArray(programs.baseline[m])) programs.baseline[m] = current[m];
    programs.current[m] = current[m];
  }
}

function programAdditions(state) {
  const out = {};
  for (const m of MANAGERS) {
    const baseline = new Set(state.programs?.baseline?.[m] || []);
    out[m] = (state.programs?.current?.[m] || []).filter((x) => !baseline.has(x));
  }
  return out;
}

function pendingPrograms(state) {
  const current = state.programs?.current || {};
  const seen = new Set();
  const out = [];
  for (const other of Object.values(state.otherPrograms || {})) {
    for (const m of MANAGERS) {
      if (!Array.isArray(current[m])) continue;
      const have = new Set(current[m]);
      for (const x of other.additions?.[m] || []) {
        const key = `${m}:${x}`;
        if (have.has(x) || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, m, x, label: other.label });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Plugins: settings.json (synced) declares marketplaces and enabled plugins; install what is missing.

function marketplaceArg(src) {
  if (!src) return null;
  if (src.source === 'github' && src.repo) return src.repo;
  return src.url || src.path || null;
}

function reconcilePlugins(state, changes) {
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json'), {}) || {};
  const enabled = settings.enabledPlugins || {};
  const installed = readJson(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), {})?.plugins || {};
  const missing = Object.keys(enabled).filter((id) => id.includes('@') && !id.endsWith('@skills-dir') && !installed[id]);
  if (!missing.length) return false;
  if (!claudeBin()) { log(`plugins pending (${missing.join(', ')}) but the Claude Code CLI was not found`); return false; }
  const known = readJson(path.join(CLAUDE_DIR, 'plugins', 'known_marketplaces.json'), {}) || {};
  state.pluginAttempts ||= {};
  let changed = false;
  for (const id of missing) {
    const attempt = state.pluginAttempts[id];
    if (attempt && attempt.n >= 3 && now() - attempt.at < 6 * 3600e3) continue;
    const market = id.slice(id.lastIndexOf('@') + 1);
    const arg = marketplaceArg(settings.extraKnownMarketplaces?.[market]?.source);
    if (!known[market] && arg) {
      const add = runClaude(['plugin', 'marketplace', 'add', arg, '--scope', 'user']);
      log(`plugin marketplace add ${arg}: exit ${add.status}`);
    }
    let r = runClaude(['plugin', 'install', id, '--scope', 'user', '--json', '-y']);
    // An older Claude Code does not know these options: the plain form installs just the same.
    if (r.status !== 0 && /unknown option|unknown argument|error: unknown/i.test(`${r.stdout}${r.stderr}`)) {
      r = runClaude(['plugin', 'install', id, '--scope', 'user']);
    }
    if (r.status === 0) {
      if (enabled[id] === false) runClaude(['plugin', 'disable', id, '--scope', 'user']);
      delete state.pluginAttempts[id];
      changes.push({ plugin: id });
      changed = true;
      log(`plugin installed: ${id}`);
    } else {
      state.pluginAttempts[id] = { n: (attempt?.n || 0) + 1, at: now() };
      log(`plugin install ${id} failed: ${(r.stderr || r.stdout || '').trim()}`);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Notices shown to Claude at the start of the next session

function summarize(changes) {
  const lines = [];
  const skills = new Map();
  const memories = { added: 0, updated: 0, removed: 0 };
  const sessions = new Set();
  let other = 0;
  const named = { agents: 'subagent', commands: 'command', 'output-styles': 'output style', workflows: 'workflow', themes: 'theme' };
  for (const c of changes) {
    if (c.moved) { lines.push('the storage that carries the sync was renewed on the other computer, and this computer followed it by itself; nothing was lost'); continue; }
    if (c.plugin) { lines.push(`plugin "${c.plugin}" installed`); continue; }
    if (c.p.startsWith('mcp/')) { lines.push(`MCP server "${mcpName(c.p)}" ${c.a}`); continue; }
    const rel = c.p.slice('claude/'.length).split('/');
    if (sessionIdOf(c.p)) { sessions.add(sessionIdOf(c.p)); continue; }
    if (rel[0] === 'projects' && rel[2] === 'memory') { if (rel[rel.length - 1] !== 'MEMORY.md') memories[c.a]++; continue; }
    if (rel[0] === 'skills' && rel.length > 2) {
      const s = skills.get(rel[1]) || 'updated';
      skills.set(rel[1], rel.length === 3 && rel[2] === 'SKILL.md' && c.a !== 'updated' ? c.a : s);
      continue;
    }
    if (rel.length === 1 && rel[0] === 'CLAUDE.md') { lines.push(`global instructions (CLAUDE.md) ${c.a}`); continue; }
    if (rel.length === 1 && rel[0] === 'settings.json') { lines.push(`Claude Code settings ${c.a}`); continue; }
    if (rel.length === 1 && rel[0] === 'keybindings.json') { lines.push(`keyboard shortcuts ${c.a}`); continue; }
    if (named[rel[0]] && rel.length === 2) { lines.push(`${named[rel[0]]} "${rel[1].replace(/\.[^.]+$/, '')}" ${c.a}`); continue; }
    if (rel[0] === 'rules') { lines.push('rules updated'); continue; }
    other++;
  }
  for (const [name, a] of skills) lines.push(`skill "${name}" ${a}`);
  for (const a of ['added', 'updated', 'removed']) if (memories[a]) lines.push(`${memories[a]} ${memories[a] === 1 ? 'memory' : 'memories'} ${a}`);
  if (sessions.size) lines.push(`${sessions.size} ${sessions.size === 1 ? 'conversation' : 'conversations'} brought over (can be continued here from the session history)`);
  if (other) lines.push(`${other} other Claude Code ${other === 1 ? 'file' : 'files'} updated`);
  return [...new Set(lines)];
}

function addNotice(state, lines) {
  if (!lines.length) return;
  fs.mkdirSync(NOTICES_DIR, { recursive: true });
  const labels = Object.values(state.otherLabels || {});
  const notice = { at: now(), from: labels.join(' / '), lines };
  fs.writeFileSync(path.join(NOTICES_DIR, `${now()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.json`), JSON.stringify(notice));
}

function sessionStartText(state, consume) {
  const out = [];
  const files = exists(NOTICES_DIR) ? fs.readdirSync(NOTICES_DIR).filter((n) => n.endsWith('.json')).sort() : [];
  const notices = files.map((n) => readJson(path.join(NOTICES_DIR, n))).filter(Boolean);
  const allLines = [...new Set(notices.flatMap((n) => n.lines || []))];
  const lines = allLines.slice(0, MAX_NOTICE_LINES);
  if (allLines.length > lines.length) lines.push(`and ${allLines.length - lines.length} other change(s)`);
  if (lines.length) {
    const from = [...new Set(notices.map((n) => n.from).filter(Boolean))].join(' / ') || 'another computer';
    out.push(`[claude-sync] Since the last session these changes arrived from the user's other computer (${from}) and are already applied here:`);
    out.push(...lines.map((l) => `- ${l}`));
  }
  const notified = readJson(NOTIFIED_FILE, {}) || {};
  const pending = pendingPrograms(state).filter((x) => !notified[x.key] || now() - notified[x.key] > NOTIFY_AGAIN_MS);
  if (pending.length) {
    out.push("[claude-sync] Programs installed on the user's other computer that are missing on this one:");
    out.push(...pending.map((x) => `- ${x.x} (installed on ${x.label}): ${INSTALL_CMD[x.m](x.x)}`));
  }
  // GitHub asks repositories to stay under 1 GB. Well before that, the user is asked once whether the
  // sync can move to a fresh repository, and only their answer starts it.
  const size = readRepoSize(state);
  const offer = readOffer();
  const full = !!size && size.mb >= ROTATE_SUGGEST_MB;
  const due = now() - (offer.offeredAt || 0) > ROTATE_OFFER_AGAIN_MS;
  // A move that already failed on this repository is not offered again: it would fail the same way.
  const failedHere = !!offer.failedAt && sameRepo(offer.failedFor, state.repoUrl);
  // A computer that cannot follow a move already made is told about that instead; offering another
  // move there would split the two computers.
  const offerMove = full && due && !failedHere && !state.moveBlocked && now() > (offer.laterUntil || 0);
  const moveFailed = full && due && failedHere && !state.moveBlocked;
  if (offerMove) {
    out.push(`[claude-sync] The repository that carries the sync between the user's computers is at ${size.mb} MB. GitHub asks repositories to stay under about 1 GB, so it is time to move the sync to a fresh one.`);
  }
  if (moveFailed) {
    out.push(`[claude-sync] WARNING: the repository that carries the sync is at ${size.mb} MB and moving it to a fresh one did not work (${offer.failure || 'unknown reason'}).`);
  }
  const exposed = !!size && size.private === false;
  if (exposed) {
    out.push(`[claude-sync] WARNING: the repository that carries the sync (${state.repoUrl}) is PUBLIC on GitHub, so anyone can read the user's conversations and memory.`);
  }
  if (state.moveBlocked) {
    out.push(`[claude-sync] WARNING: the sync moved to a new repository (${state.moveBlocked.to}) on the user's other computer, but this computer did not follow it (${state.moveBlocked.why || 'it cannot reach it'}), so the two computers are no longer syncing with each other.`);
  }
  const stale = !state.lastSuccessAt || now() - state.lastSuccessAt > FAILURE_WARN_MS;
  // One failure means nothing (the network is often not up yet when the computer starts). Several in a
  // row, with nothing working for hours, is a real problem worth telling the user about.
  const syncFailing = stale && (state.failStreak || 0) >= 3;
  if (syncFailing) {
    const since = state.lastSuccessAt ? `since ${fmtDate(state.lastSuccessAt)}` : 'since it was set up';
    // No error recorded and nothing ran in hours: the sync is not being started at all.
    const why = state.lastError ? `Last error: ${state.lastError}`
      : `No error was recorded, so it is not being started (last attempt: ${state.lastAttemptAt ? fmtDate(state.lastAttemptAt) : 'never'}).`;
    out.push(`[claude-sync] WARNING: the automatic sync between the user's computers has not worked ${since}. ${why}`);
  }
  const stuck = [
    ...brokenHookWarnings(),
    ...Object.values(state.itemFailures || {}).filter((f) => now() - f.since > FAILURE_WARN_MS).map((f) => `${f.p}: ${f.msg}`),
    ...Object.entries(state.pluginAttempts || {}).filter(([, a]) => a.n >= 3).map(([id]) => `plugin ${id}: could not be installed`),
  ];
  if (stuck.length) {
    out.push("[claude-sync] WARNING: some items from the user's other computer could not be applied here:");
    out.push(...stuck.slice(0, 10).map((s) => `- ${s}`));
  }
  const failing = syncFailing || stuck.length > 0;
  if (!out.length) return '';
  out.push('', 'Instructions for Claude:');
  if (lines.length) {
    out.push("- In your first reply, before anything else, tell the user in one or two short, plain sentences, in the user's language, what came from the other computer. No file paths and no technical terms. If a plugin or MCP server arrived, tell them it starts working after they close and reopen VS Code.");
  }
  if (pending.length) {
    out.push('- Tell the user you will install these programs so this computer matches the other one, then run each command and report the result in plain words.');
  }
  if (offerMove) {
    out.push(
      '- Tell the user, in one or two plain sentences in their language, that the storage their sync uses is getting full, that you can move it to a new one in a few minutes, and that nothing is lost: every conversation, memory and skill stays on both computers. Then ask whether you can go ahead.',
      `- If they say yes, run \`"${TOOL_LAUNCHER}" rotate --yes\` (in PowerShell, with & in front; never with "cmd /c"), wait for it to finish, and tell them in one sentence that it is done and that their other computer moves by itself. It takes a few minutes and prints its progress.`,
      `- If they say no or not now, run \`"${TOOL_LAUNCHER}" rotate --later\` so they are not asked again for a month.`,
    );
  }
  if (moveFailed) {
    out.push(`- Tell the user plainly that the storage their sync uses is almost full and that they should contact ${state.support || 'the person who set it up'} to renew it. Do not try to fix it yourself.`);
  }
  if (exposed) {
    out.push(`- Tell the user plainly that the storage holding their conversations is open to the public and that they should contact ${state.support || 'the person who set it up'} today to make it private.`);
  }
  if (state.moveBlocked) {
    out.push(`- Tell the user plainly that their two computers are no longer syncing with each other because this one cannot reach the new storage, and that they should contact ${state.support || 'the person who set it up'}.`);
  }
  if (failing) {
    out.push(`- Tell the user plainly that the automatic sync between their computers is not fully working and that they should contact ${state.support || 'the person who set it up'}. Do not try to repair it unless the user asks.`);
  }
  if (consume) {
    if (offerMove || moveFailed) writeOffer({ offeredAt: now(), offeredFor: state.repoUrl });
    for (const n of files) fs.rmSync(path.join(NOTICES_DIR, n), { force: true });
    for (const x of pending) notified[x.key] = now();
    if (pending.length) writeFileAtomic(NOTIFIED_FILE, JSON.stringify(notified));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Repository files owned by each computer: status, programs and the tool itself

function toolVersionOf(file) {
  try { return Number(/^const VERSION = (\d+);$/m.exec(fs.readFileSync(file, 'utf8'))[1]); } catch { return 0; }
}

// The copy kept in the repository is the plain tool: no address and, above all, no access key.
const withoutConfig = (text) => text.replace(/const CONFIG = \{[\s\S]*?\n\};/, CONFIG_BLOCK({}));

function syncToolFile() {
  const repoTool = path.join(REPO_DIR, 'tool', 'claude-sync.mjs');
  const repoVersion = toolVersionOf(repoTool);
  if (repoVersion > VERSION) {
    if (toolVersionOf(INSTALLED_SCRIPT) < repoVersion) {
      // Keeps this computer's own address and key, takes only the new code.
      const current = exists(INSTALLED_SCRIPT) ? fs.readFileSync(INSTALLED_SCRIPT, 'utf8') : '';
      const config = /const CONFIG = \{[\s\S]*?\n\};/.exec(current);
      let next = fs.readFileSync(repoTool, 'utf8');
      if (config) next = next.replace(/const CONFIG = \{[\s\S]*?\n\};/, () => config[0]);
      writeFileAtomic(INSTALLED_SCRIPT, Buffer.from(next, 'utf8'));
      log(`updated claude-sync to version ${repoVersion} (takes effect on the next run)`);
    }
  } else if (repoVersion < VERSION) {
    writeFileMk(repoTool, Buffer.from(withoutConfig(fs.readFileSync(SCRIPT, 'utf8')), 'utf8'));
  }
}

function writeOwnRepoFiles(state) {
  const gitattributes = path.join(REPO_DIR, '.gitattributes');
  if (!exists(gitattributes)) writeFileMk(gitattributes, '* -text\n');

  const statusFile = path.join(REPO_DIR, 'status', `${state.machineId}.json`);
  const status = readJson(statusFile);
  if (!status || status.label !== state.label || status.version !== VERSION || now() - Date.parse(status.updatedAt) > STATUS_EVERY_MS) {
    writeFileMk(statusFile, `${stableStringify({ label: state.label, hostname: os.hostname(), version: VERSION, updatedAt: new Date().toISOString() })}\n`);
  }

  const programsFile = path.join(REPO_DIR, 'programs', `${state.machineId}.json`);
  const programs = `${stableStringify({ label: state.label, additions: programAdditions(state) })}\n`;
  if (!exists(programsFile) || fs.readFileSync(programsFile, 'utf8') !== programs) writeFileMk(programsFile, programs);

  state.otherLabels = {};
  state.otherPrograms = {};
  for (const [dir, target] of [['status', state.otherLabels], ['programs', state.otherPrograms]]) {
    let names = [];
    try { names = fs.readdirSync(path.join(REPO_DIR, dir)); } catch { continue; }
    for (const n of names) {
      const id = n.replace(/\.json$/, '');
      if (id === state.machineId) continue;
      const j = readJson(path.join(REPO_DIR, dir, n));
      if (j) target[id] = dir === 'status' ? j.label : j;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Sync

function syncOnce(state, tr, opts, changes) {
  // An empty repository (new, or its branch deleted) is seeded again; nothing local is deleted.
  const base = opts.remoteEmpty ? {} : state.base || {};
  const scanned = scanClaude(state, tr);
  const mcp = scanMcp(tr, base);
  const local = new Map(scanned.entries);
  if (mcp) for (const [k, v] of mcp) local.set(k, v);
  const remote = listRemote(state);
  massDeletionGuard(base, local, remote, opts.force);
  const baseMcpCount = Object.keys(base).filter((p) => p.startsWith('mcp/')).length;
  let tipMs;
  const metaFile = path.join(REPO_DIR, 'meta', 'mtimes.json');
  const metaBefore = exists(metaFile) ? fs.readFileSync(metaFile, 'utf8') : '';
  const ctx = {
    state, tr, changes, cache: scanned.cache, stamp: fileStamp(),
    meta: lowerKeys(readJson(metaFile, {})), // when each item was last modified on the computer that uploaded it
    pulled: {}, // items this computer took from the repository: agreed even if the push fails
    uploads: {},
    failures: {},
    blocked: scanned.blocked,
    uploadBytes: 0,
    uploadBudget: opts.uploadBudget || UPLOAD_BUDGET,
    deferred: 0, // uploads left for the next batch
    active: activeSessionIds(),
    joining: !state.baseInitialized && !opts.remoteEmpty,
    keepAfter: state.transcriptsAfter || 0,
    activity: state.transcriptsAfter ? sessionActivity(local) : new Map(),
    mcpUnavailable: !mcp || (!opts.force && baseMcpCount >= 2 && mcp.size === 0),
    remoteTime: () => (tipMs ??= Number(git(state, ['log', '-1', '--format=%ct', 'HEAD'], { allowFail: true }).stdout.trim() || 0) * 1000),
  };
  if (ctx.mcpUnavailable) {
    log('MCP servers skipped this run (config unreadable or unexpectedly empty)');
    ctx.failures['mcp/'] = { p: 'MCP servers', msg: "the Claude Code configuration could not be read, so MCP servers were not synced" };
  }
  const newBase = reconcile(ctx, local, remote, base);
  for (const p of Object.keys(ctx.meta)) if (!newBase[p]) delete ctx.meta[p];
  const metaAfter = `${stableStringify(ctx.meta)}\n`;
  if (metaAfter !== metaBefore && (metaBefore || Object.keys(ctx.meta).length)) writeFileMk(metaFile, metaAfter);
  const previousFailures = state.itemFailures || {};
  state.itemFailures = Object.fromEntries(Object.entries(ctx.failures).map(([k, f]) => [k, { ...f, since: previousFailures[k]?.since || now() }]));
  writeOwnRepoFiles(state);
  return { newBase, cache: ctx.cache, pulled: ctx.pulled, uploads: ctx.uploads, deferred: ctx.deferred };
}

// A profile copied to another PC keeps its old identity: start over as a new computer joining.
function checkIdentity(state) {
  const host = os.hostname();
  if (!state.hostname) { state.hostname = host; return; }
  if (state.hostname === host) return;
  log(`computer name changed from ${state.hostname} to ${host}: joining as a new computer`);
  for (const k of ['base', 'baseInitialized', 'cache', 'mcpApplied', 'otherLabels', 'otherPrograms', 'pluginAttempts', 'itemFailures', 'programs']) delete state[k];
  state.machineId = crypto.randomUUID();
  state.hostname = host;
  fs.rmSync(REPO_DIR, { recursive: true, force: true });
}

function runSync(opts = {}) {
  const state = loadState();
  if (!state) throw new Error('claude-sync is not installed on this computer');
  if (state.uninstalledAt) return [];
  const tr = translator(state);
  const wasInitialized = !!state.baseInitialized;
  const changes = [];
  state.lastAttemptAt = now();
  try {
    checkIdentity(state);
    state.base = lowerKeys(state.base);
    state.mcpApplied = lowerKeys(state.mcpApplied);
    repairRepo(state);
    ensureRepo(state);
    if (opts.scanPrograms || !state.programs?.scannedAt || now() - state.programs.scannedAt > PROGRAM_SCAN_MS) updatePrograms(state);
    let result;
    const started = now();
    const visited = new Set([repoKey(state.repoUrl)]);
    let blocked = false;
    for (let batch = 1; ; batch++) {
    for (let attempt = 1; ; attempt++) {
      const tip = remoteTip(state);
      resetToRemote(state, tip);
      // The repository says the sync moved somewhere else: follow it, with no one having to do
      // anything on this computer. A chain of moves is followed to its end, never round in a circle.
      const note = readMoveNote(state);
      if (!note) delete state.moveBlocked;
      else {
        let why = note.refused
          || (visited.has(repoKey(note.to)) ? 'the notes point round in a circle' : null)
          || (visited.size > MAX_MOVE_HOPS ? 'too many moves in a row' : null);
        if (!why) {
          const heads = remoteHeads(state, note.to);
          if (heads.status !== 0) why = "this computer's access key cannot reach it";
          // The computer that moved fills the new repository before it leaves the note, so an empty
          // one means something went wrong there: wait rather than fill it from here.
          else if (!heads.stdout.trim()) why = 'the new repository is still empty';
        }
        if (!why) {
          visited.add(repoKey(note.to));
          const from = state.repoUrl;
          pointAt(state, note.to, { keepAfter: note.keepAfter });
          saveState(state);
          changes.push({ moved: note.to, from });
          attempt = 0;
          continue;
        }
        // Nobody reads this repository any more, so nothing is sent to it: whatever changed here waits,
        // untouched and not agreed, and goes up to the new repository once this computer can follow.
        log(`the repository says the sync moved to ${note.to}, but it was not followed: ${why}`);
        state.moveBlocked = { to: note.to, why, since: state.moveBlocked?.since || now() };
        blocked = true;
        break;
      }
      syncToolFile();
      result = syncOnce(state, tr, { ...opts, remoteEmpty: !tip }, changes);
      state.cache = result.cache;
      for (const [key, desc] of Object.entries(result.pulled)) {
        if (desc === null) delete state.base[key]; else state.base[key] = desc;
      }
      // --force: ignore rules from synced or global .gitignore files never apply to synced content.
      git(state, ['add', '-A', '--force']);
      const index = listIndex(state);
      for (const [key, upload] of Object.entries(result.uploads)) {
        if (index.get(key)?.desc === upload.desc) continue;
        log(`${key} was not stored by git as written; it stays pending`);
        if (upload.base === undefined) delete result.newBase[key]; else result.newBase[key] = upload.base;
        state.itemFailures[key] = { p: key, msg: 'not stored by git as written', since: state.itemFailures[key]?.since || now() };
      }
      if (git(state, ['diff', '--cached', '--quiet'], { allowFail: true }).status === 0) break;
      git(state, ['commit', '-q', '-m', `sync: ${state.label}`]);
      const push = git(state, ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], { net: true, allowFail: true });
      if (push.status === 0) {
        git(state, ['update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD']);
        break;
      }
      const msg = redact(push.stderr).trim();
      // Another computer pushed first when the remote branch moved: sync again on top of it.
      if (attempt < 5 && remoteTip(state) !== tip) {
        log(`push rejected (attempt ${attempt}), syncing again`);
        continue;
      }
      throw new Error(`git push failed: ${msg}`);
    }
    if (blocked) break;
    state.base = result.newBase;
    state.baseInitialized = true;
    if (!result.deferred) break;
    // A large history goes up in parts. What is already up is agreed and saved, so a run that is cut
    // short resumes from there instead of starting over.
    saveState(state);
    const left = `${result.deferred} item(s) still to upload`;
    if (opts.verbose) console.log(`  part ${batch} uploaded, ${left}...`);
    if (now() - started > (opts.budgetMs ?? RUN_BUDGET_MS)) { log(`${left}; continuing on the next run`); state.uploadPending = result.deferred; break; }
    log(`part ${batch} uploaded, ${left}`);
    }
    if (blocked) {
      // Not a success: status asks for attention after a while, and the session start says why.
      if (!opts.skipTriggers) ensureTriggers(state, false);
      if (wasInitialized) addNotice(state, summarize(changes));
      saveState(state);
      return changes;
    }
    if (!result.deferred) delete state.uploadPending;
    if (reconcilePlugins(state, changes)) fs.writeFileSync(RERUN_FILE, String(now()));
    if (!opts.skipTriggers) ensureTriggers(state, false);
    if (wasInitialized) addNotice(state, summarize(changes));
    if (!state.maintenanceAt || now() - state.maintenanceAt > MAINTENANCE_EVERY_MS) {
      git(state, ['reflog', 'expire', '--expire=now', '--all'], { allowFail: true });
      git(state, ['gc', '--prune=now', '--quiet'], { allowFail: true });
      state.maintenanceAt = now();
    }
    state.lastSuccessAt = now();
    state.lastError = null;
    state.failStreak = 0;
    state.lastChanges = changes.length;
    log(`sync ok: ${changes.length} change(s) applied here, ${Object.keys(state.base).length} item(s) tracked`);
  } catch (e) {
    state.lastError = redact(e.message);
    state.lastErrorAt = now();
    state.failStreak = (state.failStreak || 0) + 1;
    log(`sync failed (${state.failStreak} in a row): ${state.lastError}`);
    saveState(state);
    throw e;
  }
  saveState(state);
  return changes;
}

function acquireLock() {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = now() - fs.statSync(LOCK_FILE).mtimeMs; } catch { continue; }
      const info = readJson(LOCK_FILE, {}) || {};
      if (age < 5000 || (info.pid && isAlive(info.pid) && age < LOCK_STALE_MS)) {
        fs.writeFileSync(RERUN_FILE, String(now()));
        return false;
      }
      fs.rmSync(LOCK_FILE, { force: true });
    }
  }
  fs.writeFileSync(RERUN_FILE, String(now()));
  return false;
}

// The move to a fresh repository talks to GitHub, so it holds the same lock the sync uses, and no
// sync can start in the middle of it.
async function withLockAsync(fn) {
  if (!acquireLock()) return false;
  try { fs.rmSync(RERUN_FILE, { force: true }); await fn(); } finally { fs.rmSync(LOCK_FILE, { force: true }); }
  return true;
}

function withLock(fn) {
  if (!acquireLock()) return false;
  try {
    for (let round = 0; round < 3; round++) {
      fs.rmSync(RERUN_FILE, { force: true });
      fn();
      if (!exists(RERUN_FILE)) break;
    }
  } finally {
    fs.rmSync(LOCK_FILE, { force: true });
  }
  return true;
}

function spawnBackground(args) {
  const script = exists(INSTALLED_SCRIPT) ? INSTALLED_SCRIPT : SCRIPT;
  const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
}

// ---------------------------------------------------------------------------------------------
// Hooks

function hook(name) {
  try {
    const state = loadState();
    if (!state) {
      if (name === 'session-start' && exists(STATE_FILE)) {
        process.stdout.write("[claude-sync] WARNING: the sync between the user's computers cannot read its own state file and has stopped.\n\nInstructions for Claude:\n- Tell the user plainly that the automatic sync between their computers stopped and that they should contact the person who set it up. Do not try to repair it unless the user asks.\n");
      }
      return;
    }
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no input */ }
    if (name === 'session-start') {
      // Sync first and give it a moment, so the session opens already holding what the other computer
      // sent and the notice below describes it. A long sync carries on by itself in the background.
      spawnBackground(['sync', '--quiet']);
      const end = now() + SESSION_START_WAIT_MS;
      sleep(700);
      while (exists(LOCK_FILE) && now() < end) sleep(250);
      const text = sessionStartText(loadState() || state, true);
      if (text) process.stdout.write(`${text}\n`);
    } else if (name === 'post-tool') {
      // A Claude Code file really changed: send it now.
      const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
      if (file && isInside(path.resolve(file), CLAUDE_DIR)) spawnBackground(['sync', '--quiet']);
    } else if (name === 'stop') {
      // End of every turn, so a whole conversation does not become one sync per message on an old
      // computer. Anything missed here is picked up by the scheduled task within five minutes.
      if (now() - (state.lastAttemptAt || 0) > 45e3) spawnBackground(['sync', '--quiet']);
    } else if (name === 'session-end') {
      spawnBackground(['sync', '--quiet', '--scan-programs']);
    }
  } catch (e) {
    log(`hook ${name}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Install and uninstall

const HOOKS = {
  SessionStart: { sub: 'session-start' },
  PostToolUse: { sub: 'post-tool', matcher: 'Write|Edit|MultiEdit|NotebookEdit' },
  Stop: { sub: 'stop' },
  SessionEnd: { sub: 'session-end' },
};
const isOurHook = (group) => (group.hooks || []).some((h) => /claude-sync\.mjs|\.claude-sync[\\/]+hook\.cmd/i.test(String(h.command || '')));

// The launchers hold this computer's Node path and fall back to the PATH when Node moves, so the hook
// line in settings.json (which is synced) is the same text on every computer, and so anyone can run the
// tool on an installed computer without knowing where Node is.
function writeHookLauncher() {
  const launcher = (tail) => [
    '@echo off',
    'chcp 65001 >nul 2>&1',
    `set "N=${process.execPath}"`,
    'if not exist "%N%" set "N=node"',
    `"%N%" "%~dp0claude-sync.mjs" ${tail}`,
    '',
  ].join('\r\n');
  for (const [file, tail] of [[HOOK_LAUNCHER, 'hook %*'], [TOOL_LAUNCHER, '%*']]) {
    const text = launcher(tail);
    if (!exists(file) || fs.readFileSync(file, 'utf8') !== text) writeFileMk(file, text);
  }
}

function editSettings(mutate) {
  const file = path.join(CLAUDE_DIR, 'settings.json');
  let settings = {};
  if (exists(file)) {
    settings = readJson(file);
    if (!settings) throw new Error(`${file} is not valid JSON; fix it first`);
  }
  const before = JSON.stringify(settings);
  mutate(settings);
  if (JSON.stringify(settings) !== before) writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function installSettings() {
  editSettings((s) => {
    if (!(s.cleanupPeriodDays >= 3650)) s.cleanupPeriodDays = 3650;
    s.hooks ||= {};
    for (const [event, { sub, matcher }] of Object.entries(HOOKS)) {
      const groups = (s.hooks[event] || []).filter((g) => !isOurHook(g));
      const group = { hooks: [{ type: 'command', command: `"${HOOK_LAUNCHER}" ${sub}`, timeout: 60 }] };
      if (matcher) group.matcher = matcher;
      s.hooks[event] = [...groups, group];
    }
  });
}

function claudeMdBlock(eol) {
  return [
    CLAUDE_MD_START,
    '## Sync between computers',
    '',
    "This Claude Code is kept identical on all of the user's computers by claude-sync, automatically and in the background: memory, this file, skills, agents, commands, settings, plugins, MCP servers and conversation history. The user never needs to sync anything by hand, and you never need to either.",
    '',
    '- Never edit, move or delete the `.claude-sync` folder in the user profile.',
    '- When the session starts with a `[claude-sync]` message, follow its instructions: tell the user in one or two plain sentences, in their language, what came from the other computer, and run any pending installs it lists.',
    `- If the user ever asks whether their two computers are still in sync, or says something they did on the other computer is missing, run \`"${TOOL_LAUNCHER}" status\` (in PowerShell, with & in front; never with "cmd /c") and read it: "Health" says ok or not, and "Last successful sync" says when. Tell them the answer in one plain sentence. To bring everything over right away, run \`"${TOOL_LAUNCHER}" sync\` first.`,
    CLAUDE_MD_END,
  ].join(eol);
}

function installClaudeMd() {
  const file = path.join(CLAUDE_DIR, 'CLAUDE.md');
  const current = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.includes(CLAUDE_MD_START)) return;
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const head = current.trim() ? `${current.replace(/\s*$/, '')}${eol}${eol}` : '';
  writeFileAtomic(file, `${head}${claudeMdBlock(eol)}${eol}`);
}

const taskArgument = () => `--headless "${process.execPath}" "${INSTALLED_SCRIPT}" sync --quiet`;

function taskMatches() {
  const r = psRun(`[Console]::OutputEncoding = [Text.Encoding]::UTF8; $t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; if ($t -and $t.State -ne 'Disabled') { $t.Actions[0].Arguments }`);
  return r.status === 0 && (r.stdout || '').trim() === taskArgument();
}

// The triggers heal each other: a run started by the scheduled task puts the hooks back, and a run
// started by a hook puts the scheduled task back. Returns what could not be restored.
function ensureTriggers(state, force) {
  if (!force && state.triggersCheckedAt && now() - state.triggersCheckedAt < TRIGGER_CHECK_MS) return [];
  const problems = [];
  const step = (name, fn) => {
    try { fn(); } catch (e) { problems.push(`${name}: ${e.message}`); log(`could not set up ${name}: ${e.message}`); }
  };
  step('hook launcher', writeHookLauncher);
  step('Claude Code hooks', installSettings);
  step('CLAUDE.md note', installClaudeMd);
  if (process.platform === 'win32' && !state.noTask) step('scheduled task', () => { if (!taskMatches()) { registerTask(); log('scheduled task registered'); } });
  if (!problems.length) state.triggersCheckedAt = now(); // anything that failed is tried again on the next run
  return problems;
}

function registerTask() {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const argument = taskArgument();
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    `$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${q(argument)} -WorkingDirectory ${q(SYNC_DIR)}`,
    '$logon = New-ScheduledTaskTrigger -AtLogOn -User $user',
    '$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)',
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 90)',
    '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    `Register-ScheduledTask -TaskName ${q(TASK_NAME)} -Action $action -Trigger $logon,$repeat -Settings $settings -Principal $principal -Force | Out-Null`,
  ].join('\n');
  const r = psRun(script);
  if (r.status !== 0) throw new Error(`could not create the scheduled task: ${(r.stderr || r.stdout).trim()}`);
}

// The scheduled task does not always see the same PATH as a terminal, so Git is kept as a full path.
function findGit() {
  const where = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
  const candidates = [
    ...(where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /\.exe$/i.test(l)) : []),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
    path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs', 'Git', 'cmd', 'git.exe'),
  ];
  return candidates.find((c) => exists(c)) || null;
}

function gitExe(state) {
  if (state.gitPath && exists(state.gitPath)) return state.gitPath;
  const found = findGit();
  if (found) state.gitPath = found;
  return found || 'git';
}

function checkGit(state) {
  const r = spawnSync(gitExe(state), ['--version'], { encoding: 'utf8', windowsHide: true });
  const v = /(\d+)\.(\d+)/.exec(r.stdout || '');
  if (r.status !== 0 || !v) throw new Error('Git is not installed (https://git-scm.com/download/win)');
  if (Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 31)) throw new Error(`Git 2.31 or newer is required (found ${v[0]})`);
}

// ---------------------------------------------------------------------------------------------
// Moving the sync to a fresh repository, with the user's agreement

async function repoTaken(url) {
  const { api, owner, name, headers } = githubApi(url);
  const r = await fetch(`${api}/repos/${owner}/${name}`, { headers, signal: AbortSignal.timeout(30e3) });
  if (r.status === 404) return false;
  if (r.ok) return true;
  throw new Error(`could not check ${owner}/${name} (HTTP ${r.status})`);
}

// claude-sync -> claude-sync-2 -> claude-sync-3, next to the current one, same owner.
async function nextRepoUrl(current) {
  const url = new URL(current);
  const [owner, nameRaw] = url.pathname.split('/').filter(Boolean);
  const name = (nameRaw || '').replace(/\.git$/, '');
  const m = /^(.*?)-(\d+)$/.exec(name);
  const stem = m ? m[1] : name;
  let n = m ? Number(m[2]) + 1 : 2;
  for (let tries = 0; tries < 20; tries++, n++) {
    const candidate = `${url.origin}/${owner}/${stem}-${n}`;
    if (!(await repoTaken(candidate))) return candidate;
  }
  throw new Error(`could not find a free name next to ${name}`);
}

// What this computer would carry to a new repository, and what it would leave behind.
function rotationPlan(state, keepAfter) {
  const tr = translator(state);
  let carry = 0;
  let leave = 0;
  let leaveCount = 0;
  const { entries } = scanClaude(state, tr);
  const activity = sessionActivity(entries);
  for (const e of entries.values()) {
    const size = e.size || 0;
    if (!leftBehind(e, activity, keepAfter)) { carry += size; continue; }
    leave += size;
    if (e.logical.split('/').length === 4 && e.logical.endsWith('.jsonl')) leaveCount++;
  }
  return { carryMb: Math.round(carry / 1048576), leaveMb: Math.round(leave / 1048576), leaveCount };
}

const keepAfterFrom = (args) => {
  if (args['keep-all']) return 0;
  const days = Number(args['keep-days']);
  return now() - (Number.isFinite(days) && days > 0 ? days : ROTATE_KEEP_DAYS) * 86400e3;
};

// The offer to move has its own small file, so answering it never competes with the sync over the
// state file.
const readOffer = () => readJson(OFFER_FILE, {}) || {};
const writeOffer = (patch) => writeFileAtomic(OFFER_FILE, JSON.stringify({ ...readOffer(), ...patch }));

// Fills the new repository with exactly what the current one holds at its tip (the local copy was just
// synced), minus the note and the conversations left behind. That content is what both computers already
// agreed on, so whichever of them reaches the new repository first finds it complete and in agreement with
// what it knows: its own changes since then are the only thing it sends.
// Returns null when the new repository changed under it: the other computer, moving to the same name at
// the same moment, filled it first. `expect` is what this computer last saw there ('' for empty), and
// the fill only lands if that is still true, so one computer never overwrites the other's fill.
function seedFromCurrent(state, target, keepAfter, expect) {
  const remote = listRemote(state);
  const activity = new Map();
  for (const [key, R] of remote) {
    const m = /^claude\/projects\/[^/]+\/([^/]+)\.jsonl$/.exec(key);
    if (!m) continue;
    try {
      const t = lastActivity(fs.readFileSync(path.join(REPO_DIR, R.files[R.files.length - 1].file)));
      if (t !== null) activity.set(m[1], t);
    } catch { /* unreadable here: carried */ }
  }
  const drop = [MOVE_FILE];
  let left = 0;
  if (keepAfter) {
    for (const [key, R] of remote) {
      const sid = sessionIdOf(key);
      const at = sid ? activity.get(sid) : undefined;
      if (at === undefined || at >= keepAfter) continue; // no date inside: carried
      for (const f of R.files) drop.push(f.file);
      if (key.split('/').length === 4) left++;
    }
  }
  const index = path.join(SYNC_DIR, 'seed.index');
  const env = { GIT_INDEX_FILE: index };
  fs.rmSync(index, { force: true });
  try {
    git(state, ['read-tree', 'HEAD'], { env });
    git(state, ['update-index', '--force-remove', '-z', '--stdin'], { env, input: `${drop.join('\0')}\0` });
    const tree = git(state, ['write-tree'], { env }).stdout.trim();
    const commit = git(state, ['commit-tree', tree, '-m', 'sync: moved here']).stdout.trim();
    // Remembered before it is sent, so a move cut short while sending still recognises the new
    // repository as its own the next time.
    const earlier = state.rotateSeed?.target === target ? state.rotateSeed.commits || [] : [];
    state.rotateSeed = { target, commits: [...earlier.slice(-9), commit] };
    saveState(state);
    // Replacing an earlier fill of its own is fine; anything else there is left alone.
    const push = git(state, ['push', '-q', `--force-with-lease=refs/heads/${BRANCH}:${expect}`, target, `${commit}:refs/heads/${BRANCH}`], { net: true, allowFail: true });
    if (push.status !== 0) {
      if (/stale info|cannot lock ref|already exists|fetch first|non-fast-forward/i.test(String(push.stderr))) return null;
      throw new Error(`could not fill ${target}: ${redact(push.stderr).trim()}`);
    }
    return { commit, left };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

// Lets the tests stop a move right after a given step, the way a closed laptop would.
function testStop(step) {
  if (process.env.CLAUDE_SYNC_TEST_STOP_AFTER !== step) return;
  log(`move stopped after "${step}" (test)`);
  fs.rmSync(LOCK_FILE, { force: true });
  process.exit(3);
}

function writeMoveNote(state, to, keepAfter) {
  const note = { to, at: now(), by: state.label || '', keepAfter: keepAfter || 0 };
  writeFileMk(moveNotePath(), `${stableStringify(note)}\n`);
  git(state, ['add', '-A', '--force']);
  if (git(state, ['diff', '--cached', '--quiet'], { allowFail: true }).status === 0) return true;
  git(state, ['commit', '-q', '-m', 'sync: moved to a new repository']);
  if (git(state, ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], { net: true, allowFail: true }).status === 0) {
    git(state, ['update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD']);
    return true;
  }
  return false;
}

// Runs with the sync lock held, so nothing else touches the local copy of the repository meanwhile.
// The order is what keeps both computers whole: the new repository is filled completely first, and only
// then the note is left in the current one, so no computer ever finds the new repository empty or half
// filled. A refused note means the other computer sent something in the meantime: this computer takes
// it, fills the new repository again from the newer state, and tries again.
async function rotateLocked(args, keepAfter, startUrl) {
  const presync = () => {
    // Large uploads are left for the new repository instead of growing the one being retired.
    runSync({ budgetMs: 0, uploadBudget: 20 * 1048576 });
    return loadState();
  };
  let state = presync();
  const followed = (target) => ({ followed: state.repoUrl, unused: target && !sameRepo(target, state.repoUrl) ? target : null });
  if (!sameRepo(state.repoUrl, startUrl)) return followed(null);
  // The other computer already moved and this one cannot follow yet: a second move from here would
  // leave the two computers on different repositories for good.
  if (state.moveBlocked) {
    throw new Error(`the other computer already moved the sync to ${state.moveBlocked.to}, and this computer cannot follow it (${state.moveBlocked.why}), so nothing was moved`);
  }

  const asked = typeof args.repo === 'string' && args.repo ? args.repo : null;
  const target = asked || state.rotateTarget || await nextRepoUrl(state.repoUrl);
  // Remembered before anything is created, so an attempt cut short reuses it instead of leaving an
  // empty repository behind every time.
  state.rotateTarget = target;
  saveState(state);
  console.log(`New repository: ${target}`);
  if (!(await repoTaken(target))) {
    try {
      await createRemoteRepo(state, target);
    } catch (e) {
      // The other computer may have created the same name a moment ago.
      if (!(await repoTaken(target))) throw e;
    }
  }
  let heads = remoteHeads(state, target);
  for (let i = 1; i <= 8 && heads.status !== 0; i++) { sleep(2000); heads = remoteHeads(state, target); }
  if (heads.status !== 0) throw new Error(`${target} exists, but this computer cannot reach it with its access key`);
  testStop('created');
  const tip = (/^([0-9a-f]{40})\s+refs\/heads\//m.exec(heads.stdout) || [])[1] || null;
  const ours = state.rotateSeed?.target === target ? state.rotateSeed.commits || [] : [];
  // Something that this computer did not put there: most likely the other computer moving to the same
  // name at this very moment. Its note shows up in a few seconds; follow it. Anything else is never
  // overwritten.
  const waitForTheirNote = () => {
    for (let i = 0; i < 6; i++) {
      state = presync();
      if (!sameRepo(state.repoUrl, startUrl)) return followed(target);
      sleep(10e3);
    }
    delete state.rotateTarget;
    saveState(state);
    throw new Error(`${target} already holds other content, so it cannot receive the sync. Run this again without --repo to pick the next free name, or name an empty repository.`);
  };
  if (tip && !ours.includes(tip)) return waitForTheirNote();
  await assertPrivate(target);

  let noted = false;
  let seed = null;
  let expect = tip || '';
  for (let attempt = 1; attempt <= 5 && !noted; attempt++) {
    if (attempt > 1) {
      state = presync();
      if (!sameRepo(state.repoUrl, startUrl)) return followed(target);
    }
    seed = seedFromCurrent(state, target, keepAfter, expect);
    if (!seed) return waitForTheirNote();
    expect = seed.commit;
    testStop('seeded');
    noted = writeMoveNote(state, target, keepAfter);
    if (!noted) log(`the current repository changed while moving; filling the new one again (attempt ${attempt})`);
  }
  if (!noted) throw new Error('the current repository kept changing, so nothing was moved; run this again in a minute');
  testStop('noted');

  pointAt(state, target, { keepAfter });
  state.rotatedAt = now();
  saveState(state);
  console.log('Sending what this computer has that is not there yet...');
  runSync({ verbose: true, budgetMs: 5 * 60e3 });
  return { moved: target, from: startUrl, left: seed.left };
}

async function rotate(args) {
  const state = loadState();
  if (!state) throw new Error('claude-sync is not installed on this computer');
  if (state.uninstalledAt) throw new Error('claude-sync was uninstalled on this computer');
  if (args.later) {
    const until = now() + ROTATE_LATER_MS;
    writeOffer({ laterUntil: until });
    console.log(`Fine. Nothing changed, and the move will be offered again after ${fmtDate(until)}.`);
    return;
  }
  const keepAfter = keepAfterFrom(args);
  const asked = typeof args.repo === 'string' && args.repo ? args.repo : null;
  if (asked) {
    new URL(asked); // validates the address
    if (sameRepo(asked, state.repoUrl)) throw new Error('the new repository has to be a different one');
    // The other computer only follows a move next to the current repository.
    if (ownerOf(asked) !== ownerOf(state.repoUrl)) {
      throw new Error(`the new repository has to belong to the same owner as the current one (${ownerOf(state.repoUrl)}), so the other computer can follow it`);
    }
  }
  // The move was offered for a repository this computer has since left (the other computer moved first,
  // while the person was answering): it already happened.
  const offer = readOffer();
  if (!asked && offer.offeredFor && !sameRepo(offer.offeredFor, state.repoUrl) && now() - (offer.offeredAt || 0) < ROTATE_OFFER_AGAIN_MS) {
    console.log(`The sync already moved to a new repository (${state.repoUrl}). Nothing else to do.`);
    return;
  }
  if (!args.yes) {
    const plan = rotationPlan(state, keepAfter);
    const size = readRepoSize(state);
    console.log([
      `Current repository: ${state.repoUrl}${size ? ` (${size.mb} MB)` : ''}`,
      'Moving the sync creates a new private repository next to it and points both computers at it.',
      'Nothing is deleted anywhere: every conversation, memory and skill stays on both computers.',
      `It would carry about ${plan.carryMb} MB and leave ${plan.leaveCount} older conversation(s) (${plan.leaveMb} MB) out of the new repository; they stay on both computers and in the old repository.`,
      '',
      'To go ahead, run the same command with --yes. To be asked again in a month, run it with --later.',
    ].join('\n'));
    return;
  }

  console.log('Bringing this computer up to date before moving...');
  const startUrl = state.repoUrl;
  let outcome;
  try {
    for (let attempt = 1; ; attempt++) {
      if (await withLockAsync(async () => { outcome = await rotateLocked(args, keepAfter, startUrl); })) break;
      if (attempt === 1) console.log('Waiting for the sync that is running right now...');
      if (attempt >= 60) throw new Error('a sync is running and did not finish; run this again in a few minutes');
      sleep(10e3);
    }
  } catch (e) {
    // The person is not asked again about a move that cannot work: Claude tells them to call for help.
    writeOffer({ failedAt: now(), failedFor: startUrl, failure: redact(e.message).slice(0, 300) });
    throw e;
  }
  writeOffer({ offeredFor: null, failedAt: null, failedFor: null, failure: null });
  if (outcome.followed) {
    console.log(`The other computer had already moved the sync, so this computer followed it to ${outcome.followed}. Nothing else to do.`);
    if (outcome.unused) console.log(`${outcome.unused} was created for the move and is not used; it can be deleted.`);
    console.log(statusText());
    return;
  }
  const after = loadState();
  await updateRepoSize(after, true);
  if (after.uploadPending) spawnBackground(['sync', '--quiet']);
  console.log(`\nDone. This computer now syncs through ${outcome.moved}.`);
  console.log('The other computer moves by itself the next time it syncs, with nothing to do there.');
  if (outcome.left) console.log(`${outcome.left} conversation(s) not used in a long time stay on each computer and in the old repository.`);
  if (after.uploadPending) console.log(`The rest (${after.uploadPending} item(s)) keeps uploading in the background.`);
  console.log(`Keep the old repository (${outcome.from}): it is what tells a computer that was off, or a copy of the setup file, where the sync went.`);
  console.log(statusText());
}

async function install(args) {
  // A computer that is set up stays on the repository it knows: the carried file may still name one the
  // sync has since moved away from. One that was uninstalled starts again from what it is given.
  const prior = loadState();
  const known = prior && !prior.uninstalledAt ? prior.repoUrl : null;
  // A clean file makes this the first computer, which saves the package for the other one at the end.
  const firstComputer = !CONFIG.repoUrl;
  // Only an address typed now may be created. One read from this computer or from the carried file
  // names a repository that already existed; if it is gone, creating it again would leave this computer
  // alone in an empty repository while the other one syncs somewhere else.
  const typed = typeof args.repo === 'string';
  if (!typed && (known || CONFIG.repoUrl)) args.repo = known || CONFIG.repoUrl;
  if (typeof args.name !== 'string') args.name = CONFIG.repoUrl ? 'Casa' : 'Escritório';
  if (typeof args.support !== 'string' && CONFIG.supportName) args.support = CONFIG.supportName;
  if (!args.repo || typeof args.repo !== 'string') {
    throw new Error('usage: install --repo <https url of a private repository> --name <label for this computer> --token <token>');
  }
  new URL(args.repo); // validates the address
  if (!exists(CLAUDE_DIR)) throw new Error(`Claude Code folder not found: ${CLAUDE_DIR} (open Claude Code once first)`);
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  if (path.resolve(SCRIPT).toLowerCase() !== INSTALLED_SCRIPT.toLowerCase()) fs.copyFileSync(SCRIPT, INSTALLED_SCRIPT);
  // The key can come on the command line, in the environment, or inside the file the person carries.
  const token = typeof args.token === 'string' ? args.token : (process.env.CLAUDE_SYNC_TOKEN || CONFIG.carriedToken);
  if (token) saveToken(token.trim());
  else if (!exists(TOKEN_FILE)) throw new Error('a GitHub token with read and write access to the repository is required: --token <token> or the CLAUDE_SYNC_TOKEN variable');

  const previous = loadState() || {};
  const state = {
    ...previous,
    machineId: previous.machineId || crypto.randomUUID(),
    hostname: os.hostname(),
    label: args.name,
    repoUrl: args.repo,
    support: typeof args.support === 'string' ? args.support : previous.support || null,
    installedAt: previous.installedAt || now(),
  };
  delete state.uninstalledAt;
  delete state.gitPath;
  checkGit(state);
  if ((previous.repoUrl && previous.repoUrl !== args.repo) || previous.uninstalledAt) {
    // Another repository, or the same one after this computer was removed: what was agreed before says
    // nothing about what the repository holds now, so this computer joins it like a new one.
    for (const k of ['base', 'baseInitialized', 'cache', 'mcpApplied', 'otherLabels', 'otherPrograms', 'pluginAttempts', 'itemFailures']) delete state[k];
    fs.rmSync(REPO_DIR, { recursive: true, force: true });
  }
  if (state.shortHome === undefined) state.shortHome = shortPathOf(HOME);
  ensureRepo(state);
  let access = git(state, ['ls-remote', 'origin'], { net: true, allowFail: true });
  if (access.status !== 0 && /not found|404|does not exist/i.test(String(access.stderr))) {
    if (!typed) {
      throw new Error(`${args.repo} no longer exists. The sync has probably moved to a new repository: run "status" on the other computer, which shows the current one, and install again with --repo and that address.`);
    }
    console.log(`Repository ${args.repo} does not exist yet; creating it as private...`);
    await createRemoteRepo(state, args.repo);
    // A repository just created takes a moment to answer on the git address.
    for (let attempt = 1; attempt <= 8; attempt++) {
      access = git(state, ['ls-remote', 'origin'], { net: true, allowFail: true });
      if (access.status === 0) break;
      sleep(2000);
    }
  }
  if (access.status !== 0) throw new Error(`cannot access ${args.repo} with this token: ${redact(access.stderr).trim()}`);
  await assertPrivate(args.repo);
  console.log(`Repository access: ok, and it is private (${args.repo})`);
  state.noTask = !!args['no-task'] || process.platform !== 'win32';

  // The carried file learns the address before anything can fail, so the other computer always finds it,
  // together with the account that owns the key, which the other computer signs in with.
  try {
    writeConfig({ repoUrl: args.repo, githubLogin: (await keyOwner(args.repo)) || CONFIG.githubLogin });
  } catch { /* the address is already stored in the state file */ }
  // The triggers are set up before the first sync, so an interrupted install still leaves a computer
  // that syncs by itself and repairs the rest on its own.
  const problems = ensureTriggers(state, true);
  if (problems.length) console.log(`Could not set up yet, will be retried automatically: ${problems.join('; ')}`);
  else if (!state.noTask) console.log(`Scheduled task "${TASK_NAME}": runs at logon and every 5 minutes, with no window`);
  if (!state.programs?.baseline) {
    console.log('Recording the programs already installed (this can take a minute)...');
    updatePrograms(state);
  }
  saveState(state);

  console.log('First sync (a large history goes up in parts and finishes by itself)...');
  for (let attempt = 1; attempt <= 30; attempt++) {
    if (withLock(() => runSync({ verbose: true }))) break;
    if (attempt === 1) console.log('Waiting for the sync that is already running...');
    if (attempt === 30) throw new Error('another sync is running and did not finish; run this again in a minute');
    sleep(10e3);
  }
  withLock(() => runSync({}));
  for (const w of brokenHookWarnings()) console.log(`WARNING: ${w}`);
  console.log(statusText());
  console.log('\nInstalled. Restart VS Code (or open a new Claude Code session) to load the hooks.');
  if (firstComputer) announcePackage();
  else if (CONFIG.carriedToken) console.log(`\nThe file that installed this computer carries the access key: tell the person to delete ${CARRY_ZIP} and the folder unzipped from it, on both computers.`);
}

function uninstall() {
  if (process.platform === 'win32') psRun(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`);
  editSettings((s) => {
    for (const event of Object.keys(HOOKS)) {
      if (!s.hooks?.[event]) continue;
      s.hooks[event] = s.hooks[event].filter((g) => !isOurHook(g));
      if (!s.hooks[event].length) delete s.hooks[event];
    }
  });
  const md = path.join(CLAUDE_DIR, 'CLAUDE.md');
  if (exists(md)) {
    const text = fs.readFileSync(md, 'utf8');
    const start = text.indexOf(CLAUDE_MD_START);
    const end = text.indexOf(CLAUDE_MD_END);
    if (start !== -1 && end > start) writeFileAtomic(md, `${text.slice(0, start).replace(/\s*$/, '')}${text.slice(end + CLAUDE_MD_END.length).replace(/^\s*/, '\n')}`);
  }
  fs.rmSync(TOKEN_FILE, { force: true });
  fs.rmSync(HOOK_LAUNCHER, { force: true });
  // The launcher that runs this very command stays: Windows reads a batch file line by line, and one
  // removed while it runs ends with a "batch file cannot be found" message. It does nothing on its own.
  // The carried file and the installed copy stop being a key.
  try { writeConfig({ carriedToken: '' }); } catch { /* nothing to clear */ }
  const state = loadState();
  if (state) { state.uninstalledAt = now(); saveState(state); }
  console.log(`claude-sync was removed from this computer. The local copy stays in ${SYNC_DIR}.`);
}

// settings.json travels between the computers, and a hook of another tool can point at a file that only
// exists on the computer it came from. Claude Code would report that hook as failing at every start.
function brokenHookWarnings() {
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json'), {}) || {};
  const out = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const g of groups || []) {
      for (const h of g.hooks || []) {
        const cmd = String(h.command || '');
        if (h.type !== 'command' || isOurHook(g)) continue;
        for (const m of cmd.matchAll(/(?:"([A-Za-z]:\\[^"]+)"|([A-Za-z]:\\[^\s"]+\.(?:mjs|js|cjs|ps1|cmd|bat|exe|py)))/g)) {
          const p = m[1] || m[2];
          if (!exists(p)) out.push(`the ${event} hook of another tool points at ${p}, which does not exist on this computer; Claude Code will report it as failing until it is installed here or removed from settings.json`);
        }
      }
    }
  }
  return [...new Set(out)];
}

function statusText() {
  const state = loadState();
  if (!state) return 'claude-sync is not installed on this computer.';
  const tracked = Object.keys(state.base || {});
  const sessions = new Set(tracked.map(sessionIdOf).filter(Boolean));
  const notices = exists(NOTICES_DIR) ? fs.readdirSync(NOTICES_DIR).length : 0;
  let task = 'not registered';
  if (process.platform === 'win32') {
    const r = psRun(`[Console]::OutputEncoding = [Text.Encoding]::UTF8; $t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; $i = Get-ScheduledTaskInfo -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; if ($i) { '{0}|{1}|{2}' -f $t.State, $i.LastRunTime.ToString('dd/MM/yyyy HH:mm'), $i.NextRunTime.ToString('dd/MM/yyyy HH:mm') }`);
    const [taskState, last, next] = (r.stdout || '').trim().split('|');
    if (taskState) task = `${taskState === 'Disabled' ? 'REGISTERED BUT DISABLED' : 'registered'}, last run ${last}, next run ${next || 'unknown'}`;
  }
  const hooks = readJson(path.join(CLAUDE_DIR, 'settings.json'), {}) || {};
  const hooked = Object.keys(HOOKS).filter((e) => (hooks.hooks?.[e] || []).some(isOurHook)).length;
  // Measured by GitHub itself (the copy kept here is shallow and cannot tell). Refreshed by the sync
  // twice a day, or right away with "sync --check-size".
  const measured = readRepoSize(state);
  const size = !measured ? 'not measured yet'
    : `${measured.mb} MB, measured ${fmtDate(measured.at)}${measured.mb >= ROTATE_SUGGEST_MB ? ', time to move to a fresh repository (rotate)' : ''}${measured.private ? '' : ', ATTENTION: the repository is PUBLIC'}`;
  const offer = readOffer();
  const moved = [
    state.previousRepoUrl ? `Previous repository: ${state.previousRepoUrl}${state.rotatedAt ? ` (moved from here on ${fmtDate(state.rotatedAt)})` : ' (followed the other computer)'}` : null,
    state.transcriptsAfter ? `Conversations carried: those used since ${fmtDate(state.transcriptsAfter)}; older ones stay on each computer` : null,
    state.moveBlocked ? `ATTENTION: the other computer moved the sync to ${state.moveBlocked.to}, not followed here: ${state.moveBlocked.why || 'unreachable'} (since ${fmtDate(state.moveBlocked.since)})` : null,
    offer.laterUntil > now() ? `Move to a fresh repository postponed until ${fmtDate(offer.laterUntil)}` : null,
  ].filter(Boolean);
  // The scheduled task itself cannot report a result (it runs with no window), so health is read from
  // what the sync recorded.
  const healthy = state.lastSuccessAt && now() - state.lastSuccessAt < FAILURE_WARN_MS;
  return [
    `claude-sync version ${VERSION} on "${state.label}" (${os.hostname()})`,
    `Repository: ${state.repoUrl}`,
    `Health: ${healthy ? 'ok' : 'ATTENTION, see the lines below'}${state.failStreak ? `, ${state.failStreak} failed attempt(s) in a row` : ''}`,
    `Last successful sync: ${state.lastSuccessAt ? fmtDate(state.lastSuccessAt) : 'never'}`,
    `Last attempt: ${state.lastAttemptAt ? fmtDate(state.lastAttemptAt) : 'never'}`,
    `Last error: ${state.lastError ? `${state.lastError} (${fmtDate(state.lastErrorAt)})` : 'none'}`,
    `Scheduled task: ${task}`,
    `Claude Code hooks: ${hooked} of ${Object.keys(HOOKS).length} in place`,
    `Repository size: ${size}`,
    ...moved,
    `Still to upload: ${state.uploadPending ? `${state.uploadPending} item(s), continuing on the next runs` : 'nothing'}`,
    `Tracked: ${tracked.filter((p) => p.startsWith('claude/')).length} files (${sessions.size} conversations), ${tracked.filter((p) => p.startsWith('mcp/')).length} MCP servers`,
    `Other computers: ${Object.values(state.otherLabels || {}).join(', ') || 'none yet'}`,
    `Notices waiting for the next session: ${notices}`,
    `Programs to install from other computers: ${pendingPrograms(state).length}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Guided setup: one file that carries its own instructions. Run by a person (double click) or by
// Claude Code, on a computer where nothing exists yet.

// The file the person carries between computers (the .cmd), not the script extracted to run.
const selfPath = () => process.env.CLAUDE_SYNC_SELF || SCRIPT;
const insideClaude = () => !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT);

// `remember` writes into the loose .mjs as well, because that is the file the person is pointing at.
// An install never does: it would leave an address inside a source file someone is only building from.
function writeConfig(patch, { includeScript = false } = {}) {
  const next = { ...CONFIG, ...patch };
  // Only the file the person carries takes the key: the installed copy has DPAPI for that.
  const installedBlock = CONFIG_BLOCK({ ...next, carriedToken: '' });
  const loose = includeScript && !isInside(path.resolve(SCRIPT), os.tmpdir()) ? SCRIPT : null;
  const carried = process.env.CLAUDE_SYNC_SELF || loose;
  for (const file of new Set([carried, INSTALLED_SCRIPT].filter(Boolean))) {
    if (!exists(file)) continue;
    const block = path.resolve(file).toLowerCase() === INSTALLED_SCRIPT.toLowerCase() ? installedBlock : CONFIG_BLOCK(next);
    const text = fs.readFileSync(file, 'utf8');
    const replaced = text.replace(/const CONFIG = \{[\s\S]*?\n\};/, () => block);
    if (replaced !== text) writeFileAtomic(file, Buffer.from(replaced, 'utf8'));
  }
  Object.assign(CONFIG, next);
}

// The Desktop the person sees, which may live inside OneDrive, as long as it belongs to this user profile.
function desktopDir() {
  const r = psRun("[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')");
  const known = (r.stdout || '').trim();
  return known && isInside(path.resolve(known), HOME) ? known : path.join(HOME, 'Desktop');
}

// Everything the other computer needs, in one file on the Desktop: this setup file as it is now, already
// holding the address of the repository, and the documentation that came with it. Returns the path, or
// null when this is not running from the setup file.
function writeCarryPackage() {
  const self = process.env.CLAUDE_SYNC_SELF;
  if (!self || !exists(self)) return null;
  const entries = [[self, 'claude-sync.cmd'], ...['README.md', 'README.pt-BR.md']
    .map((doc) => [path.join(path.dirname(self), doc), doc]).filter(([from]) => exists(from))];
  const dir = desktopDir();
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, CARRY_ZIP);
  const tmp = `${zip}${TMP_SUFFIX}`;
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  fs.rmSync(tmp, { force: true });
  const r = psRun([
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem',
    `$zip = [IO.Compression.ZipFile]::Open(${q(tmp)}, 'Create')`,
    'try {',
    ...entries.map(([from, name]) => `  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, ${q(from)}, ${q(`claude-sync/${name}`)}, 'Optimal') | Out-Null`),
    '} finally { $zip.Dispose() }',
  ].join('\n'));
  if (r.status !== 0 || !exists(tmp)) {
    fs.rmSync(tmp, { force: true });
    throw new Error((r.stderr || r.stdout || r.error?.message || 'PowerShell did not answer').trim());
  }
  fs.rmSync(zip, { force: true });
  fs.renameSync(tmp, zip);
  return zip;
}

function announcePackage() {
  try {
    const zip = writeCarryPackage();
    if (!zip) return null;
    console.log(`\nFor the other computer: ${zip}`);
    console.log('Take this file to the other computer, unzip it there and run the claude-sync.cmd inside it.');
    if (CONFIG.carriedToken) console.log('It carries the access key as well: treat it as a key. Carry it on a USB drive, never on a shared drive or by e-mail, and delete it once the other computer is set up.');
    return zip;
  } catch (e) {
    console.log(`\nCould not save ${CARRY_ZIP} on the Desktop (${redact(e.message)}). Run "remember" to try again.`);
    return null;
  }
}

function machineFacts() {
  const state = loadState();
  const facts = {
    hostname: os.hostname(),
    home: HOME,
    claudeDir: CLAUDE_DIR,
    claudeDirExists: exists(CLAUDE_DIR),
    git: findGit() || 'not found',
    node: process.version,
    claudeCli: claudeBin() || 'not found',
    repoUrl: state?.repoUrl || CONFIG.repoUrl || '',
    githubLogin: CONFIG.githubLogin || '',
    installed: !!state?.repoUrl,
    tokenStored: exists(TOKEN_FILE),
    label: state?.label || '',
  };
  facts.stage = facts.installed && facts.tokenStored ? 'installed' : (facts.repoUrl ? 'join' : 'first');
  return facts;
}

function runbookText(facts) {
  const self = selfPath();
  const label = facts.stage === 'first' ? 'Escritório' : 'Casa';
  const lines = [
    '================ claude-sync SETUP RUNBOOK ================',
    'You are Claude Code, running on the computer of the person who owns this Claude Code.',
    'Your job: leave this computer syncing with the person\'s other computer, doing everything yourself.',
    'Speak to the person in their language, in short plain sentences. They are not technical.',
    'Never show them a token, a path or a command. Never ask them to type a command.',
    '',
    'HOW TO RUN THE COMMANDS BELOW: run the quoted path of the file on its own, exactly as written. In a',
    'Bash shell that is the whole command; in PowerShell put & before it. Do not put "cmd /c" in front:',
    'in the Bash shell of Claude Code on Windows the /c is turned into a path and cmd opens an',
    'interactive window that answers nothing.',
    '',
    `This computer: ${facts.hostname}, user folder ${facts.home}`,
    `Git: ${facts.git}`,
    `Node.js: ${facts.node}`,
    `Claude Code CLI: ${facts.claudeCli}`,
    `This file: ${self}`,
    `Stage: ${facts.stage}`,
    '',
    ...(facts.git === 'not found' ? [
      'STEP ZERO, do this before anything else: Git is not installed on this computer and claude-sync cannot',
      'work without it. Install it now, with the person present, and do not start the steps below until',
      '  where git  finds it:',
      '  winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements',
      'If winget is blocked or there is no administrator password, download the portable version and tell the',
      'person where it is: https://git-scm.com/download/win (the "64-bit Git for Windows Portable" file).',
      '',
    ] : []),
    'Shortcut: if the person setting this up already has the repository address and an access key (they may',
    'have created the account, the organization and the key themselves), skip every browser step and run:',
    `  "${self}" install --repo <https url> --name "<Escritório or Casa>" --token <key>`,
    'The repository is created as private by this command if it does not exist yet. On the first computer it also',
    `saves ${CARRY_ZIP} on the Desktop, the package for the other computer. On the second computer the`,
    'address is already inside this file, so only --name and --token are needed, and the same key from the first',
    'computer can be reused.',
    '',
  ];
  if (facts.stage === 'installed') {
    lines.push(
      'claude-sync is already installed here and pointing at:',
      `  ${facts.repoUrl}`,
      'Steps:',
      `1. Run: "${self}" sync`,
      `2. Run: "${self}" status`,
      '   Read three lines: "Health" must say ok, "Scheduled task" must say registered (never DISABLED), and',
      '   "Claude Code hooks" must say 4 of 4. The sync repairs all of that by itself while it runs, so if a',
      '   line is still wrong, run step 1 once more and read it again.',
      '3. Tell the person in one sentence that both computers are in sync, and stop.',
    );
    return lines.join('\n');
  }
  const browserRule = [
    'How to drive the browser:',
    '- Use the Playwright tools with a visible window, and show the person each screen while you fill it.',
    '- Let the person type email, password, puzzle and codes. Never type their password and never solve a puzzle.',
    '- github.com sometimes answers an automated browser with "Access has been restricted" (HTTP 403). If that',
    '  page appears, open the same address in the person\'s own browser with: start "" "<url>" , guide them',
    '  by voice screen by screen, and carry on with the next steps from there. Never stop the setup because of it.',
    '- Before creating the access key, github.com asks to "Confirm access" (sudo mode): ask the person to confirm',
    '  by email, password or passkey, and wait.',
  ];
  const ghFallback = [
    '   Fallback for the access key, if the token page cannot be completed in either browser:',
    '   run  where gh  (install with: winget install --id GitHub.cli -e --accept-package-agreements',
    '   --accept-source-agreements), then',
    '   gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key --scopes repo',
    '   It prints a one-time code; tell the person the code and ask them to approve it on the page that opens.',
    '   Then  gh auth token  gives a key that works the same way. If the organization asks to approve the',
    '   GitHub CLI application, the person is the owner and can approve it in the organization settings.',
  ];
  const org = facts.repoUrl ? (new URL(facts.repoUrl).pathname.split('/').filter(Boolean)[0] || '<organization>') : '<organization>';
  if (facts.stage === 'join') {
    lines.push(
      'The GitHub account, the organization and the repository already exist: they were created on the first',
      `computer, and this file came from there (usually inside ${CARRY_ZIP}). This computer only needs its`,
      'own access key, and then it copies everything from the other one.',
      `  account: ${facts.githubLogin || 'the account the person already has'}`,
      `  organization: ${org}`,
      `  repository: ${facts.repoUrl}`,
      '',
      ...browserRule,
      '',
      'Steps:',
      '1. Tell the person you will connect this computer to the one they already use, and that you will ask them',
      '   to sign in to GitHub once.',
      '2. Open https://github.com/login and ask them to sign in with the account they created' + (facts.githubLogin ? ` (${facts.githubLogin}).` : '.'),
      '   Confirm they are signed in by opening https://github.com/settings/profile and reading the page.',
      '3. Create the access key for this computer. It is a classic key, so it reaches every repository of the',
      `   organization ${org}: when the repository fills up, the sync moves to a new one next to it by itself,`,
      '   and both computers have to reach that one too. Open:',
      `   https://github.com/settings/tokens/new?scopes=repo&description=claude-sync-${facts.hostname}`,
      '   In "Expiration" choose "No expiration", keep "repo" checked, and click "Generate token".',
      '4. Read the key from the page (it starts with ghp_ and appears only once). Never print it in the',
      '   conversation and never write it to a file.',
      ...ghFallback,
      `5. Run, with the key in place of <token>: "${self}" install --name "${label}" --token <token>`,
      '   The address of the repository is already inside this file, so there is nothing else to type.',
      '   A large history goes up and comes down in parts: the command can take several minutes and prints its',
      '   progress. If it says items are still to upload, that is normal and it finishes on its own.',
      `6. Run: "${self}" status`,
      '   "Tracked" must show more than zero files, "Health" must say ok, "Scheduled task" must say registered',
      '   (never DISABLED) and "Claude Code hooks" must say 4 of 4.',
      '7. Tell the person, in one or two sentences, that this computer now has the same memory, skills and',
      '   conversations as the other one, and that they should close and open VS Code once.',
    );
    return lines.join('\n');
  }
  lines.push(
    'Nothing exists yet: this is the first computer and it is the source of truth. Everything already on it',
    '(memory, skills, settings, conversations) is copied to the repository and later to the other computer.',
    'The person owns an organization on GitHub, and every repository of theirs lives inside it.',
    '',
    ...browserRule,
    '',
    'Steps:',
    '1. Tell the person you will create a free GitHub account for them, used only to carry their Claude Code',
    '   data between their two computers, and that you will ask them to type their email and a password.',
    '2. Open https://github.com/signup and go through it with them: email, password, username, the puzzle and',
    '   the code that arrives by email. "Continue with Google" also works and is faster if they have a Google',
    '   account. Wait until the account is ready, then read the login at https://github.com/settings/profile',
    '3. Create the organization, which will hold every repository of theirs. Open:',
    '   https://github.com/account/organizations/new?plan=free',
    '   Ask the person for a short name for it (their company or their surname). The name must be free on',
    '   GitHub: if it is taken, ask for another one and try again. Fill the contact email with theirs, choose',
    '   "My personal account" as the owner, and finish. Skip the invitation and survey screens.',
    '   Keep the organization name, it is used in the address of the repository.',
    '4. Create the repository inside the organization. Open:',
    '   https://github.com/organizations/<organization>/repositories/new',
    '   Type claude-sync in "Repository name", choose Private, leave every extra option unchecked, and click',
    '   "Create repository". Its address is https://github.com/<organization>/claude-sync',
    '5. Create the access key for this computer. It is a classic key, so it reaches every repository of the',
    '   organization: when the repository fills up, the sync moves to a new one next to it by itself, and',
    '   both computers have to reach that one too. Open:',
    `   https://github.com/settings/tokens/new?scopes=repo&description=claude-sync-${facts.hostname}`,
    '   In "Expiration" choose "No expiration", keep "repo" checked, and click "Generate token".',
    '6. Read the key from the page (it starts with ghp_ and appears only once). Never print it in the',
    '   conversation and never write it to a file.',
    ...ghFallback,
    `7. Run, with the values in place: "${self}" install --repo https://github.com/<organization>/claude-sync --name "${label}" --token <token>`,
    '   This copies this computer\'s Claude Code into the repository and turns on the automatic sync. A large',
    '   history goes up in parts and prints its progress; several minutes is normal, and anything left over',
    '   finishes by itself afterwards. The command refuses to upload anything if the repository is not private.',
    `8. Run: "${self}" remember --repo https://github.com/<organization>/claude-sync --login <login>`,
    '   This writes the address into this same file, so the other computer joins by itself, and saves the',
    `   package for the other computer on the Desktop: ${CARRY_ZIP} (this file and its documentation).`,
    `   If the person setting this up will use the SAME key on the other computer, add --carry-token to that`,
    '   command: the file then carries the key too and the other computer needs no browser step at all. From',
    '   that moment the file and the package are a key: never on a shared drive, never by email.',
    `9. Run: "${self}" status`,
    '   "Repository" must show the address, "Health" must say ok, "Scheduled task" must say registered (never',
    '   DISABLED) and "Claude Code hooks" must say 4 of 4.',
    '10. Tell the person, in one or two sentences, that their Claude Code now keeps itself saved and that their',
    '    other computer will receive everything on its own, and that they should close and open VS Code once.',
    `11. Tell the person that ${CARRY_ZIP}, on their Desktop, is what goes to the other computer: carry it`,
    '    there (USB drive or shared folder), unzip it, and ask Claude Code on that computer to run the',
    '    claude-sync.cmd inside it. If the file is not on the Desktop, run step 8 again, which saves it.',
  );
  return lines.join('\n');
}

// Opens a console window with Claude Code already holding the instruction. This is the only window the
// tool ever shows, and only when a person double clicks the file during setup.
function launchClaude(prompt) {
  const bin = claudeBin();
  if (!bin) return false;
  const [exe, head] = bin.endsWith('.js') ? [process.execPath, [bin]] : [bin, []];
  const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const command = `start "claude-sync" /D ${quote(HOME)} cmd /k ${[exe, ...head, prompt].map(quote).join(' ')}`;
  spawnSync('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: false, windowsVerbatimArguments: true });
  return true;
}

async function setup(args) {
  const facts = machineFacts();
  if (!facts.claudeDirExists) throw new Error(`Claude Code was never opened on this computer (${CLAUDE_DIR} does not exist)`);
  if (facts.stage === 'installed' && !args.force) {
    // Double clicking an installed computer is also how a person repairs it: triggers are put back.
    const state = loadState();
    const problems = ensureTriggers(state, true);
    saveState(state);
    if (problems.length) console.log(`Could not set up: ${problems.join('; ')}`);
    withLock(() => runSync({ verbose: true, skipTriggers: true }));
    console.log(statusText());
    return;
  }
  // Someone who already has the address and the access key (or a file carrying them) skips the browser.
  const repo = typeof args.repo === 'string' ? args.repo : facts.repoUrl;
  const token = typeof args.token === 'string' ? args.token : (CONFIG.carriedToken || process.env.CLAUDE_SYNC_TOKEN || '');
  if (repo && (token || facts.tokenStored) && !args.guide) {
    await install({ ...args, repo, token: token || undefined });
    return;
  }
  const runbook = runbookText(facts);
  if (insideClaude() || args.print) {
    console.log(runbook);
    return;
  }
  const prompt = `Run this command, exactly as written, and follow the SETUP RUNBOOK it prints, step by step, now: "${selfPath()}" setup --print`;
  if (launchClaude(prompt)) {
    console.log('Claude Code is opening in a new window and will do the setup with you. Follow it there.');
    return;
  }
  console.log(runbook);
  console.log('\nClaude Code was not found on this computer. Open VS Code, start Claude Code and ask it to run this file.');
}

function remember(args) {
  const repo = typeof args.repo === 'string' ? args.repo : (loadState()?.repoUrl || CONFIG.repoUrl);
  if (!repo) throw new Error('usage: remember --repo <https url> [--login <github login>] [--carry-token]');
  const patch = { repoUrl: repo, githubLogin: typeof args.login === 'string' ? args.login : CONFIG.githubLogin };
  if (args['carry-token']) {
    const token = typeof args.token === 'string' ? args.token : loadToken();
    if (!token) throw new Error('there is no access key stored on this computer to carry');
    patch.carriedToken = token;
  }
  writeConfig(patch, { includeScript: true });
  console.log(`Written into ${selfPath()}: repository ${repo}.`);
  if (announcePackage()) return;
  console.log('Take this file to the other computer as it is.');
  if (patch.carriedToken) console.log('This file now carries the access key as well: from here on treat the file itself as a key and do not leave it lying around.');
}

const USAGE = `claude-sync ${VERSION}
  (no command)                     guided setup: prints the runbook for Claude Code, or opens it
  setup [--print] [--force]        same as above
  install --repo <https url> --name <label> --token <token> [--support <name>] [--no-task]
  remember [--repo <https url>] [--login <github login>] [--carry-token]
  sync [--scan-programs] [--force] [--quiet] [--check-size]
  rotate [--yes] [--later] [--repo <https url>] [--keep-days <n>] [--keep-all]
  status
  uninstall
  hook <session-start|post-tool|stop|session-end>`;

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
try {
  if (command === 'install') await install(args);
  else if (command === 'setup' || command === undefined) await setup(args);
  else if (command === 'remember') remember(args);
  else if (command === 'rotate') await rotate(args);
  else if (command === 'sync') {
    const ran = withLock(() => runSync({ scanPrograms: !!args['scan-programs'], force: !!args.force }));
    if (ran) {
      // Asked of GitHub at most twice a day: the copy kept here is shallow and cannot tell how big the
      // repository really is, and this is what decides when to offer a move.
      const state = loadState();
      if (state && !state.uninstalledAt) await updateRepoSize(state, !!args['check-size']);
    }
    if (!args.quiet) console.log(ran ? statusText() : 'A sync is already running; it will run again when it finishes.');
  } else if (command === 'status') console.log(statusText());
  else if (command === 'hook') hook(args._[1]);
  else if (command === 'uninstall') uninstall();
  else { console.log(USAGE); process.exitCode = 1; }
} catch (e) {
  if (command === 'hook') process.exitCode = 0;
  else {
    console.error(`claude-sync: ${redact(e.message)}`);
    process.exitCode = 1;
  }
}
