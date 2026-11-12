@echo off
chcp 65001 >nul
rem Удаление помощника M-Link: программа, регистрация в браузерах, журнал и конфиг.
if "%LOCALAPPDATA%"=="" exit /b 1
if "%APPDATA%"=="" exit /b 1
taskkill /IM m-link-helper.exe /F >nul 2>&1
taskkill /IM m-client-helper.exe /F >nul 2>&1
for %%K in (
  "HKCU\Software\Google\Chrome\NativeMessagingHosts"
  "HKCU\Software\Chromium\NativeMessagingHosts"
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts"
) do (
  reg delete "%%~K\com.mlink.helper" /f >nul 2>&1
  reg delete "%%~K\com.mclient.helper" /f >nul 2>&1
)
for %%D in ("%LOCALAPPDATA%\MLink" "%APPDATA%\MLink" "%LOCALAPPDATA%\MClient" "%APPDATA%\MClient") do (
  if exist "%%~D" rmdir /S /Q "%%~D" >nul 2>&1
)
echo Помощник M-Link удалён.
pause
