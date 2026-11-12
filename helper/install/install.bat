@echo off
chcp 65001 >nul
rem Установка помощника M-Link для Windows. Запуск двойным щелчком.
set HOST_NAME=com.mclient.helper
set EXT_ID=aghdgobidfiogibjlpfhdegieiaiakgm
if not "%~1"=="" set EXT_ID=%~1
set DEST=%LOCALAPPDATA%\MClient

if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%~dp0m-client-helper.exe" "%DEST%\m-client-helper.exe" >nul || goto :error
if exist "%~dp0sing-box.exe" copy /Y "%~dp0sing-box.exe" "%DEST%\sing-box.exe" >nul
if exist "%~dp0libcronet.dll" copy /Y "%~dp0libcronet.dll" "%DEST%\libcronet.dll" >nul

rem На Windows путь в манифесте может быть относительным к самому манифесту.
(
  echo {
  echo   "name": "%HOST_NAME%",
  echo   "description": "M-Link helper",
  echo   "path": "m-client-helper.exe",
  echo   "type": "stdio",
  echo   "allowed_origins": ["chrome-extension://%EXT_ID%/"]
  echo }
) > "%DEST%\%HOST_NAME%.json"

for %%K in (
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"
  "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_NAME%"
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%"
) do reg add %%K /ve /t REG_SZ /d "%DEST%\%HOST_NAME%.json" /f >nul

echo Помощник установлен в %DEST%
if not exist "%DEST%\sing-box.exe" echo Внимание: положи sing-box.exe в %DEST%
echo Готово. Перезапусти браузер.
pause
exit /b 0

:error
echo Не удалось скопировать файлы. Запусти install.bat из распакованной папки.
pause
exit /b 1
