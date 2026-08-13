#!/usr/bin/env bash
# engines-build/whisper/build.sh
# Builds whisper.cpp's official wasm example from source, pinned to the
# commit this pipeline's harness was verified against (bumping it means
# re-verifying test.spec.mjs still passes). Vendored source and build
# output are gitignored — regenerate via this script.
set -euo pipefail
cd "$(dirname "$0")"

PIN=4523d0ce373ee4b2176b3251fff29fd4864fcf38
if [ ! -d src ]; then
  git clone https://github.com/ggml-org/whisper.cpp src
fi
if [ "$(git -C src rev-parse HEAD)" != "$PIN" ]; then
  git -C src fetch --all
  git -C src checkout "$PIN"
fi

source ../emsdk/emsdk_env.sh

cd src
mkdir -p build-em
cd build-em
emcmake cmake -DWHISPER_WASM_SINGLE_FILE=OFF ..
emmake make -j"$(nproc)"

mkdir -p ../../dist
cp bin/libmain.js bin/libmain.wasm ../../dist/
echo "built to engines-build/whisper/dist/"
