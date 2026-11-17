#pragma once

#include <sstream>
#include <string>
#include <windows.h>

#include "include/cef_browser.h"

class LiveInput {
 public:
  bool Read(CefRefPtr<CefBrowserHost> host) {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD available = 0;
    if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) return false;
    if (!available) return true;
    char bytes[1024];
    DWORD read = 0;
    if (!ReadFile(input, bytes, (std::min)(available, static_cast<DWORD>(sizeof(bytes))), &read, nullptr)) return false;
    pending_.append(bytes, read);
    if (pending_.size() > 4096) return false;
    for (size_t end = pending_.find('\n'); end != std::string::npos; end = pending_.find('\n')) {
      const std::string line = pending_.substr(0, end);
      pending_.erase(0, end + 1);
      if (line == "quit") return false;
      Dispatch(host, line);
    }
    return true;
  }

  int mouse = 0;
  int key = 0;
  int ime = 0;

 private:
  void Dispatch(CefRefPtr<CefBrowserHost> host, const std::string& line) {
    std::istringstream input(line);
    std::string kind;
    std::string type;
    input >> kind >> type;
    if (kind == "mouse") {
      CefMouseEvent event;
      if (!(input >> event.x >> event.y)) return;
      if (type == "move") {
        host->SendMouseMoveEvent(event, false);
      } else {
        if (type == "down") event.modifiers = EVENTFLAG_LEFT_MOUSE_BUTTON;
        host->SendMouseClickEvent(event, MBT_LEFT, type == "up", 1);
      }
      ++mouse;
    } else if (kind == "key") {
      CefKeyEvent event;
      if (!(input >> event.windows_key_code)) return;
      event.type = type == "down" ? KEYEVENT_RAWKEYDOWN : KEYEVENT_KEYUP;
      event.native_key_code = (MapVirtualKeyW(event.windows_key_code, MAPVK_VK_TO_VSC) << 16) | 1;
      host->SendKeyEvent(event);
      ++key;
    } else if (kind == "ime") {
      std::wstring text;
      unsigned int unit;
      while (input >> std::hex >> unit) {
        if (unit > 0xffff) return;
        text.push_back(static_cast<wchar_t>(unit));
      }
      if (type == "commit") {
        host->ImeCommitText(text, CefRange(-1, -1), 0);
      } else {
        const auto length = static_cast<int>(text.size());
        host->ImeSetComposition(text, {}, CefRange(-1, -1), CefRange(length, length));
      }
      ++ime;
    }
  }

  std::string pending_;
};
