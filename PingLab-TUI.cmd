@echo off
chcp 65001 >nul
title PingLab
cd /d "%~dp0"
node "%~dp0pinglab.mjs" %*
if errorlevel 1 pause
