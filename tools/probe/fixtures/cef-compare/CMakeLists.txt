cmake_minimum_required(VERSION 3.21)
project(bao_cef_compare LANGUAGES CXX)

file(TO_CMAKE_PATH "${CEF_ROOT}" CEF_ROOT)
set(CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)
add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" libcef_dll_wrapper)
ADD_LOGICAL_TARGET(cef_lib "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")

if(BAO_CEF_MODERN)
  add_executable(bao_cef_probe WIN32 native-shell.cc)
else()
  add_executable(bao_cef_probe WIN32 flash-worker.cc)
endif()
SET_EXECUTABLE_TARGET_PROPERTIES(bao_cef_probe)
target_link_libraries(bao_cef_probe PRIVATE cef_lib libcef_dll_wrapper ${CEF_STANDARD_LIBS} d3d11)
target_compile_features(bao_cef_probe PRIVATE cxx_std_17)
set_target_properties(bao_cef_probe PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
add_custom_command(TARGET bao_cef_probe POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CEF_ROOT}/Release" "$<TARGET_FILE_DIR:bao_cef_probe>"
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CEF_ROOT}/Resources" "$<TARGET_FILE_DIR:bao_cef_probe>")
