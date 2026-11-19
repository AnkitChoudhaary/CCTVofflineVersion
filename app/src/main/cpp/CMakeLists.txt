cmake_minimum_required(VERSION 3.22.1)
project(v380node)

set(CMAKE_CXX_STANDARD 17)

# Prebuilt nodejs-mobile core library (shipped in jniLibs/<abi>/libnode.so)
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
        ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

add_library(native-lib SHARED native-lib.cpp)

# nodejs-mobile public headers (node.h, node_api.h, v8, uv, ...)
target_include_directories(native-lib PRIVATE
        ${CMAKE_SOURCE_DIR}/../../../../nodejs-mobile-headers/include/node)

find_library(log-lib log)

target_link_libraries(native-lib libnode ${log-lib})
