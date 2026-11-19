Quick Novel Translator (STV) - Windows Companion for VieNeu-TTS
=================================================================

[Tieng Viet]
1. Neu ban CHUA cai VieNeu-TTS tren may:
   Mo PowerShell trong thu muc nay va chay:
     .\setup_vieneu.bat <EXTENSION_ID>

2. Neu ban DA cai VieNeu-TTS roi (chi muon bat/tat server tu Popup Extension):
   Mo PowerShell trong thu muc nay va chay:
     .\install_host.bat <EXTENSION_ID>

   Sau khi chay thanh cong, file host duoc luu co dinh tai:
   %LOCALAPPDATA%\STV-VieNeu\host
   Ban co the xoa thu muc giai nen nay neu muon.

3. Go cai dat Native Host:
   Chay file: uninstall_host.bat

[English]
1. Fresh install (installs tools, clones VieNeu-TTS, registers Native Host):
   Run in PowerShell inside this folder:
     .\setup_vieneu.bat <EXTENSION_ID>

2. Already installed VieNeu-TTS (register 1-click Start/Stop host only):
   Run in PowerShell inside this folder:
     .\install_host.bat <EXTENSION_ID>

3. Uninstall Native Host:
   Run: uninstall_host.bat
