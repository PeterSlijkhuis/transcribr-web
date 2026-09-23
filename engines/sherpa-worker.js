// engines/sherpa-worker.js -- classic worker that owns the sherpa-onnx
// speaker-diarization WASM runtime (see whisper-worker.js for why each
// engine gets its own worker).
//
// Protocol (app.js is the only caller):
//   in  {type: "load", manifest, version}
//   out {type: "progress", label, loaded, total} ... then {type: "loaded"}
//   in  {type: "diarize", samples: Float32Array (16kHz mono), numSpeakers}
//   out {type: "result", segments: [{start, end, speaker}]}
//   out {type: "error", error} for either request
importScripts("fetch-cached.js");

(function () {
  let sd = null;

  async function load(manifest, version) {
    const s = manifest.sherpa;
    const progress = (label) => (loaded, total) => self.postMessage({ type: "progress", label, loaded, total });
    const get = async (url, label) => URL.createObjectURL(await transcribrFetchCached.fetchCachedBlob(url, version, progress(label)));
    const helperJsUrl = await get(s.helperJsUrl, "diarization engine");
    const mainJsUrl = await get(s.mainJsUrl, "diarization engine");
    const wasmUrl = await get(s.wasmUrl, "diarization engine");
    // The .data file holds the segmentation + speaker-embedding models,
    // preloaded into the engine's virtual filesystem by the glue itself.
    const dataUrl = await get(s.dataUrl, "diarization models");

    await new Promise((resolve, reject) => {
      self.Module = {
        print: () => {},
        printErr: () => {},
        // The glue asks locateFile() for both the .wasm and its .data package.
        locateFile: (path) => (path.endsWith(".data") ? dataUrl : path.endsWith(".wasm") ? wasmUrl : path),
        mainScriptUrlOrBlob: mainJsUrl,
        onRuntimeInitialized: resolve,
        onAbort: (what) => reject(new Error("diarization engine failed to start: " + what)),
      };
      importScripts(helperJsUrl, mainJsUrl);
    });

    sd = self.createOfflineSpeakerDiarization(self.Module, {
      segmentation: { pyannote: { model: "./segmentation.onnx" }, debug: 0 },
      embedding: { model: "./embedding.onnx", debug: 0 },
      clustering: { numClusters: -1, threshold: 0.5 },
      minDurationOn: 0.3,
      minDurationOff: 0.5,
    });
    if (sd.sampleRate !== 16000) {
      throw new Error(`diarization engine expects ${sd.sampleRate}Hz audio, but this app decodes at 16000Hz`);
    }
  }

  function diarize(samples, numSpeakers) {
    const config = sd.config;
    config.clustering = { numClusters: numSpeakers > 0 ? numSpeakers : -1, threshold: 0.5 };
    sd.setConfig(config);
    return sd.process(samples) || [];
  }

  self.onmessage = async (ev) => {
    const msg = ev.data;
    try {
      if (msg.type === "load") {
        await load(msg.manifest, msg.version);
        self.postMessage({ type: "loaded" });
      } else if (msg.type === "diarize") {
        self.postMessage({ type: "result", segments: diarize(msg.samples, msg.numSpeakers) });
      }
    } catch (err) {
      self.postMessage({ type: "error", error: String((err && err.message) || err) });
    }
  };
})();
