@echo off
chcp 65001 >nul
set HOST_NAME=com.mclient.helper
taskkill /IM m-client-helper.exe /F >nul 2>&1
for %%K in (
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"
  "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_NAME%"
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%"
) do reg delete %%K /f >nul 2>&1
rmdir /S /Q "%LOCALAPPDATA%\MClient"
rem Журнал и config.json помощника лежат в %APPDATA%\MClient.
rmdir /S /Q "%APPDATA%\MClient" >nul 2>&1
echo Помощник удалён.
pause
