#pragma once

#include <string>
#include <vector>

// PaddleOCR's inference wrapper references AutoLogger only from its optional
// benchmark_log method. Bao measures requests at the protocol boundary, so the
// upstream network-fetched AutoLog dependency is intentionally replaced by a
// no-op build-time shim.
class AutoLogger {
public:
  AutoLogger(const std::string &, bool, bool, bool, int, int,
             const std::string &, const std::string &,
             const std::vector<double> &, int) {}
  void report() const {}
};
