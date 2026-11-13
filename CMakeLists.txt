cmake_minimum_required(VERSION 3.16)
project(mavframe C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_C_FLAGS_RELEASE "-O2")

option(MAVFRAME_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(MAVFRAME_FUZZ "Build the libFuzzer target (needs clang)" OFF)

add_compile_options(-Wall -Wextra -Wpedantic -Werror)
if(MAVFRAME_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer -g)
  add_link_options(-fsanitize=address,undefined)
endif()

add_library(mavframe STATIC src/mavframe.c)
target_include_directories(mavframe PUBLIC include)

add_executable(mavframe-dump tools/mavframe-dump.c)
target_link_libraries(mavframe-dump PRIVATE mavframe)

add_executable(mavframe-bench bench/bench.c)
target_link_libraries(mavframe-bench PRIVATE mavframe)

enable_testing()
add_executable(test_mavframe tests/test_mavframe.c)
target_link_libraries(test_mavframe PRIVATE mavframe)
add_test(NAME unit COMMAND test_mavframe)

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
