// BaoFlashBrowser PaddleOCR sidecar.
// PaddleOCR deployment sources are supplied from a pinned official release checkout.

#include <include/args.h>
#include <include/paddleocr.h>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <chrono>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#else
#include <unistd.h>
#endif

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

int configured_threads() {
  const char *raw = std::getenv("BAO_OCR_THREADS");
  if (!raw || !*raw) return 4;
  try { return std::max(1, std::min(16, std::stoi(raw))); }
  catch (...) { return 4; }
}

void configure_paddle() {
  FLAGS_use_gpu = false;
  FLAGS_use_tensorrt = false;
  FLAGS_cpu_threads = configured_threads();
  FLAGS_enable_mkldnn = true;
  FLAGS_precision = "fp32";
  FLAGS_det = true;
  FLAGS_rec = true;
  FLAGS_cls = false;
  FLAGS_use_angle_cls = false;
  FLAGS_det_model_dir = "models/ch_PP-OCRv3_det_infer";
  FLAGS_rec_model_dir = "models/ch_PP-OCRv3_rec_infer";
  FLAGS_rec_char_dict_path = "models/dict_chinese.txt";
  FLAGS_limit_type = "max";
  FLAGS_limit_side_len = 960;
  FLAGS_det_db_thresh = 0.3;
  FLAGS_det_db_box_thresh = 0.6;
  FLAGS_det_db_unclip_ratio = 1.5;
#ifdef _WIN32
  // PaddleOCR-json 1.4.1 defaults to polygon scoring. Keep Windows output
  // parity while changing only the transport/lifecycle boundary.
  FLAGS_det_db_score_mode = "slow";
#else
  FLAGS_det_db_score_mode = "fast";
#endif
  FLAGS_use_dilation = false;
  FLAGS_rec_batch_num = 6;
  FLAGS_rec_img_h = 48;
  FLAGS_rec_img_w = 320;
}

std::string result_json(std::uint64_t id,
                        const std::vector<PaddleOCR::OCRPredictResult> &results,
                        double elapsed_ms) {
  std::ostringstream output;
  output.precision(8);
  output << "{\"type\":\"result\",\"id\":" << id << ",\"items\":[";
  for (std::size_t index = 0; index < results.size(); ++index) {
    if (index) output << ',';
    const auto &result = results[index];
    output << "{\"text\":\"" << json_escape(result.text) << "\",\"score\":"
           << (std::isfinite(result.score) ? result.score : 0.0) << ",\"box\":[";
    for (std::size_t point_index = 0; point_index < result.box.size(); ++point_index) {
      if (point_index) output << ',';
      const auto &point = result.box[point_index];
      const int x = point.empty() ? 0 : point[0];
      const int y = point.size() < 2 ? 0 : point[1];
      output << '[' << x << ',' << y << ']';
    }
    output << "]}";
  }
  output << "],\"timings\":{\"ocrMs\":" << elapsed_ms << "}}";
  return output.str();
}

} // namespace

int main() {
#ifdef _WIN32
  // BAO1 carries raw bytes. Text-mode CRLF translation corrupts both the frame
  // prefix and BGRA payload on Windows.
  ::_setmode(::_fileno(stdin), _O_BINARY);
  ::_setmode(::_fileno(stdout), _O_BINARY);
#endif
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  // Paddle and oneDNN emit initialization diagnostics to stdout. Keep the
  // inherited stdout descriptor exclusively for BAO1 JSON and route every
  // library diagnostic to stderr for the lifetime of the process.
  g_protocol_output = duplicate_fd(kStdoutFd);
  if (g_protocol_output < 0 || replace_fd(kStderrFd, kStdoutFd) < 0) {
    std::cerr << "PaddleOCR sidecar could not isolate protocol output" << std::endl;
    return 1;
  }
  configure_paddle();

  try {
    PaddleOCR::PPOCR engine;
    write_protocol("{\"type\":\"ready\",\"protocol\":1,\"provider\":\"paddle-inference\","
                   "\"model\":\"PP-OCRv3\"}");

    while (true) {
      unsigned char prefix[12];
      if (!read_exact(std::cin, reinterpret_cast<char *>(prefix), sizeof(prefix))) return 0;
      if (std::memcmp(prefix, "BAO1", 4) != 0) throw std::runtime_error("invalid protocol magic");
      const auto header_size = read_u32_le(prefix + 4);
      const auto bitmap_size = read_u32_le(prefix + 8);
      if (header_size == 0 || header_size > kMaxHeaderBytes || bitmap_size > kMaxBitmapBytes) {
        throw std::runtime_error("invalid protocol frame size");
      }
      std::string header(header_size, '\0');
      std::vector<unsigned char> pixels(bitmap_size);
      if (!read_exact(std::cin, header.data(), header.size()) ||
          !read_exact(std::cin, reinterpret_cast<char *>(pixels.data()), pixels.size())) return 0;

      std::uint64_t id = 0;
      try {
        id = parse_unsigned(header, "id");
        const auto width64 = parse_unsigned(header, "width");
        const auto height64 = parse_unsigned(header, "height");
        if (parse_string(header, "format") != "bgra" || width64 == 0 || height64 == 0 ||
            width64 > static_cast<std::uint64_t>(std::numeric_limits<int>::max()) ||
            height64 > static_cast<std::uint64_t>(std::numeric_limits<int>::max()) ||
            width64 * height64 * 4ULL != bitmap_size) {
          throw std::runtime_error("invalid bitmap header");
        }
        cv::Mat bgra(static_cast<int>(height64), static_cast<int>(width64), CV_8UC4, pixels.data());
        cv::Mat bgr;
        cv::cvtColor(bgra, bgr, cv::COLOR_BGRA2BGR);
        const auto started = std::chrono::steady_clock::now();
        const auto results = engine.ocr(bgr, true, true, false);
        const auto elapsed = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - started).count();
        write_protocol(result_json(id, results, elapsed));
      } catch (const std::exception &error) {
        write_protocol("{\"type\":\"error\",\"id\":" + std::to_string(id) +
                       ",\"error\":\"" + json_escape(error.what()) + "\"}");
      }
    }
  } catch (const std::exception &error) {
    std::cerr << "PaddleOCR sidecar startup failed: " << error.what() << std::endl;
    return 1;
  }
}
