# Third-party attribution

This app distributes compiled WebAssembly builds of, and vendors build
scripts for, the following open-source projects:

- **whisper.cpp** — https://github.com/ggml-org/whisper.cpp — MIT License
- **sherpa-onnx** — https://github.com/k2-fsa/sherpa-onnx — Apache License 2.0
- **coi-serviceworker** — https://github.com/gzuidhof/coi-serviceworker — MIT License

The Whisper `base` speech model and the sherpa-onnx pyannote
segmentation-3.0 / NeMo TitaNet speaker-embedding models used by this app
are downloaded from their original publishers (Hugging Face / GitHub
Releases) at build time — see `engines-build/whisper/build.sh` and
`engines-build/sherpa/build.sh` for exact sources.
