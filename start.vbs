Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\java_workspace\BaoFlashBrowser"
WshShell.Run "npm start", 0, False
