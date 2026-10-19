// engines/sherpa-worker.js -- classic worker that owns the sherpa-onnx
// speaker-diarization WASM runtime (see whisper-worker.js for why each
// engine gets its own worker).
//
// Protocol (app.js is the only caller):
//   in  {type: "load", manifest, version}
//   out {type: "progress", label, loaded, total} ... then {type: "loaded"}
//   in  {type: "diarize", samples: Float32Array (16kHz mono), numSpeakers}
//   out {type: "progress", fraction} ... then {type: "result", segments: [{start, end, speaker}]}
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

    const numThreads = 1;
    sd = self.createOfflineSpeakerDiarization(self.Module, {
      // Speaker embeddings, one per 10 s window and speaker, are nearly all
      // the cost. Sliding the window 2.5 s instead of the default 1 s made it
      // 2.5x faster with 99% of the labels unchanged (4-speaker clip,
      // 2026-10-15).
      segmentation: { pyannote: { model: "./segmentation.onnx", windowShiftRatio: 0.25 }, numThreads, debug: 0 },
      embedding: { model: "./embedding.onnx", numThreads, debug: 0 },
      clustering: { numClusters: -1, threshold: 0.5 },
      minDurationOn: 0.3,
      minDurationOff: 0.5,
    });
    if (sd.sampleRate !== 16000) {
      throw new Error(`diarization engine expects ${sd.sampleRate}Hz audio, but this app decodes at 16000Hz`);
    }
  }

  // sd.process() without the black box: the same calls as the helper's
  // process(), via ProcessWithCallback so each finished chunk reports.
  function processWithProgress(samples) {
    const M = self.Module;
    const cb = M.addFunction((done, total) => {
      self.postMessage({ type: "progress", fraction: total > 0 ? done / total : 0 });
      return 0;
    }, "iiii");
    const ptr = M._malloc(samples.length * 4);
    try {
      M.HEAPF32.set(samples, ptr / 4);
      const r = M._SherpaOnnxOfflineSpeakerDiarizationProcessWithCallback(sd.handle, ptr, samples.length, cb, 0);
      const n = M._SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(r);
      const segs = M._SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime(r);
      const out = [];
      for (let i = 0; i < n; i++) {
        const p = segs / 4 + i * 4; // {float start, float end, int32 speaker, float confidence}
        out.push({ start: M.HEAPF32[p], end: M.HEAPF32[p + 1], speaker: M.HEAP32[p + 2] });
      }
      M._SherpaOnnxOfflineSpeakerDiarizationDestroySegment(segs);
      M._SherpaOnnxOfflineSpeakerDiarizationDestroyResult(r);
      return out;
    } finally {
      M._free(ptr);
      M.removeFunction(cb);
    }
  }

  function diarize(samples, numSpeakers) {
    const config = sd.config;
    config.clustering = { numClusters: numSpeakers > 0 ? numSpeakers : -1, threshold: 0.5 };
    sd.setConfig(config);
    const t = performance.now();
    const segments = processWithProgress(samples);
    console.log(`diarization: ${((performance.now() - t) / 1000).toFixed(1)} s for ${(samples.length / 16000).toFixed(0)} s of audio, ${config.embedding.numThreads} threads`);
    return segments;
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
