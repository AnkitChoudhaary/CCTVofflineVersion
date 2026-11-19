# Runs the project-local REA CLI (6.9.0) with project-local Node 24.22.3,
# Temurin JDK 21.0.13 and jadx-headless-mcp 0.7.1. No global config is used.
# Usage: .\rea-local.ps1 <rea arguments...>
# Tools live outside OneDrive: REA rejects OneDrive reparse-point files.
$tools = 'C:\Users\ankitc\cctv-v380-work\tools'
$env:PATH = (Join-Path $tools 'node-v24.22.3-win-x64') + ';' + $env:PATH
$env:JAVA_HOME = Join-Path $tools 'jdk\jdk-21.0.13+9'
$env:REA_JADX_MCP_JAR = Join-Path $tools 'jadx-mcp\jadx-headless-mcp-0.7.1-all.jar'
if (-not $env:REA_JADX_OPERATION_TIMEOUT_MS) { $env:REA_JADX_OPERATION_TIMEOUT_MS = '600000' }
if (-not $env:REA_JADX_HEAP_MIB) { $env:REA_JADX_HEAP_MIB = '4096' }
& (Join-Path $tools 'node-v24.22.3-win-x64\node.exe') (Join-Path $tools 'rea-cli\node_modules\rea-agents\scripts\rea.mjs') @args
exit $LASTEXITCODE
