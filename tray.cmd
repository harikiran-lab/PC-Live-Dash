@echo off
rem Starts the PC Live Dash system tray app without keeping a console window open.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tray.ps1"
