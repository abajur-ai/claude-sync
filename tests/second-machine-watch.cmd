@echo off
rem Runs on the second machine during the end to end test. It starts the window watcher on the desktop the
rem person sees and returns at once. The watcher runs under a headless console host, the same way the sync
rem itself runs, so the test puts no window of its own on the screen it is watching.
rem   %1  how many seconds to watch
rem   %2  the file the watcher writes to
start "" conhost.exe --headless powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Public\ccsync\watch-windows.ps1 %1 %2
