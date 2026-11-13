cmake_minimum_required(VERSION 3.16)
project(mavframe VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_C_FLAGS_RELEASE "-O2")
include(GNUInstallDirs)

option(MAVFRAME_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(MAVFRAME_FUZZ "Build the libFuzzer target (needs clang)" OFF)
option(MAVFRAME_WERROR "Treat compiler warnings as errors (CI turns this on)" OFF)

add_compile_options(-Wall -Wextra -Wpedantic)
if(MAVFRAME_WERROR)
  add_compile_options(-Werror)
endif()
if(MAVFRAME_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer -g)
  add_link_options(-fsanitize=address,undefined)
endif()

add_library(mavframe STATIC src/mavframe.c)
target_include_directories(mavframe PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)

add_executable(mavframe-dump tools/mavframe-dump.c)
target_link_libraries(mavframe-dump PRIVATE mavframe)

# cmake --install build --prefix <dir>: lib/libmavframe.a, include/mavframe.h, bin/mavframe-dump.
install(TARGETS mavframe mavframe-dump
  ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
  LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(FILES include/mavframe.h DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})

add_executable(mavframe-bench bench/bench.c)
target_link_libraries(mavframe-bench PRIVATE mavframe)

enable_testing()
add_executable(test_mavframe tests/test_mavframe.c)
target_link_libraries(test_mavframe PRIVATE mavframe)
add_test(NAME unit COMMAND test_mavframe)

# mavframe-bench reads a pipe (not seekable) in full, and an unreadable input
# exits 1 with a message. Under ASan a leak would exit 23 instead and fail these.
add_test(NAME bench_pipe COMMAND sh -c
  "out=$(head -c 3000 \"$0\" | \"$1\" /dev/stdin 1 1) && echo \"$out\" | grep -q '^stream: 3000 bytes'"
  ${CMAKE_CURRENT_SOURCE_DIR}/docs/sample/sample-flight.tlog $<TARGET_FILE:mavframe-bench>)
add_test(NAME bench_unreadable COMMAND sh -c
  "\"$0\" \"$1\" 1 1 2>&1 | grep -q 'cannot read'; test $? -eq 0 && { \"$0\" \"$1\" 1 1 2>/dev/null; test $? -eq 1; }"
  $<TARGET_FILE:mavframe-bench> ${CMAKE_CURRENT_SOURCE_DIR}/docs)

# Native build of the WebAssembly glue, compared with the wasm build by tests/web/test_wasm.mjs.
add_executable(glue_dump tests/web/glue_dump.c web/wasm/mavframe_wasm.c src/mavframe.c)
target_include_directories(glue_dump PRIVATE include)

if(MAVFRAME_FUZZ)
  add_executable(fuzz_parse fuzz/fuzz_parse.c src/mavframe.c)
  target_include_directories(fuzz_parse PRIVATE include)
  target_compile_options(fuzz_parse PRIVATE -g -O1 -fsanitize=fuzzer,address,undefined -fno-sanitize-recover=undefined)
  target_link_options(fuzz_parse PRIVATE -fsanitize=fuzzer,address,undefined)

  # The browser glue (web/wasm/), built natively so the sanitizers see it.
  add_executable(fuzz_wasm_glue fuzz/fuzz_wasm_glue.c web/wasm/mavframe_wasm.c src/mavframe.c)
  target_include_directories(fuzz_wasm_glue PRIVATE include)
  target_compile_options(fuzz_wasm_glue PRIVATE -g -O1 -fsanitize=fuzzer,address,undefined -fno-sanitize-recover=undefined)
  target_link_options(fuzz_wasm_glue PRIVATE -fsanitize=fuzzer,address,undefined)
endif()
