# Third-party attribution

This app distributes compiled WebAssembly builds of, and vendors build
scripts for, the following open-source projects:

- **whisper.cpp** — https://github.com/ggml-org/whisper.cpp — MIT License
- **sherpa-onnx** — https://github.com/k2-fsa/sherpa-onnx — Apache License 2.0
- **coi-serviceworker** — https://github.com/gzuidhof/coi-serviceworker — MIT License

The graphics card (WebGPU) engine loads **Transformers.js**
(https://github.com/huggingface/transformers.js, Apache License 2.0) from
jsDelivr at runtime, with ONNX Whisper models from huggingface.co/onnx-community.
Whisper models are by OpenAI (https://github.com/openai/whisper, MIT License).

The University of Twente and BMS Lab logos in `logos/` are the property of
their owners and are not covered by this project's licences.

The sherpa-onnx pyannote segmentation-3.0 / NeMo TitaNet speaker-embedding
models used by this app are downloaded from their original publishers
(Hugging Face) at build time — see `engines-build/sherpa/build.sh` for
exact sources. All three Whisper models (tiny, small, medium) are fetched
by the app at runtime from huggingface.co/ggerganov/whisper.cpp (MIT).

`coi-serviceworker.js` is vendored unmodified from coi-serviceworker v0.1.7
(npm package `coi-serviceworker`), copyright (c) 2021 Guido Zuidhof, MIT
License.
