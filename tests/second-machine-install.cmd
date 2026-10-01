@echo off
rem Runs on the second machine during the end to end test. It unzips the package the first computer left
rem on its Desktop and installs claude-sync from the .cmd inside it, with a PATH that has nothing but
rem Windows itself plus the portable Node and Git in C:\Users\Public\ccsync, which is how a computer where
rem neither tool is installed system wide behaves.
rem   %1  the label for this computer
set "PATH=C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0;C:\Users\Public\ccsync\node;C:\Users\Public\ccsync\git\cmd"
echo === where node / git ===
where node
where git
echo === remove what an earlier run left ===
if exist "%USERPROFILE%\.claude-sync\claude-sync.cmd" call "%USERPROFILE%\.claude-sync\claude-sync.cmd" uninstall
if exist "%USERPROFILE%\Desktop\claude-sync" rd /s /q "%USERPROFILE%\Desktop\claude-sync"
echo === unzip the package ===
powershell -NoProfile -Command "Expand-Archive -LiteralPath \"$env:USERPROFILE\Desktop\claude-sync-computer-2.zip\" -DestinationPath \"$env:USERPROFILE\Desktop\" -Force"
echo UNZIP_EXIT=%ERRORLEVEL%
echo === install ===
call "%USERPROFILE%\Desktop\claude-sync\claude-sync.cmd" install --name %1
echo INSTALL_EXIT=%ERRORLEVEL%
echo === status ===
call "%USERPROFILE%\.claude-sync\claude-sync.cmd" status
echo DONE
