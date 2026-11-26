; Установщик помощника M-Link для Windows (NSIS). Собирается командой из build.sh:
;   makensis -DVERSION=1.3.0 -DSRC=<папка m-link-helper-windows-amd64> -DOUT=<файл .exe> installer.nsi
; Ставит помощник в папку пользователя (без прав администратора), чтобы он мог обновляться сам.
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "M-Link Helper"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\MLink"
BrandingText "M-Link ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "M-Link Helper"
VIAddVersionKey "FileDescription" "M-Link Helper Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "M-Link authors, MIT"

!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_WELCOMEPAGE_TITLE "$(WelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(WelcomeText)"
!define MUI_FINISHPAGE_TITLE "$(FinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(FinishText)"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

LangString WelcomeTitle ${LANG_RUSSIAN} "Помощник M-Link"
LangString WelcomeTitle ${LANG_ENGLISH} "M-Link Helper"
LangString WelcomeText ${LANG_RUSSIAN} "Небольшая программа с открытым кодом, через которую расширение M-Link подключает браузер к серверам VLESS, Hysteria2, XHTTP и другим.$\r$\n$\r$\nОна ставится в твою папку пользователя и дальше обновляется сама."
LangString WelcomeText ${LANG_ENGLISH} "A small open-source app that lets the M-Link browser extension connect to VLESS, Hysteria2, XHTTP and other servers.$\r$\n$\r$\nIt installs into your user folder and then updates itself."
LangString FinishTitle ${LANG_RUSSIAN} "Готово"
LangString FinishTitle ${LANG_ENGLISH} "Done"
LangString FinishText ${LANG_RUSSIAN} "Вернись в браузер и открой расширение M-Link: оно само увидит помощника. Если этого не произошло, перезапусти браузер."
LangString FinishText ${LANG_ENGLISH} "Open the M-Link extension in your browser: it will detect the helper. If it doesn't, restart the browser."

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MLinkHelper"

Function .onInit
  ; Язык установщика — по языку системы (русский для русской Windows, иначе английский).
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  ${If} $0 == 1049
    StrCpy $LANGUAGE ${LANG_RUSSIAN}
  ${Else}
    StrCpy $LANGUAGE ${LANG_ENGLISH}
  ${EndIf}
FunctionEnd

Section "Install"
  ; Помощник, запущенный браузером, держит свой файл: останавливаем его перед заменой.
  nsExec::Exec 'taskkill /IM m-link-helper.exe /F'
  SetOutPath "$INSTDIR"
  File "${SRC}\m-link-helper.exe"
  File "${SRC}\com.mlink.helper.json"
  File /nonfatal "${SRC}\sing-box.exe"
  File /nonfatal "${SRC}\xray.exe"
  File /nonfatal "${SRC}\libcronet.dll"
  File /nonfatal "${SRC}\LICENSE-sing-box.txt"
  File /nonfatal "${SRC}\LICENSE-xray.txt"
  File /nonfatal "${SRC}\THIRD_PARTY.txt"

  ; Регистрация для браузеров на Chromium (путь к манифесту помощника).
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.mlink.helper" "" "$INSTDIR\com.mlink.helper.json"
  WriteRegStr HKCU "Software\Chromium\NativeMessagingHosts\com.mlink.helper" "" "$INSTDIR\com.mlink.helper.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.mlink.helper" "" "$INSTDIR\com.mlink.helper.json"
  ; Регистрация прежней версии (M-Client) больше не нужна.
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.mclient.helper"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.mclient.helper"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.mclient.helper"

  ; Удаление через «Параметры → Приложения».
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "M-Link Helper"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "M-Link"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://github.com/Mag1c3R/m-link"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM m-link-helper.exe /F'
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.mlink.helper"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.mlink.helper"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.mlink.helper"
  DeleteRegKey HKCU "${UNINST_KEY}"
  ; Только наши файлы и папки: журнал и конфиг лежат в %APPDATA%\MLink.
  RMDir /r "$INSTDIR"
  RMDir /r "$APPDATA\MLink"
SectionEnd
