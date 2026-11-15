@echo off
title Telsiz
cd /d "%~dp0"
node tools\serve.js --open
if errorlevel 1 pause
