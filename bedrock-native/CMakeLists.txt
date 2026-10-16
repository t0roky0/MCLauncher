cmake_minimum_required(VERSION 3.20)
project(MCLauncherBedrock LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_definitions(UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
add_compile_options(/W4 /EHsc /utf-8)
add_library(mcl-hook STATIC vendor/minhook/src/buffer.c vendor/minhook/src/hook.c vendor/minhook/src/trampoline.c vendor/minhook/src/hde/hde64.c)
target_include_directories(mcl-hook PUBLIC vendor/minhook/include)
add_library(mcl-bedrock SHARED src/bridge.cpp src/comfort.cpp src/crashlog.cpp src/discovery.cpp src/overlay.cpp)
add_executable(mcl-bedrock-loader src/loader.cpp)
target_link_libraries(mcl-bedrock PRIVATE user32 version gdi32 mcl-hook)
target_link_libraries(mcl-bedrock-loader PRIVATE user32 version)
# development only (tools/bedrock/cosmetics_test.py): drawing over the game's frame
add_library(mcl-cosmetics-test SHARED src/cosmetics_test.cpp)
target_link_libraries(mcl-cosmetics-test PRIVATE d3d12 dxgi d3d11 d3dcompiler mcl-hook)
# development only (tools/bedrock/zoom_probe.py): how the game gets its field of view
add_library(mcl-zoom-probe SHARED src/zoom_probe.cpp)
target_link_libraries(mcl-zoom-probe PRIVATE mcl-hook)
# development only (scripts/tests/bedrock-overlay.test.cjs): the overlay's file redirection outside the game
add_executable(mcl-overlay-test test/overlay_test.cpp src/overlay.cpp)
target_link_libraries(mcl-overlay-test PRIVATE user32 mcl-hook)

add_executable(mcl-crashlog-test test/crashlog_test.cpp src/crashlog.cpp)
