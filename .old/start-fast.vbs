Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\java_workspace\BaoFlashBrowser"
WshShell.Run "npx electron .", 0, False
