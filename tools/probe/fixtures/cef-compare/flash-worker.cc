#include <windows.h>
#include <shellapi.h>
#include <d3d11.h>
#include <wrl/client.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <vector>

#include "shared-frame.h"
#include "live-input.h"

#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_request_context_handler.h"
#include "include/cef_version.h"

using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

class FlashApp : public CefApp {
 public:
  explicit FlashApp(const std::wstring& plugin) : plugin_(plugin) {}

  void OnBeforeCommandLineProcessing(const CefString& type,
                                     CefRefPtr<CefCommandLine> args) override {
    if (!type.empty()) return;
    args->AppendSwitchWithValue("ppapi-flash-path", plugin_);
    args->AppendSwitchWithValue("ppapi-flash-version", "34.0.0.330");
    args->AppendSwitchWithValue("plugin-policy", "allow");
    args->AppendSwitch("allow-outdated-plugins");
    args->AppendSwitch("ignore-gpu-blacklist");
    args->AppendSwitchWithValue("use-angle", "d3d11");
  }

 private:
  std::wstring plugin_;
  IMPLEMENT_REFCOUNTING(FlashApp);
};

class FlashContext : public CefRequestContextHandler {
 public:
  bool OnBeforePluginLoad(const CefString& mime_type, const CefString&, bool,
                          const CefString&, CefRefPtr<CefWebPluginInfo>,
                          PluginPolicy* policy) override {
    if (mime_type != "application/x-shockwave-flash") return false;
    *policy = PLUGIN_POLICY_ALLOW;
    return true;
  }

 private:
  IMPLEMENT_REFCOUNTING(FlashContext);
};

class FlashClient : public CefClient,
                    public CefRenderHandler,
                    public CefLoadHandler,
                    public CefDisplayHandler,
                    public CefLifeSpanHandler {
 public:
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }

  bool OnConsoleMessage(CefRefPtr<CefBrowser>, cef_log_severity_t,
                        const CefString& message, const CefString&, int) override {
    if (message == "bao-ime-composition") ime_composition = true;
    if (message == "bao-ime-committed") ime_committed = true;
    if (message == "bao-flash-ime-committed") flash_ime_committed = true;
    return false;
  }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }

  void GetViewRect(CefRefPtr<CefBrowser>, CefRect& rect) override {
    rect = CefRect(0, 0, view_width, view_height);
  }

  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int) override {
    if (frame->IsMain()) loaded = true;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser>) override { closed = true; }

  void OnPaint(CefRefPtr<CefBrowser>, PaintElementType type, const RectList&,
               const void* buffer, int width, int height) override {
    if (type != PET_VIEW || width != view_width || height != view_height) return;
    ++bitmap_frames;
    const auto* data = static_cast<const unsigned char*>(buffer);
    if (live_frame) {
      Publish(live_frame, data, width * height * 4);
      if (frame_notification) {
        const char ready = '\n';
        DWORD written = 0;
        if (!WriteFile(frame_notification, &ready, 1, &written, nullptr)) frame_notification = nullptr;
      }
    } else {
      pixels.assign(data, data + width * height * 4);
    }
  }

  void OnAcceleratedPaint(CefRefPtr<CefBrowser>, PaintElementType type,
                          const RectList&, void* handle) override {
    if (type != PET_VIEW) return;
    ++texture_frames;
    shared_handle = handle;
  }

  bool ReadTexture() {
    if (!shared_handle) return false;
    if (!device) {
      result = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                 D3D11_SDK_VERSION, &device, nullptr, &context);
      if (FAILED(result)) return false;
    }
    ComPtr<ID3D11Texture2D> source;
    result = device->OpenSharedResource(shared_handle, IID_PPV_ARGS(&source));
    if (FAILED(result)) return false;

    D3D11_TEXTURE2D_DESC desc{};
    source->GetDesc(&desc);
    texture_format = desc.Format;
    if (desc.Width != kWidth || desc.Height != kHeight) return false;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.BindFlags = 0;
    desc.MiscFlags = 0;

    ComPtr<ID3D11Texture2D> staging;
    result = device->CreateTexture2D(&desc, nullptr, &staging);
    if (FAILED(result)) return false;
    context->CopyResource(staging.Get(), source.Get());

    D3D11_MAPPED_SUBRESOURCE mapped{};
    result = context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(result)) return false;
    pixels.resize(kWidth * kHeight * 4);
    for (int y = 0; y < kHeight; ++y) {
      const auto* row = static_cast<const unsigned char*>(mapped.pData) + y * mapped.RowPitch;
      memcpy(pixels.data() + y * kWidth * 4, row, kWidth * 4);
    }
    context->Unmap(staging.Get(), 0);
    return true;
  }

  bool Save(const fs::path& path, bool accelerated, SharedFrame* shared) {
    if (accelerated && !ReadTexture()) return false;
    if (pixels.empty()) return false;
    if (shared) Publish(shared, pixels.data(), pixels.size());
    BITMAPFILEHEADER file{};
    BITMAPINFOHEADER info{};
    file.bfType = 0x4d42;
    file.bfOffBits = sizeof(file) + sizeof(info);
    file.bfSize = file.bfOffBits + static_cast<DWORD>(pixels.size());
    info.biSize = sizeof(info);
    info.biWidth = kWidth;
    info.biHeight = -kHeight;
    info.biPlanes = 1;
    info.biBitCount = 32;
    auto image = std::ofstream(path, std::ios::binary);
    image.write(reinterpret_cast<const char*>(&file), sizeof(file));
    image.write(reinterpret_cast<const char*>(&info), sizeof(info));
    image.write(reinterpret_cast<const char*>(pixels.data()), pixels.size());
    return image.good();
  }

  int view_width = kWidth;
  int view_height = kHeight;
  SharedFrame* live_frame = nullptr;
  HANDLE frame_notification = nullptr;
  bool ime_composition = false;
  bool ime_committed = false;
  bool flash_ime_committed = false;
  bool loaded = false;
  bool closed = false;
  int bitmap_frames = 0;
  int texture_frames = 0;
  int texture_format = 0;
  HRESULT result = S_OK;
  void* shared_handle = nullptr;

 private:
  static void Publish(SharedFrame* shared, const unsigned char* data, size_t size) {
    InterlockedIncrement(&shared->generation);
    memcpy(shared->pixels, data, size);
    InterlockedIncrement(&shared->generation);
  }

  std::vector<unsigned char> pixels;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  IMPLEMENT_REFCOUNTING(FlashClient);
};

template <typename Predicate>
void PumpFor(Clock::duration timeout, Predicate done) {
  const auto deadline = Clock::now() + timeout;
  while (!done() && Clock::now() < deadline) {
    CefDoMessageLoopWork();
    Sleep(5);
  }
}

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int) {
  CefMainArgs args(instance);
  const int subprocess = CefExecuteProcess(args, nullptr, nullptr);
  if (subprocess >= 0) return subprocess;
  int argc = 0;
  auto** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv || (argc != 6 && argc != 7)) {
    if (argv) LocalFree(argv);
    return 2;
  }
  const std::wstring plugin = argv[1];
  const std::wstring url = argv[2];
  const fs::path profile = argv[3];
  const fs::path output = argv[4];
  const std::wstring mode = argv[5];
  const bool accelerated = mode == L"texture";
  const bool live_game = mode == L"live-game";
  const bool live = mode == L"live" || live_game;
  HANDLE mapping = nullptr;
  SharedFrame* shared = nullptr;
  if (argc == 7) {
    mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                 0, sizeof(SharedFrame), argv[6]);
    if (mapping) shared = static_cast<SharedFrame*>(MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, sizeof(SharedFrame)));
    if (!shared) {
      if (mapping) CloseHandle(mapping);
      LocalFree(argv);
      return 5;
    }
  }
  LocalFree(argv);

  CefSettings settings;
  settings.no_sandbox = true;
  settings.windowless_rendering_enabled = true;
  CefString(&settings.cache_path) = profile.wstring();
  CefString(&settings.log_file) = (output / "cef.log").wstring();
  if (!CefInitialize(args, settings, new FlashApp(plugin), nullptr)) return 3;

  CefWindowInfo info;
  info.SetAsWindowless(nullptr);
  info.shared_texture_enabled = accelerated;
  CefBrowserSettings browser_settings;
  browser_settings.windowless_frame_rate = 60;
  CefRefPtr<FlashClient> client = new FlashClient;
  if (live) {
    client->live_frame = shared;
    const HANDLE notification = GetStdHandle(STD_OUTPUT_HANDLE);
    if (GetFileType(notification) == FILE_TYPE_PIPE) client->frame_notification = notification;
  }
  if (live_game) {
    client->view_width = kGameWidth;
    client->view_height = kGameHeight;
  }
  CefRequestContextSettings context_settings;
  CefString(&context_settings.cache_path) = profile.wstring();
  auto request_context = CefRequestContext::CreateContext(context_settings, new FlashContext);
  auto preference = CefValue::Create();
  preference->SetInt(1);
  CefString error;
  request_context->SetPreference("profile.default_content_setting_values.plugins", preference, error);
  auto browser = CefBrowserHost::CreateBrowserSync(info, client, url, browser_settings, nullptr, request_context);
  request_context = nullptr;
  if (!browser) {
    client = nullptr;
    CefShutdown();
    return 4;
  }

  auto host = browser->GetHost();
  if (live) {
    host->SendFocusEvent(true);
    LiveInput input;
    PumpFor(40s, [&] { return !input.Read(host); });
    std::ofstream report(output / "worker.json");
    report << "{\"cef\":\"" << CEF_VERSION << "\",\"bitmapFrames\":" << client->bitmap_frames
           << ",\"mouseCommands\":" << input.mouse << ",\"keyCommands\":" << input.key
           << ",\"imeCommands\":" << input.ime << ",\"imeComposition\":" << client->ime_composition
           << ",\"imeCommitted\":" << client->ime_committed << ",\"flashImeCommitted\":" << client->flash_ime_committed << "}\n";
    client->live_frame = nullptr;
  } else {
    PumpFor(8s, [&] { return client->loaded && (client->bitmap_frames || client->texture_frames); });
    PumpFor(1s, [] { return false; });
    const bool before = client->Save(output / "before.bmp", accelerated, shared);
    host->SendFocusEvent(true);
    CefMouseEvent mouse;
    mouse.x = 250;
    mouse.y = 210;
    host->SendMouseMoveEvent(mouse, false);
    PumpFor(400ms, [] { return false; });
    const bool hover = client->Save(output / "hover.bmp", accelerated, shared);
    host->SendMouseClickEvent(mouse, MBT_LEFT, false, 1);
    PumpFor(400ms, [] { return false; });
    const bool pressed = client->Save(output / "pressed.bmp", accelerated, shared);
    host->SendMouseClickEvent(mouse, MBT_LEFT, true, 1);
    PumpFor(400ms, [] { return false; });
    const bool released = client->Save(output / "released.bmp", accelerated, shared);
    {
      std::ofstream report(output / "worker.json");
      report << "{\"cef\":\"" << CEF_VERSION << "\",\"loaded\":" << client->loaded
             << ",\"bitmapFrames\":" << client->bitmap_frames
             << ",\"textureFrames\":" << client->texture_frames
             << ",\"textureFormat\":" << client->texture_format
             << ",\"d3dResult\":" << client->result
             << ",\"saved\":[" << before << ',' << hover << ',' << pressed << ',' << released << "]}\n";
    }
  }
  if (shared) {
    if (!live) PumpFor(800ms, [] { return false; });
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
  }
  host->CloseBrowser(true);
  host = nullptr;
  browser = nullptr;
  PumpFor(3s, [&] { return client->closed; });
  client = nullptr;
  CefShutdown();
  return 0;
}
