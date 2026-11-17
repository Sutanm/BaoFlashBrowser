#pragma once

#include <windows.h>

#include <cstddef>

constexpr int kWidth = 550;
constexpr int kHeight = 420;
constexpr int kGameWidth = 640;
constexpr int kGameHeight = 480;
constexpr size_t kFrameBytes = kWidth * kHeight * 4;

// The writer marks the slot odd while copying and even when the frame is ready.
struct SharedFrame {
  volatile LONG generation;
  unsigned char pixels[kGameWidth * kGameHeight * 4];
};
