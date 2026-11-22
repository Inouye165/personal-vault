!include "x64.nsh"
!include "LogicLib.nsh"

!macro _PvCheckVcRuntimeDlls _outVar
  StrCpy ${_outVar} "1"
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
    IfFileExists "$WINDIR\System32\vcruntime140.dll" +2 0
      StrCpy ${_outVar} "0"
    IfFileExists "$WINDIR\System32\vcruntime140_1.dll" +2 0
      StrCpy ${_outVar} "0"
    IfFileExists "$WINDIR\System32\msvcp140.dll" +2 0
      StrCpy ${_outVar} "0"
    IfFileExists "$WINDIR\System32\msvcp140_1.dll" +2 0
      StrCpy ${_outVar} "0"
    IfFileExists "$WINDIR\System32\msvcp140_atomic_wait.dll" +2 0
      StrCpy ${_outVar} "0"
    ${EnableX64FSRedirection}
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro _PvCheckVcRuntimeDlls $0
  ${If} $0 == "0"
    InitPluginsDir
    File "/oname=$PLUGINSDIR\vc_redist.x64.exe" "${PROJECT_DIR}\build\vc_redist.x64.exe"
    DetailPrint "Installing Microsoft Visual C++ 2015-2022 Redistributable (x64)..."
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $1
    ${If} $1 == 740
      ExecShellWait "runas" "$PLUGINSDIR\vc_redist.x64.exe" "/install /quiet /norestart"
      !insertmacro _PvCheckVcRuntimeDlls $0
      ${If} $0 == "1"
        StrCpy $1 "0"
      ${EndIf}
    ${EndIf}
    ${If} $1 == 3010
      SetRebootFlag true
    ${ElseIf} $1 != 0
    ${AndIf} $1 != 1638
      DetailPrint "Microsoft Visual C++ 2015-2022 Redistributable (x64) failed with exit code $1."
      Abort "Microsoft Visual C++ 2015-2022 Redistributable (x64) installation failed (exit code $1)."
    ${EndIf}

    !insertmacro _PvCheckVcRuntimeDlls $0
    ${If} $0 == "0"
      Abort "Microsoft Visual C++ 2015-2022 Redistributable (x64) DLLs are still missing after installation."
    ${EndIf}
  ${EndIf}
!macroend
