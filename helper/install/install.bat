@echo off
chcp 65001 >nul
rem Установка помощника M-Link для Windows. Запуск двойным щелчком.
set HOST_NAME=com.mlink.helper
set OLD_HOST_NAME=com.mclient.helper
if "%LOCALAPPDATA%"=="" goto :error
set DEST=%LOCALAPPDATA%\MLink

if not exist "%~dp0m-link-helper.exe" goto :error
if not exist "%DEST%" mkdir "%DEST%"
rem Если помощник сейчас запущен браузером, его файл занят: останавливаем перед копированием.
taskkill /IM m-link-helper.exe /F >nul 2>&1
copy /Y "%~dp0m-link-helper.exe" "%DEST%\m-link-helper.exe" >nul || goto :error
copy /Y "%~dp0%HOST_NAME%.json" "%DEST%\%HOST_NAME%.json" >nul || goto :error
if exist "%~dp0sing-box.exe" copy /Y "%~dp0sing-box.exe" "%DEST%\sing-box.exe" >nul
if exist "%~dp0libcronet.dll" copy /Y "%~dp0libcronet.dll" "%DEST%\libcronet.dll" >nul
rem Снимаем с файлов отметку «скачано из интернета», иначе Windows может не дать их запустить.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'MLink') | Unblock-File" >nul 2>&1

for %%K in (
  "HKCU\Software\Google\Chrome\NativeMessagingHosts"
  "HKCU\Software\Chromium\NativeMessagingHosts"
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts"
) do (
  reg add "%%~K\%HOST_NAME%" /ve /t REG_SZ /d "%DEST%\%HOST_NAME%.json" /f >nul
  reg delete "%%~K\%OLD_HOST_NAME%" /f >nul 2>&1
)
rem Убираем папки прежней версии (M-Client).
if exist "%LOCALAPPDATA%\MClient\m-client-helper.exe" rmdir /S /Q "%LOCALAPPDATA%\MClient" >nul 2>&1
if exist "%APPDATA%\MClient\helper.log" rmdir /S /Q "%APPDATA%\MClient" >nul 2>&1

echo Помощник M-Link установлен в %DEST%
if not exist "%DEST%\sing-box.exe" echo Внимание: положи sing-box.exe в %DEST%
echo Готово. Открой расширение M-Link и нажми «Проверить».
pause
exit /b 0

:error
echo Не удалось скопировать файлы. Сначала распакуй архив целиком, затем запусти install.bat из распакованной папки.
pause
exit /b 1
