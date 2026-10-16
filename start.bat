@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==================================================
echo    SAP Cutover Agent
echo ==================================================
echo.

REM --- 1. Find Python 3 ---
set "PYEXE="
py -3 --version >nul 2>&1 && set "PYEXE=py -3"
if not defined PYEXE (
  python --version >nul 2>&1 && set "PYEXE=python"
)
if not defined PYEXE (
  echo  [X] Python 3 was not found.
  echo      Please install Python 3.10 or newer from:
  echo      https://www.python.org/downloads/   ^(tick "Add Python to PATH"^)
  echo      then double-click this file again.
  echo.
  pause
  exit /b 1
)
echo  [ok] Python found.

REM --- 2. Create local environment on first run ---
if not exist ".venv\Scripts\python.exe" (
  echo  [..] First run: creating local environment ^(one time^)...
  %PYEXE% -m venv .venv
)
set "VENVPY=.venv\Scripts\python.exe"

REM --- 3. Install dependencies once ---
if not exist ".venv\.deps_installed" (
  echo  [..] Installing components ^(one time, ~30-60 seconds^)...
  "%VENVPY%" -m pip install --upgrade pip >nul 2>&1
  "%VENVPY%" -m pip install -r "brain\requirements.txt"
  if errorlevel 1 (
    echo  [X] Could not install components. Check internet / proxy access and re-run.
    echo.
    pause
    exit /b 1
  )
  echo installed> ".venv\.deps_installed"
)
echo  [ok] Components ready.

REM --- 4. Reminder about Claude Code (needed for AI features) ---
echo.
echo  Note: the AI features need Claude Code installed and logged in.
echo        Everything else works without it.
echo.

REM --- 5. Open the browser shortly after the server starts ---
start "" cmd /c "timeout /t 4 >nul & start "" http://localhost:7878"

REM --- 6. Start the server (serves the app + API on port 7878) ---
echo  Opening the app at http://localhost:7878
echo  Keep this window open while using the app. Close it to stop.
echo ==================================================
echo.
cd brain
"..\.venv\Scripts\python.exe" -m uvicorn server:app --host 127.0.0.1 --port 7878
