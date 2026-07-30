Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = "D:\java_workspace\BaoFlashBrowser"
ws.Run "cmd /c npx electron .", 0, False
