@echo off
title Telsiz - GitHub'a gonder
cd /d "%~dp0"
echo.
echo  Telsiz GitHub'a gonderiliyor.
echo  Bir GitHub giris penceresi acilirsa giris yapip izin verin.
echo.

git push -u origin main
if errorlevel 1 goto hata

set SPLIT=
for /f %%i in ('git subtree split --prefix app main') do set SPLIT=%%i
if "%SPLIT%"=="" goto hata
git push -f origin %SPLIT%:refs/heads/gh-pages
if errorlevel 1 goto hata

echo.
echo  TAMAM. Gonderim bitti. Bu pencereyi kapatabilirsiniz.
echo.
pause
exit /b 0

:hata
echo.
echo  HATA: Gonderim tamamlanamadi. Yukaridaki mesaji Claude'a iletin.
echo.
pause
exit /b 1
