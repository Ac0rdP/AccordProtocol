#!/bin/bash
# Issue #108: Fail build if WASM binary exceeds size threshold
set -e

WASM_PATH="target/wasm32v1-none/release/accord.wasm"
MAX_SIZE_KB=512

if [ ! -f "$WASM_PATH" ]; then
  echo "ERROR: WASM binary not found at $WASM_PATH"
  echo "Run 'stellar contract build' first."
  exit 1
fi

SIZE_KB=$(du -k "$WASM_PATH" | cut -f1)
echo "WASM binary size: ${SIZE_KB}KB (limit: ${MAX_SIZE_KB}KB)"

if [ "$SIZE_KB" -gt "$MAX_SIZE_KB" ]; then
  echo "ERROR: WASM binary size ${SIZE_KB}KB exceeds limit of ${MAX_SIZE_KB}KB"
  exit 1
fi

echo "OK: WASM binary size is within limit."
