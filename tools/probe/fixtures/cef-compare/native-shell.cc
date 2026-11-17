#include <windows.h>
#include <shellapi.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <vector>

#include "shared-frame.h"
#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_version.h"

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

class ShellClient : public CefClient,
                    public CefDisplayHandler,
                    public CefLifeSpanHandler {
 public:
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }

  bool OnConsoleMessage(CefRefPtr<CefBrowser>, cef_log_severity_t,
                        const CefString& message, const CefString&, int) override {
    if (message == "bao-css-ok") ready = true;
    return false;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser>) override { closed = true; }

  bool ready = false;
  bool closed = false;

 private:
  IMPLEMENT_REFCOUNTING(ShellClient);
};

bool DrawFrame(HWND panel, const unsigned char* pixels) {
  BITMAPINFO bitmap{};
  bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bitmap.bmiHeader.biWidth = kWidth;
  bitmap.bmiHeader.biHeight = -kHeight;
  bitmap.bmiHeader.biPlanes = 1;
  bitmap.bmiHeader.biBitCount = 32;
  HDC dc = GetDC(panel);
  if (!dc) return false;
  const int rows = StretchDIBits(dc, 0, 0, kWidth, kHeight, 0, 0, kWidth, kHeight,
                                pixels, &bitmap, DIB_RGB_COLORS, SRCCOPY);
  ReleaseDC(panel, dc);
  return rows == kHeight;
}

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int) {
  CefMainArgs args(instance);
  const int subprocess = CefExecuteProcess(args, nullptr, nullptr);
  if (subprocess >= 0) return subprocess;
  int argc = 0;
  auto** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv || argc != 5) {
    if (argv) LocalFree(argv);
    return 2;
  }
  const std::wstring mapping_name = argv[1];
  const std::wstring url = argv[2];
  const fs::path profile = argv[3];
  const fs::path output = argv[4];
  LocalFree(argv);

  CefSettings settings;
  settings.no_sandbox = true;
  CefString(&settings.root_cache_path) = profile.wstring();
  CefString(&settings.cache_path) = profile.wstring();
  CefString(&settings.log_file) = (output / "shell.log").wstring();
  if (!CefInitialize(args, settings, nullptr, nullptr)) return 3;

  WNDCLASSW window_class{};
  window_class.lpfnWndProc = DefWindowProcW;
  window_class.hInstance = instance;
  window_class.lpszClassName = L"BaoCefComparison";
  RegisterClassW(&window_class);
  HWND window = CreateWindowExW(0, window_class.lpszClassName, L"Bao CEF comparison",
                                WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                                CW_USEDEFAULT, CW_USEDEFAULT, 600, 570,
                                nullptr, nullptr, instance, nullptr);
  HWND panel = CreateWindowExW(0, L"STATIC", nullptr, WS_CHILD | WS_VISIBLE,
                               0, 64, kWidth, kHeight, window, nullptr, instance, nullptr);
  CefWindowInfo info;
  info.SetAsChild(window, CefRect(0, 0, kWidth, 64));
  CefBrowserSettings browser_settings;
  CefRefPtr<ShellClient> client = new ShellClient;
  auto browser = CefBrowserHost::CreateBrowserSync(info, client, url, browser_settings, nullptr, nullptr);
  if (!browser || !panel) {
    client = nullptr;
    DestroyWindow(window);
    CefShutdown();
    return 4;
  }
  ShowWindow(window, SW_SHOWNOACTIVATE);

  const auto deadline = Clock::now() + 15s;
  std::vector<unsigned char> frame(kFrameBytes);
  std::vector<unsigned int> centers;
  HANDLE mapping = nullptr;
  const SharedFrame* shared = nullptr;
  LONG last_generation = 0;
  bool ready_written = false;
  bool drew_all = true;
  while (centers.size() < 4 && Clock::now() < deadline) {
    CefDoMessageLoopWork();
    if (client->ready && !ready_written) {
      std::ofstream(output / "ready").put('1');
      ready_written = true;
    }
    if (ready_written && !mapping) {
      mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, mapping_name.c_str());
      if (mapping) shared = static_cast<const SharedFrame*>(MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, sizeof(SharedFrame)));
    }
    if (shared) {
      const LONG generation = shared->generation;
      MemoryBarrier();
      if (generation != last_generation && !(generation & 1)) {
        memcpy(frame.data(), shared->pixels, frame.size());
        MemoryBarrier();
        if (generation == shared->generation) {
          last_generation = generation;
          drew_all = DrawFrame(panel, frame.data()) && drew_all;
          const size_t p = (210 * kWidth + 250) * 4;
          centers.push_back((frame[p + 2] << 16) | (frame[p + 1] << 8) | frame[p]);
        }
      }
    }
    Sleep(5);
  }

  {
    std::ofstream report(output / "shell.json");
    report << "{\"cef\":\"" << CEF_VERSION << "\",\"modernCss\":" << client->ready
           << ",\"drawn\":" << drew_all << ",\"centers\":[";
    for (size_t i = 0; i < centers.size(); ++i) {
      if (i) report << ',';
      report << centers[i];
    }
    report << "]}\n";
  }
  if (shared) UnmapViewOfFile(shared);
  if (mapping) CloseHandle(mapping);
  browser->GetHost()->CloseBrowser(true);
  browser = nullptr;
  const auto close_deadline = Clock::now() + 3s;
  while (!client->closed && Clock::now() < close_deadline) {
    CefDoMessageLoopWork();
    Sleep(5);
  }
  client = nullptr;
  DestroyWindow(window);
  CefShutdown();
  return 0;
}
