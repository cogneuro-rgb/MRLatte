; Custom install page: optional, separately-checkable file associations for
; .nii and .gz. electron-builder's own `build.fileAssociations` config (see
; package.json) registers unconditionally with no UI, so this replaces that
; mechanism with a real choice — .gz in particular makes MRLatte the default
; handler for EVERY .gz file on the system, not just compressed NIfTI, so it
; must not be silently opted into.
;
; Auto-picked up by electron-builder: it looks for build-resources/installer.nsh
; by convention (no `nsis.include` config needed). `FileAssociation.nsh`'s
; include dir is already on the NSIS search path (added unconditionally by
; NsisTarget's computeCommonInstallerScriptHeader), so it resolves here even
; though `build.fileAssociations` is no longer set.
!include "nsDialogs.nsh"
!include "FileAssociation.nsh"

!macro customPageAfterChangeDir
  Page custom MRLatteAssocPageCreate MRLatteAssocPageLeave
!macroend

; electron-builder compiles this file into BOTH the installer and the
; standalone uninstaller executable. customPageAfterChangeDir/customInstall
; are only ever !insertmacro'd on the installer side (assistedInstaller.nsh's
; `!ifndef BUILD_UNINSTALLER` branch resp. installSection.nsh), so these vars
; and Functions go unreferenced on the uninstaller pass — NSIS treats an
; unreferenced Var or Function as a fatal warning ("not referenced" / "wasting
; memory" -> "warning treated as error"), so none of it can be compiled in
; that pass at all.
!ifndef BUILD_UNINSTALLER
Var Dialog
Var CheckboxNii
Var CheckboxGz
Var AssocNiiState
Var AssocGzState

Function MRLatteAssocPageCreate
  ; No MUI_HEADER_TEXT here: this file is !include'd by electron-builder
  ; early, in the common script header, before MUI2.nsh itself is included
  ; later in the assembled script — insertmacro-ing an MUI2 macro from here
  ; fails to resolve at compile time ("macro named MUI_HEADER_TEXT not
  ; found"). The label text below stands in for a page header instead.
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0u 100% 12u "Choose which file types MRLatte should open by default:"
  Pop $0

  ${NSD_CreateCheckbox} 0 20u 100% 12u "Open .nii files with MRLatte"
  Pop $CheckboxNii
  ${NSD_Check} $CheckboxNii

  ${NSD_CreateCheckbox} 0 40u 100% 12u "Open .nii.gz / .gz files with MRLatte"
  Pop $CheckboxGz

  ${NSD_CreateLabel} 0 64u 100% 40u "Registering .gz makes MRLatte the default handler for ALL .gz files on this system, not just compressed NIfTI images. Uninstalling MRLatte restores whatever previously handled it. Leave unchecked if you use another tool for general .gz files."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function MRLatteAssocPageLeave
  ${NSD_GetState} $CheckboxNii $AssocNiiState
  ${NSD_GetState} $CheckboxGz $AssocGzState
FunctionEnd
!endif

!macro customInstall
  ${If} $AssocNiiState == ${BST_CHECKED}
    !insertmacro APP_ASSOCIATE "nii" "MRLatte.NIfTI" "NIfTI Image" "$appExe,0" "Open with MRLatte" "$\"$appExe$\" $\"%1$\""
  ${EndIf}
  ${If} $AssocGzState == ${BST_CHECKED}
    !insertmacro APP_ASSOCIATE "gz" "MRLatte.NIfTIGz" "Compressed NIfTI Image (.nii.gz)" "$appExe,0" "Open with MRLatte" "$\"$appExe$\" $\"%1$\""
  ${EndIf}
  !insertmacro UPDATEFILEASSOC
!macroend

; Only unassociate an extension if MRLatte is STILL its current handler —
; if the checkbox was left off at install, we never touched it, and blindly
; unassociating would wipe out whatever the user actually has (e.g. another
; NIfTI viewer, or 7-Zip for .gz) rather than restoring it.
!macro customUnInstall
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.nii" ""
  ${If} $0 == "MRLatte.NIfTI"
    !insertmacro APP_UNASSOCIATE "nii" "MRLatte.NIfTI"
  ${EndIf}
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.gz" ""
  ${If} $0 == "MRLatte.NIfTIGz"
    !insertmacro APP_UNASSOCIATE "gz" "MRLatte.NIfTIGz"
  ${EndIf}
  !insertmacro UPDATEFILEASSOC
!macroend
