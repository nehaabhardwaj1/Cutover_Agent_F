@echo off
REM SAP Cutover Agent — GUI Launcher
REM Double-click this file to open the Start/Stop control window.
REM The server runs silently in the background; no terminal stays open.

set "PYTHON=C:\Users\neha.a.bhardwaj\AppData\Local\Python\pythoncore-3.14-64\python.exe"
set "LAUNCHER=%~dp0launcher.py"

REM Launch the GUI without a console window
start "" "%PYTHON%" "%LAUNCHER%"
