#define NOMINMAX
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
static_assert(sizeof(void*) == 4, "Win32 Tesseract sidecar must be x86");
namespace {

constexpr std::uint32_t kMaxHeaderBytes = 64 * 1024;
constexpr std::uint32_t kMaxBitmapBytes = 64 * 1024 * 1024;
int g_protocol_output = -1;

#ifdef _WIN32
int duplicate_fd(int descriptor) { return ::_dup(descriptor); }
int replace_fd(int source, int destination) { return ::_dup2(source, destination); }
int write_fd(int descriptor, const char *data, unsigned int size) {
  return ::_write(descriptor, data, size);
}
constexpr int kStdoutFd = 1;
constexpr int kStderrFd = 2;
#else
int duplicate_fd(int descriptor) { return ::dup(descriptor); }
int replace_fd(int source, int destination) { return ::dup2(source, destination); }
ssize_t write_fd(int descriptor, const char *data, std::size_t size) {
  return ::write(descriptor, data, size);
}
constexpr int kStdoutFd = STDOUT_FILENO;
constexpr int kStderrFd = STDERR_FILENO;
#endif

void write_protocol(const std::string &message) {
  const std::string frame = message + '\n';
  std::size_t written = 0;
  while (written < frame.size()) {
    const auto remaining = frame.size() - written;
#ifdef _WIN32
    const auto chunk = static_cast<unsigned int>(
        std::min<std::size_t>(remaining, std::numeric_limits<unsigned int>::max()));
#else
    const auto chunk = remaining;
#endif
    const auto result = write_fd(g_protocol_output, frame.data() + written, chunk);
    if (result < 0 && errno == EINTR) continue;
    if (result <= 0) throw std::runtime_error("protocol output failed");
    written += static_cast<std::size_t>(result);
  }
}

bool read_exact(std::istream &stream, char *destination, std::size_t size) {
  stream.read(destination, static_cast<std::streamsize>(size));
  return static_cast<std::size_t>(stream.gcount()) == size;
}

std::uint32_t read_u32_le(const unsigned char *bytes) {
  return static_cast<std::uint32_t>(bytes[0]) |
         (static_cast<std::uint32_t>(bytes[1]) << 8U) |
         (static_cast<std::uint32_t>(bytes[2]) << 16U) |
         (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

std::uint64_t parse_unsigned(const std::string &json, const std::string &key) {
  const auto key_pos = json.find('"' + key + '"');
  if (key_pos == std::string::npos) throw std::runtime_error("missing header field: " + key);
  const auto colon = json.find(':', key_pos + key.size() + 2);
  if (colon == std::string::npos) throw std::runtime_error("invalid header field: " + key);
  const auto start = json.find_first_not_of(" \t\r\n", colon + 1);
  if (start == std::string::npos || json[start] < '0' || json[start] > '9') {
    throw std::runtime_error("invalid numeric header field: " + key);
  }
  std::size_t consumed = 0;
  const auto value = std::stoull(json.substr(start), &consumed, 10);
  if (consumed == 0) throw std::runtime_error("invalid numeric header field: " + key);
  return value;
}

std::string parse_string(const std::string &json, const std::string &key) {
  const auto key_pos = json.find('"' + key + '"');
  if (key_pos == std::string::npos) throw std::runtime_error("missing header field: " + key);
  const auto colon = json.find(':', key_pos + key.size() + 2);
  const auto quote = colon == std::string::npos ? std::string::npos : json.find('"', colon + 1);
  if (quote == std::string::npos) throw std::runtime_error("invalid string header field: " + key);
  const auto end = json.find('"', quote + 1);
  if (end == std::string::npos) throw std::runtime_error("invalid string header field: " + key);
  return json.substr(quote + 1, end - quote - 1);
}

std::string json_escape(const std::string &value) {
  std::ostringstream output;
  for (const unsigned char byte : value) {
    switch (byte) {
      case '"': output << "\\\""; break;
      case '\\': output << "\\\\"; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (byte < 0x20) {
          static constexpr char digits[] = "0123456789abcdef";
          output << "\\u00" << digits[(byte >> 4U) & 0x0fU] << digits[byte & 0x0fU];
        } else {
          output << static_cast<char>(byte);
        }
    }
  }
  return output.str();
}

class Tesseract {
  HMODULE library_ = nullptr;
  template<class T> T load(const char* name) {
    auto function = GetProcAddress(library_, name);
    if (!function) throw std::runtime_error(std::string("missing Tesseract API: ") + name);
    return reinterpret_cast<T>(function);
  }
public:
  void* api = nullptr;
  void* (__cdecl *create)();
  int (__cdecl *init)(void*, const char*, const char*);
  void (__cdecl *destroy)(void*);
  void (__cdecl *clear)(void*);
  void (__cdecl *set_mode)(void*, int);
  void (__cdecl *set_image)(void*, const unsigned char*, int, int, int, int);
  int (__cdecl *recognize)(void*, void*);
  void* (__cdecl *iterator)(void*);
  void (__cdecl *delete_iterator)(void*);
  int (__cdecl *next)(void*, int);
  char* (__cdecl *text)(const void*, int);
  float (__cdecl *confidence)(const void*, int);
  void* (__cdecl *page_iterator)(void*);
  int (__cdecl *box)(const void*, int, int*, int*, int*, int*);
  void (__cdecl *delete_text)(const char*);

  Tesseract() {
    library_ = LoadLibraryW(L"libtesseract-5.dll");
    if (!library_) throw std::runtime_error("could not load x86 Tesseract runtime");
#define BIND(member, symbol) member = load<decltype(member)>(symbol)
    BIND(create, "TessBaseAPICreate"); BIND(init, "TessBaseAPIInit3");
    BIND(destroy, "TessBaseAPIDelete"); BIND(clear, "TessBaseAPIClear");
    BIND(set_mode, "TessBaseAPISetPageSegMode"); BIND(set_image, "TessBaseAPISetImage");
    BIND(recognize, "TessBaseAPIRecognize"); BIND(iterator, "TessBaseAPIGetIterator");
    BIND(delete_iterator, "TessResultIteratorDelete"); BIND(next, "TessResultIteratorNext");
    BIND(text, "TessResultIteratorGetUTF8Text"); BIND(confidence, "TessResultIteratorConfidence");
    BIND(page_iterator, "TessResultIteratorGetPageIterator"); BIND(box, "TessPageIteratorBoundingBox");
    BIND(delete_text, "TessDeleteText");
#undef BIND
    api = create();
    if (!api || init(api, "tessdata", "chi_sim+eng") != 0) throw std::runtime_error("Tesseract model initialization failed");
    set_mode(api, 6); // The evaluated text-block mode: ordinary UI text and numbers.
  }
  ~Tesseract() { if (api) destroy(api); if (library_) FreeLibrary(library_); }

  std::string run(std::uint64_t id, const std::vector<unsigned char>& bgra, int width, int height) {
    std::vector<unsigned char> rgb(bgra.size() / 4 * 3);
    for (std::size_t pixel = 0, target = 0; pixel < bgra.size(); pixel += 4, target += 3) {
      rgb[target] = bgra[pixel + 2]; rgb[target + 1] = bgra[pixel + 1]; rgb[target + 2] = bgra[pixel];
    }
    set_image(api, rgb.data(), width, height, 3, width * 3);
    auto reset = std::unique_ptr<void, decltype(clear)>(api, clear);
    if (recognize(api, nullptr) != 0) throw std::runtime_error("Tesseract recognition failed");
    void* result = iterator(api);
    auto cleanup = std::unique_ptr<void, decltype(delete_iterator)>(result, delete_iterator);
    std::ostringstream output;
    output << "{\"type\":\"result\",\"id\":" << id << ",\"items\":[";
    bool first = true;
    if (result) do {
      constexpr int kTextLine = 2;
      char* value = text(result, kTextLine);
      auto release = std::unique_ptr<const char, decltype(delete_text)>(value, delete_text);
      int left = 0, top = 0, right = 0, bottom = 0;
      if (!value || !*value || !box(page_iterator(result), kTextLine, &left, &top, &right, &bottom)) continue;
      left = std::clamp(left, 0, width); right = std::clamp(right, 0, width);
      top = std::clamp(top, 0, height); bottom = std::clamp(bottom, 0, height);
      if (right <= left || bottom <= top) continue;
      const float raw_score = confidence(result, kTextLine) / 100.f;
      const float score = std::isfinite(raw_score) ? std::clamp(raw_score, 0.f, 1.f) : 0.f;
      if (!first) output << ',';
      first = false;
      output << "{\"text\":\"" << json_escape(value) << "\",\"score\":" << score
        << ",\"box\":[[" << left << ',' << top << "],[" << right << ',' << top
        << "],[" << right << ',' << bottom << "],[" << left << ',' << bottom << "]]}";
    } while (next(result, 2));
    output << "]}";
    return output.str();
  }
};
} // namespace

int main() {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  _putenv_s("OMP_THREAD_LIMIT", "1");
  SetDllDirectoryW(L""); // Dependencies resolve beside the executable, not from the working directory.
  std::ios::sync_with_stdio(false); std::cin.tie(nullptr);
  g_protocol_output = duplicate_fd(kStdoutFd);
  if (g_protocol_output < 0 || replace_fd(kStderrFd, kStdoutFd) < 0) return 1;
  try {
    Tesseract engine;
    write_protocol("{\"type\":\"ready\",\"protocol\":1,\"provider\":\"tesseract\",\"model\":\"chi_sim+eng\"}");
    while (true) {
      unsigned char prefix[12];
      if (!read_exact(std::cin, reinterpret_cast<char*>(prefix), sizeof(prefix))) return 0;
      if (std::memcmp(prefix, "BAO1", 4) != 0) throw std::runtime_error("invalid protocol magic");
      const auto header_size = read_u32_le(prefix + 4), bitmap_size = read_u32_le(prefix + 8);
      if (!header_size || header_size > kMaxHeaderBytes || bitmap_size > kMaxBitmapBytes) throw std::runtime_error("invalid protocol frame size");
      std::string header(header_size, '\0'); std::vector<unsigned char> pixels(bitmap_size);
      if (!read_exact(std::cin, header.data(), header.size()) || !read_exact(std::cin, reinterpret_cast<char*>(pixels.data()), pixels.size())) return 0;
      std::uint64_t id = 0;
      try {
        id = parse_unsigned(header, "id");
        const auto width = parse_unsigned(header, "width"), height = parse_unsigned(header, "height");
        if (parse_string(header, "format") != "bgra" || !width || !height ||
          width > static_cast<std::uint64_t>(std::numeric_limits<int>::max()) ||
          height > static_cast<std::uint64_t>(std::numeric_limits<int>::max()) || width * height * 4ULL != bitmap_size)
          throw std::runtime_error("invalid bitmap header");
        write_protocol(engine.run(id, pixels, static_cast<int>(width), static_cast<int>(height)));
      } catch (const std::exception& error) {
        write_protocol("{\"type\":\"error\",\"id\":" + std::to_string(id) + ",\"error\":\"" + json_escape(error.what()) + "\"}");
      }
    }
  } catch (const std::exception& error) {
    std::cerr << "Tesseract sidecar failed: " << error.what() << std::endl;
    return 1;
  }
}

