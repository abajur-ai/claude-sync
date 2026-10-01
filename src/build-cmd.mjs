// Packs claude-sync.mjs into a single self-running claude-sync.cmd:
// double click runs it, Claude Code can read it, and the payload is extracted to run with node.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths are relative to this file, so the whole project folder can live anywhere.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'claude-sync.mjs');
const OUT = path.join(HERE, '..', 'claude-sync.cmd');
const MARKER = ':::CLAUDE-SYNC-PAYLOAD:::';

const header = [
  '@echo off',
  'rem  claude-sync: keeps Claude Code identical on both computers of the same person.',
  'rem',
  'rem  For Claude Code: run  "%~f0" setup --print  and follow the runbook it prints.',
  'rem  For a person: double click this file and follow what appears on the screen.',
  'rem',
  'setlocal enableextensions',
  'set "CLAUDE_SYNC_SELF=%~f0"',
  'set "NODE_EXE="',
  'for %%N in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:N"',
  'if not defined NODE_EXE if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles%\\nodejs\\node.exe"',
  'if not defined NODE_EXE if exist "%ProgramFiles(x86)%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\\nodejs\\node.exe"',
  'if not defined NODE_EXE if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE_EXE=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"',
  'if not defined NODE_EXE if exist "%USERPROFILE%\\.claude-sync\\node\\node.exe" set "NODE_EXE=%USERPROFILE%\\.claude-sync\\node\\node.exe"',
  'if not defined NODE_EXE (',
  '  echo Node.js nao foi encontrado neste computador, e o claude-sync precisa dele.',
  '  echo Instale com este comando e rode este arquivo de novo:',
  '  echo   winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements',
  '  if "%~1"=="" pause',
  '  exit /b 1',
  ')',
  'set "CLAUDE_SYNC_BOOT=%TEMP%\\claude-sync-boot-%RANDOM%%RANDOM%.mjs"',
  'del "%CLAUDE_SYNC_BOOT%" >nul 2>&1',
  // The whole extraction is one try/catch: a read that fails must not leave an empty file behind that
  // then runs as an empty program and reports success.
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $t=[IO.File]::ReadAllText($env:CLAUDE_SYNC_SELF); $i=$t.LastIndexOf(\'' + MARKER + '\'); if ($i -lt 0) { throw \'marker not found\' }; $p=$t.Substring($t.IndexOf([char]10,$i)+1); if ($p.Length -lt 10000) { throw \'payload too small\' }; [IO.File]::WriteAllText($env:CLAUDE_SYNC_BOOT,$p,(New-Object Text.UTF8Encoding($false))) } catch { exit 1 }"',
  'set "BOOT_OK="',
  'for %%A in ("%CLAUDE_SYNC_BOOT%") do if %%~zA GTR 10000 set "BOOT_OK=1"',
  'if not defined BOOT_OK (',
  '  del "%CLAUDE_SYNC_BOOT%" >nul 2>&1',
  '  echo Nao foi possivel preparar o arquivo claude-sync. Copie o arquivo para a area de trabalho e rode de novo.',
  '  if "%~1"=="" pause',
  '  exit /b 1',
  ')',
  '"%NODE_EXE%" "%CLAUDE_SYNC_BOOT%" %*',
  'set "CLAUDE_SYNC_EXIT=%ERRORLEVEL%"',
  'del "%CLAUDE_SYNC_BOOT%" >nul 2>&1',
  'if "%~1"=="" pause',
  'exit /b %CLAUDE_SYNC_EXIT%',
  '',
  MARKER,
].join('\r\n');

const payload = fs.readFileSync(SRC, 'utf8');
fs.writeFileSync(OUT, `${header}\r\n${payload}`, 'utf8');
const version = /^const VERSION = (\d+);$/m.exec(payload)[1];
console.log(`claude-sync.cmd written, version ${version}, ${fs.statSync(OUT).size} bytes`);
