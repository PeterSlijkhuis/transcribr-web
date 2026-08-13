#!/usr/bin/env bash
# engines-build/sherpa/build.sh
# Builds sherpa-onnx's official wasm speaker-diarization example from
# source, using their documented build script rather than reinventing the
# CMake invocation. Pinned to the commit this pipeline's harness was
# verified against. Vendored source and build output are gitignored.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d src ]; then
  git clone -c core.longpaths=true https://github.com/k2-fsa/sherpa-onnx src
  git -C src checkout c29b1838c843f92c7ad58eb81e174ccb4c3508cf
fi

source ../emsdk/emsdk_env.sh

# The wasm speaker-diarization build bakes its onnx models into the wasm
# binary's .data file via Emscripten --preload-file at *build* time (there
# is no runtime fetch-and-mount step) -- its CMakeLists.txt hard-fails at
# configure time unless these two files already exist here first.
ASSETS_DIR=src/wasm/speaker-diarization/assets
mkdir -p "$ASSETS_DIR"
if [ ! -f "$ASSETS_DIR/segmentation.onnx" ]; then
  # Extract into a dedicated scratch dir, not directly under /tmp -- a
  # recursive `find /tmp` walks unrelated root-owned systemd-private-*
  # dirs that live there on ubuntu-latest runners, and `find`'s resulting
  # non-zero exit (permission denied) kills the script under `set -e`
  # even though the model file itself was found.
  SEG_SCRATCH=$(mktemp -d)
  curl -L -o "$SEG_SCRATCH/segmentation.tar.bz2" https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
  tar -xjf "$SEG_SCRATCH/segmentation.tar.bz2" -C "$SEG_SCRATCH"
  find "$SEG_SCRATCH" -iname 'model.onnx' -path '*segmentation*' -exec cp {} "$ASSETS_DIR/segmentation.onnx" \;
  rm -rf "$SEG_SCRATCH"
fi
if [ ! -f "$ASSETS_DIR/embedding.onnx" ]; then
  curl -L -o "$ASSETS_DIR/embedding.onnx" https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_large.onnx
fi
if [ ! -f "$ASSETS_DIR/segmentation.onnx" ]; then
  echo "error: segmentation.onnx missing after extracting the archive -- inspect /tmp for the real internal path and adjust the 'find' command above" >&2
  exit 1
fi

cd src
./build-wasm-simd-speaker-diarization.sh

mkdir -p ../dist
cp -r build-wasm-simd-speaker-diarization/install/bin/wasm/speaker-diarization/* ../dist/
echo "built to engines-build/sherpa/dist/"
