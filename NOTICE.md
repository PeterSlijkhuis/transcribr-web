# Third-party attribution

This app distributes compiled WebAssembly builds of, and vendors build
scripts for, the following open-source projects:

- **whisper.cpp** — https://github.com/ggml-org/whisper.cpp — MIT License
- **sherpa-onnx** — https://github.com/k2-fsa/sherpa-onnx — Apache License 2.0
- **coi-serviceworker** — https://github.com/gzuidhof/coi-serviceworker — MIT License

The Whisper `base` speech model and the sherpa-onnx pyannote
segmentation-3.0 / NeMo TitaNet speaker-embedding models used by this app
are downloaded from their original publishers; the optional tiny and
small Whisper models are fetched by the app at runtime from
huggingface.co/ggerganov/whisper.cpp (MIT) (Hugging Face / GitHub
Releases) at build time — see `engines-build/whisper/build.sh` and
`engines-build/sherpa/build.sh` for exact sources.

`coi-serviceworker.js` is vendored unmodified from coi-serviceworker v0.1.7
(npm package `coi-serviceworker`), copyright (c) 2021 Guido Zuidhof, MIT
License.
