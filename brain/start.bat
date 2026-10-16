@echo off
title SAP Cutover Brain — Server

REM ╔══════════════════════════════════════════════════════╗
REM ║  PASTE YOUR ANTHROPIC API KEY ON THE LINE BELOW     ║
REM ╚══════════════════════════════════════════════════════╝
set ANTHROPIC_API_KEY=PASTE-YOUR-KEY-HERE

set BRAIN_DB=%~dp0brain.db
set BRAIN_VECTORS=%~dp0brain-vectors
set BRAIN_DATA=%~dp0data

echo ============================================
echo   SAP Cutover Brain Server
echo   http://localhost:7878
echo ============================================
echo.
echo Starting server... (keep this window open)
echo.

cd /d "%~dp0"
REM Python resolution: CUTOVER_PYTHON override, then the standard per-user
REM install location, then PATH. No absolute user path is committed.
set "PYTHON=%CUTOVER_PYTHON%"
if not defined PYTHON set "PYTHON=%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe"
if not exist "%PYTHON%" set "PYTHON=python"

"%PYTHON%" -m uvicorn server:app --host 0.0.0.0 --port 7878

echo.
echo Server stopped.
pause
