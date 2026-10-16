cmake_minimum_required(VERSION 3.15)
cmake_policy(SET CMP0091 NEW)
cmake_policy(SET CMP0042 NEW)

project(mcnative LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Node-API only (no V8/NAN): the binary is ABI-stable, so the same .node
# loads in Electron 44 today and in whatever Electron comes next.
add_definitions(-DNAPI_VERSION=8)

include_directories(${CMAKE_JS_INC})

add_library(${PROJECT_NAME} SHARED src/mcnative.cc ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_CPP_EXCEPTIONS UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)

if(MSVC)
  target_compile_options(${PROJECT_NAME} PRIVATE /EHsc /W3 /utf-8 /permissive-)
endif()

target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB} dxgi bcrypt version advapi32 user32)

# node.lib for Node-API is generated from the .def that ships with
# node-api-headers; cmake-js only tells us where it wants it.
if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()
