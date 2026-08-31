// Copyright (c) 2020 PaddlePaddle Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// This is the subset of PaddleOCR release/2.7 Utility used by the raw-BGRA
// BaoFlashBrowser sidecar. Visualization and file-image helpers are omitted so
// the runtime does not pull OpenCV codecs, OpenGL, X11, TIFF, JPEG or WebP.

#include <include/utility.h>

#include <cmath>
#include <cstdint>
#include <fstream>
#include <stdexcept>
#include <sys/stat.h>

namespace PaddleOCR {

std::vector<std::string> Utility::ReadDict(const std::string &path) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("no such label file: " + path);
  std::vector<std::string> values;
  std::string line;
  while (std::getline(input, line)) values.push_back(line);
  return values;
}

cv::Mat Utility::GetRotateCropImage(const cv::Mat &source,
                                    std::vector<std::vector<int>> box) {
  int xs[4] = {box[0][0], box[1][0], box[2][0], box[3][0]};
  int ys[4] = {box[0][1], box[1][1], box[2][1], box[3][1]};
  const int left = *std::min_element(xs, xs + 4);
  const int right = *std::max_element(xs, xs + 4);
  const int top = *std::min_element(ys, ys + 4);
  const int bottom = *std::max_element(ys, ys + 4);
  cv::Mat crop;
  source(cv::Rect(left, top, right - left, bottom - top)).copyTo(crop);
  for (auto &point : box) {
    point[0] -= left;
    point[1] -= top;
  }
  const int width = static_cast<int>(std::sqrt(
      std::pow(box[0][0] - box[1][0], 2) + std::pow(box[0][1] - box[1][1], 2)));
  const int height = static_cast<int>(std::sqrt(
      std::pow(box[0][0] - box[3][0], 2) + std::pow(box[0][1] - box[3][1], 2)));
  cv::Point2f destination[4] = {{0.f, 0.f}, {static_cast<float>(width), 0.f},
                               {static_cast<float>(width), static_cast<float>(height)},
                               {0.f, static_cast<float>(height)}};
  cv::Point2f points[4] = {
      {static_cast<float>(box[0][0]), static_cast<float>(box[0][1])},
      {static_cast<float>(box[1][0]), static_cast<float>(box[1][1])},
      {static_cast<float>(box[2][0]), static_cast<float>(box[2][1])},
      {static_cast<float>(box[3][0]), static_cast<float>(box[3][1])}};
  cv::Mat output;
  cv::warpPerspective(crop, output, cv::getPerspectiveTransform(points, destination),
                      cv::Size(width, height), cv::BORDER_REPLICATE);
  if (static_cast<float>(output.rows) >= static_cast<float>(output.cols) * 1.5f) {
    cv::transpose(output, output);
    cv::flip(output, output, 0);
  }
  return output;
}

std::vector<int> Utility::argsort(const std::vector<float> &array) {
  std::vector<int> indices(array.size());
  std::iota(indices.begin(), indices.end(), 0);
  std::sort(indices.begin(), indices.end(),
            [&array](int left, int right) { return array[left] < array[right]; });
  return indices;
}

bool Utility::PathExists(const std::string &path) {
#ifdef _WIN32
  struct _stat value;
  return _stat(path.c_str(), &value) == 0;
#else
  struct stat value;
  return stat(path.c_str(), &value) == 0;
#endif
}

std::string Utility::pathjoin(const std::string &parent, const std::string &child) {
  if (parent.empty()) return child;
  if (child.empty()) return parent;
#ifdef _WIN32
  constexpr char separator = '\\';
#else
  constexpr char separator = '/';
#endif
  const bool parent_has_separator = parent.back() == '/' || parent.back() == '\\';
  const std::size_t child_start = (child.front() == '/' || child.front() == '\\') ? 1 : 0;
  return parent + (parent_has_separator ? "" : std::string(1, separator)) + child.substr(child_start);
}

void Utility::sorted_boxes(std::vector<OCRPredictResult> &results) {
  std::sort(results.begin(), results.end(), Utility::comparison_box);
#ifdef _WIN32
  // Preserve PaddleOCR-json 1.4.1's observable ordering on Windows.  The
  // upstream implementation intentionally swaps the outer-loop pair here;
  // changing this to the seemingly more natural scan pair changes the text
  // concatenation order for dense, multi-line screenshots.
  if (!results.empty()) {
    for (std::size_t index = 0; index + 1 < results.size(); ++index) {
      for (int scan = static_cast<int>(index); scan >= 0; --scan) {
        if (std::abs(results[scan + 1].box[0][1] - results[scan].box[0][1]) < 10 &&
            results[scan + 1].box[0][0] < results[scan].box[0][0]) {
          std::swap(results[index], results[index + 1]);
        }
      }
    }
  }
#else
  for (std::size_t index = 0; index + 1 < results.size(); ++index) {
    for (int scan = static_cast<int>(index); scan >= 0; --scan) {
      if (std::abs(results[scan + 1].box[0][1] - results[scan].box[0][1]) < 10 &&
          results[scan + 1].box[0][0] < results[scan].box[0][0]) {
        std::swap(results[scan], results[scan + 1]);
      }
    }
  }
#endif
}

float Utility::fast_exp(float value) {
  union { std::uint32_t integer; float floating; } result{};
  result.integer = static_cast<std::uint32_t>((1U << 23U) *
      (1.4426950409f * value + 126.93490512f));
  return result.floating;
}

std::vector<float> Utility::activation_function_softmax(std::vector<float> &source) {
  std::vector<float> output(source.size());
  const float alpha = *std::max_element(source.begin(), source.end());
  float denominator = 0.f;
  for (std::size_t index = 0; index < source.size(); ++index) {
    output[index] = fast_exp(source[index] - alpha);
    denominator += output[index];
  }
  for (float &value : output) value /= denominator;
  return output;
}

template <typename Value>
float intersection_over_union(std::vector<Value> &left, std::vector<Value> &right) {
  const Value area_left = std::max<Value>(0, left[2] - left[0]) *
                          std::max<Value>(0, left[3] - left[1]);
  const Value area_right = std::max<Value>(0, right[2] - right[0]) *
                           std::max<Value>(0, right[3] - right[1]);
  const Value x1 = std::max(left[0], right[0]);
  const Value y1 = std::max(left[1], right[1]);
  const Value x2 = std::min(left[2], right[2]);
  const Value y2 = std::min(left[3], right[3]);
  if (y1 >= y2 || x1 >= x2) return 0.f;
  const double intersection = static_cast<double>(x2 - x1) * (y2 - y1);
  return static_cast<float>(intersection /
      (static_cast<double>(area_left) + area_right - intersection + 1e-8));
}

float Utility::iou(std::vector<int> &left, std::vector<int> &right) {
  return intersection_over_union(left, right);
}

float Utility::iou(std::vector<float> &left, std::vector<float> &right) {
  return intersection_over_union(left, right);
}

} // namespace PaddleOCR
