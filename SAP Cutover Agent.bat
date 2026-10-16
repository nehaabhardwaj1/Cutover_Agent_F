@echo off
REM SAP Cutover Agent — GUI Launcher
REM Double-click this file to open the Start/Stop control window.
REM The server runs silently in the background; no terminal stays open.

REM Python resolution: CUTOVER_PYTHON override, then the standard per-user
REM install location, then PATH. No absolute user path is committed.
set "PYTHON=%CUTOVER_PYTHON%"
if not defined PYTHON set "PYTHON=%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe"
if not exist "%PYTHON%" set "PYTHON=python"
set "LAUNCHER=%~dp0launcher.py"

REM Launch the GUI without a console window
start "" "%PYTHON%" "%LAUNCHER%"
