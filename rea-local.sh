#!/usr/bin/env bash
# Runs REA 6.9.0 with Node 24.22.3, Temurin JDK 21.0.13 and jadx-headless-mcp 0.7.1.
# Tools live OUTSIDE OneDrive (C:\Users\ankitc\cctv-v380-work\tools) because REA's
# file-stability check rejects OneDrive reparse-point files. No global config used.
L="/c/Users/ankitc/cctv-v380-work/tools"; W="$(cygpath -w "$L")"
export PATH="$L/node-v24.22.3-win-x64:$PATH"
# JDK 25: Ghidra 12.2 requires >=25; JADX 0.7.1 needs only 17+, so 25 serves both.
export JAVA_HOME="$W\\jdk25\\jdk-25.0.5+8"
export REA_JADX_MCP_JAR="$W\\jadx-mcp\\jadx-headless-mcp-0.7.1-all.jar"
export REA_JADX_OPERATION_TIMEOUT_MS="${REA_JADX_OPERATION_TIMEOUT_MS:-600000}"
export REA_JADX_HEAP_MIB="${REA_JADX_HEAP_MIB:-6144}"
export GHIDRA_INSTALL_DIR="C:/Users/ankitc/cctv-v380-work/ghidra/ghidra_12.2_PUBLIC"
exec node "$L/rea-cli/node_modules/rea-agents/scripts/rea.mjs" "$@"
