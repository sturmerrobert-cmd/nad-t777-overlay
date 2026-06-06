@echo off
chcp 65001 >nul
title Diagnostyka NAD T 777
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nad-diag.ps1"
pause
