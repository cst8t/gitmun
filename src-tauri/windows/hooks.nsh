; NSIS installer hooks for Gitmun
;
; NSIS_HOOK_PREINSTALL: verify git is installed, offering to download it if not.
; Git is not bundled - it is fetched from the official Git for Windows releases.

!macro NSIS_HOOK_PREINSTALL
  StrCpy $R0 "0"  ; R0 = 1 once git is confirmed present

  ; Check HKLM registry (system-wide Git for Windows install)
  ReadRegStr $0 HKLM "SOFTWARE\GitForWindows" "InstallPath"
  ${If} $0 != ""
    StrCpy $R0 "1"
  ${EndIf}

  ; Check HKCU registry (per-user Git for Windows install)
  ${If} $R0 == "0"
    ReadRegStr $0 HKCU "SOFTWARE\GitForWindows" "InstallPath"
    ${If} $0 != ""
      StrCpy $R0 "1"
    ${EndIf}
  ${EndIf}

  ; Fall back to PATH check via where.exe
  ${If} $R0 == "0"
    nsExec::ExecToStack 'cmd.exe /c "where git >nul 2>&1"'
    Pop $0
    Pop $1
    ${If} $0 == 0
      StrCpy $R0 "1"
    ${EndIf}
  ${EndIf}

  ${If} $R0 == "0"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Git is required by Gitmun but was not found on this system.$\r$\n$\r$\nWould you like to download and install Git for Windows now?" \
      IDYES download_git IDNO skip_git

    download_git:
      ; Write a small PowerShell script to a temp file to avoid inline quote escaping
      FileOpen $R2 "$TEMP\gitmun_get_git.ps1" w
      FileWrite $R2 '$$ProgressPreference = "SilentlyContinue"$\r$\n'
      FileWrite $R2 '$$release = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest"$\r$\n'
      FileWrite $R2 '$$asset = $$release.assets | Where-Object { $$_.name -match "Git-.*-64-bit\.exe" } | Select-Object -First 1$\r$\n'
      FileWrite $R2 'if (-not $$asset) { exit 1 }$\r$\n'
      FileWrite $R2 'Invoke-WebRequest -Uri $$asset.browser_download_url -OutFile "$TEMP\GitInstaller.exe" -UseBasicParsing$\r$\n'
      FileClose $R2

      DetailPrint "Downloading Git for Windows (this may take a moment)..."
      nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\gitmun_get_git.ps1"'
      Pop $0
      Pop $1
      Delete "$TEMP\gitmun_get_git.ps1"

      ${If} $0 == 0
        DetailPrint "Installing Git for Windows..."
        ExecWait '"$TEMP\GitInstaller.exe" /VERYSILENT /NORESTART /NOCANCEL /SP-'
        Delete "$TEMP\GitInstaller.exe"
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION \
          "Could not download Git for Windows.$\r$\nPlease install it manually from https://git-scm.com/download/win"
      ${EndIf}
      Goto git_done

    skip_git:
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "Gitmun requires Git to function.$\r$\nPlease install it from https://git-scm.com/download/win before using Gitmun."

    git_done:
  ${EndIf}
!macroend
