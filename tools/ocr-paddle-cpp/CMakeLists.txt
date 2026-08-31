cmake_minimum_required(VERSION 3.14)
if(POLICY CMP0091)
  cmake_policy(SET CMP0091 NEW)
endif()
project(bao_paddle_ocr_sidecar LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
set(PADDLE_LIB "" CACHE PATH "Paddle Inference root")
set(PADDLE_OCR_CPP "" CACHE PATH "PaddleOCR deploy/cpp_infer root")
set(OPENCV_DIR "" CACHE PATH "OpenCV package root (non-Windows)")
set(OPENCV_SOURCE_DIR "" CACHE PATH "OpenCV source root (Windows)")
set(OPENCV_CONFIG_DIR "" CACHE PATH "Configured OpenCV header root (Windows)")
set(OPENCV_IMPORT_LIB "" CACHE FILEPATH "opencv_world import library (Windows)")
if(NOT PADDLE_LIB OR NOT PADDLE_OCR_CPP)
  message(FATAL_ERROR "PADDLE_LIB and PADDLE_OCR_CPP are required")
endif()

if(WIN32)
  if(NOT OPENCV_SOURCE_DIR OR NOT OPENCV_CONFIG_DIR OR NOT OPENCV_IMPORT_LIB)
    message(FATAL_ERROR "OPENCV_SOURCE_DIR, OPENCV_CONFIG_DIR and OPENCV_IMPORT_LIB are required on Windows")
  endif()
  set(OpenCV_INCLUDE_DIRS
    "${OPENCV_CONFIG_DIR}"
    "${OPENCV_SOURCE_DIR}/include"
    "${OPENCV_SOURCE_DIR}/modules/core/include"
    "${OPENCV_SOURCE_DIR}/modules/imgcodecs/include"
    "${OPENCV_SOURCE_DIR}/modules/imgproc/include"
  )
  set(OpenCV_LIBS "${OPENCV_IMPORT_LIB}")
else()
  find_package(OpenCV REQUIRED COMPONENTS core imgproc)
endif()

set(PADDLE_THIRD_PARTY "${PADDLE_LIB}/third_party/install")
add_executable(bao-paddle-ocr-sidecar
  bao_paddle_sidecar.cpp
  utility_minimal.cpp
  "${PADDLE_OCR_CPP}/src/args.cpp"
  "${PADDLE_OCR_CPP}/src/clipper.cpp"
  "${PADDLE_OCR_CPP}/src/ocr_cls.cpp"
  "${PADDLE_OCR_CPP}/src/ocr_det.cpp"
  "${PADDLE_OCR_CPP}/src/ocr_rec.cpp"
  "${PADDLE_OCR_CPP}/src/paddleocr.cpp"
  "${PADDLE_OCR_CPP}/src/postprocess_op.cpp"
  "${PADDLE_OCR_CPP}/src/preprocess_op.cpp"
)

target_include_directories(bao-paddle-ocr-sidecar PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${PADDLE_OCR_CPP}"
  "${PADDLE_LIB}/paddle/include"
  "${PADDLE_THIRD_PARTY}/gflags/include"
  "${PADDLE_THIRD_PARTY}/glog/include"
  "${PADDLE_THIRD_PARTY}/protobuf/include"
  "${PADDLE_THIRD_PARTY}/xxhash/include"
  ${OpenCV_INCLUDE_DIRS}
)

if(WIN32)
  set_property(TARGET bao-paddle-ocr-sidecar PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  target_compile_definitions(bao-paddle-ocr-sidecar PRIVATE
    GOOGLE_GLOG_DLL_DECL=
    GFLAGS_DLL_DECLARE_FLAG=
    GFLAGS_DLL_DEFINE_FLAG=
  )
  target_compile_options(bao-paddle-ocr-sidecar PRIVATE /O2 /openmp /utf-8 /bigobj)
  target_link_directories(bao-paddle-ocr-sidecar PRIVATE
    "${PADDLE_THIRD_PARTY}/gflags/lib"
    "${PADDLE_THIRD_PARTY}/glog/lib"
    "${PADDLE_THIRD_PARTY}/protobuf/lib"
    "${PADDLE_THIRD_PARTY}/xxhash/lib"
  )
  target_link_libraries(bao-paddle-ocr-sidecar PRIVATE
    "${PADDLE_LIB}/paddle/lib/paddle_inference.lib"
    "${PADDLE_THIRD_PARTY}/mklml/lib/mklml.lib"
    "${PADDLE_THIRD_PARTY}/mklml/lib/libiomp5md.lib"
    "${PADDLE_THIRD_PARTY}/mkldnn/lib/mkldnn.lib"
    gflags_static glog libprotobuf xxhash
    ${OpenCV_LIBS}
    shlwapi
  )
else()
  target_compile_options(bao-paddle-ocr-sidecar PRIVATE -O3 -fopenmp)
  target_link_options(bao-paddle-ocr-sidecar PRIVATE
    "-Wl,-rpath,$ORIGIN/lib"
    "-Wl,-rpath-link,${PADDLE_LIB}/paddle/lib"
    "-Wl,-rpath-link,${PADDLE_THIRD_PARTY}/mklml/lib"
    "-Wl,-rpath-link,${PADDLE_THIRD_PARTY}/mkldnn/lib"
  )
  target_link_libraries(bao-paddle-ocr-sidecar PRIVATE
    "${PADDLE_LIB}/paddle/lib/libpaddle_inference.so"
    "${PADDLE_THIRD_PARTY}/gflags/lib/libgflags.a"
    ${OpenCV_LIBS}
    dl rt gomp m pthread
  )
endif()
