@echo off
chcp 65001 >nul
setlocal
set "FV_PY=C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%FV_PY%" (
  "%FV_PY%" "%~dp0开发源码\launcher.py"
  exit /b
)
where python >nul 2>nul
if not errorlevel 1 (
  python "%~dp0开发源码\launcher.py"
  exit /b
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 "%~dp0开发源码\launcher.py"
  exit /b
)
echo Python 3 is required for the local backend.
echo Open admin.html for offline editing, or frontend.html for display.
pause
