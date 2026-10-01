// Shared setup for the test suite: where the tool is, where the sandboxes go, which Claude Code binary
// to drive and which throwaway GitHub repository to use. Nothing here is tied to one computer or to one
// account: paths come from this folder, the rest comes from the environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT = path.resolve(HERE, '..');
export const TOOL = path.join(PROJECT, 'src', 'claude-sync.mjs');
export const INSTALLER = path.join(PROJECT, 'claude-sync.cmd');

// Sandboxes are throwaway: they live in the system temp folder and are wiped by each run.
export const sandbox = (name) => path.join(process.env.CLAUDE_SYNC_TEST_ROOT || path.join(os.tmpdir(), 'claude-sync-tests'), name);

// The Claude Code CLI: the editor extension first, then the PATH.
export function claudeBin() {
  if (process.env.CLAUDE_SYNC_CLAUDE_BIN) return process.env.CLAUDE_SYNC_CLAUDE_BIN;
  const home = os.homedir();
  const version = (n) => (n.match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const dir = path.join(home, editor, 'extensions');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    const found = names.filter((n) => n.toLowerCase().startsWith('anthropic.claude-code-'))
      .sort((a, b) => { const x = version(a); const y = version(b); return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]); })
      .map((n) => path.join(dir, n, 'resources', 'native-binary', 'claude.exe'))
      .find((p) => fs.existsSync(p));
    if (found) return found;
  }
  const where = spawnSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true });
  const onPath = (where.stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l));
  if (onPath) return onPath;
  throw new Error('Claude Code CLI not found; set CLAUDE_SYNC_CLAUDE_BIN');
}

// A private GitHub repository used only by the tests: it is deleted and recreated on every run, so it
// must never be a repository anyone cares about.
export function testRepo(suffix = '') {
  const slug = process.env.CLAUDE_SYNC_TEST_REPO;
  if (!slug || !slug.includes('/')) {
    throw new Error('set CLAUDE_SYNC_TEST_REPO to <owner>/<name> of a throwaway private repository (it is deleted and recreated on every run)');
  }
  return suffix ? `${slug}-${suffix}` : slug;
}

export function testToken() {
  if (process.env.CLAUDE_SYNC_TEST_TOKEN) return process.env.CLAUDE_SYNC_TEST_TOKEN;
  const r = spawnSync('gh auth token', { encoding: 'utf8', windowsHide: true, shell: true });
  const token = (r.stdout || '').trim();
  if (!token) throw new Error('no GitHub token: sign in with "gh auth login" or set CLAUDE_SYNC_TEST_TOKEN');
  return token;
}

// The key each computer is installed with. In a real setup every computer has its own classic key with
// only the "repo" scope, while the test itself uses the broader key above to create and delete its
// repositories. CLAUDE_SYNC_TEST_MACHINE_TOKEN_FILES names one file per computer, comma separated;
// without it every computer uses the test key.
export function machineToken(index) {
  const files = (process.env.CLAUDE_SYNC_TEST_MACHINE_TOKEN_FILES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!files.length) return testToken();
  return fs.readFileSync(files[index % files.length], 'utf8').replace(/["\s]/g, '');
}

// Every key a test could have handed out, so a check for a leaked key covers all of them.
export function allTokens() {
  const n = (process.env.CLAUDE_SYNC_TEST_MACHINE_TOKEN_FILES || '').split(',').filter((s) => s.trim()).length;
  return [...new Set([testToken(), ...Array.from({ length: n }, (_, i) => machineToken(i))])];
}

// A second real Windows computer for the end to end test. Everything about it comes from the
// environment, so the test says what it needs instead of assuming one machine.
export function secondMachine() {
  const { CLAUDE_SYNC_VM_VMX: vmx, CLAUDE_SYNC_VM_USER: user, CLAUDE_SYNC_VM_PASSWORD: pass } = process.env;
  if (!vmx || !user || !pass) return null;
  const vmrun = process.env.CLAUDE_SYNC_VMRUN || 'C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe';
  const args = ['-T', 'ws'];
  if (process.env.CLAUDE_SYNC_VM_ENCRYPTION_PASSWORD) args.push('-vp', process.env.CLAUDE_SYNC_VM_ENCRYPTION_PASSWORD);
  args.push('-gu', user, '-gp', pass);
  return { vmrun, vmx, args, user, home: `C:\\Users\\${user}` };
}
