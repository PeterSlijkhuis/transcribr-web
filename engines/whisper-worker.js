// engines/whisper-worker.js -- classic worker that owns the whisper.cpp
// WASM runtime. It gets a worker of its own (sherpa-onnx gets another)
// because Emscripten's non-modularized glue declares its runtime as
// globals (Module, HEAPU8, PThread, run, ...): two engines importScripts()'d
// into one scope would overwrite each other's memory views.
//
// Protocol (app.js is the only caller):
//   in  {type: "load", manifest, version}
//   out {type: "progress", label, loaded, total} ... then {type: "loaded"}
//   in  {type: "transcribe", samples: Float32Array (16kHz mono), language,
//        translate, modelUrl}
//   out {type: "progress", label, loaded, total} while a new model downloads
//   out {type: "progress", fraction} ... then {type: "result", segments: [{t0, t1, text}]}
//   out {type: "error", error, fatal?} for either request
importScripts("fetch-cached.js");

(function () {
  let instance = 0;
  let modelUrl = null;
  let cacheVersion = null;
  let segments = [];
  let durationSec = 0;
  let finish = null;

  // whisper.cpp prints "[hh:mm:ss.mmm --> hh:mm:ss.mmm]  text" per segment
  // (params.print_realtime + print_timestamps in its emscripten.cpp).
  function parseSegmentLine(line) {
    const m = line.match(/^\[(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)\]\s*(.*)$/);
    if (!m) return null;
    const t0 = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    const t1 = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
    return { t0, t1, text: m[9].trim() };
  }

  // Whisper emits "[BLANK_AUDIO]", "(music)", "*laughs*" etc. for non-speech.
  function isNoise(text) {
    return text === "" || /^\[[^\]]*\]$/.test(text) || /^\([^)]*\)$/.test(text) || /^\*[^*]*\*$/.test(text);
  }

  function onPrint(line) {
    const seg = parseSegmentLine(line);
    if (!seg || isNoise(seg.text)) return;
    segments.push(seg);
    if (durationSec > 0) self.postMessage({ type: "progress", fraction: Math.min(1, seg.t1 / durationSec) });
  }

  // full_default() returns as soon as it has handed the audio to a
  // background thread; that thread calls whisper_print_timings() once
  // whisper_full() is done, which logs "whisper_print_timings: total time"
  // to stderr. That line is the completion signal.
  function onPrintErr(line) {
    if (finish && /whisper_print_timings:\s+total time/.test(line)) {
      const f = finish;
      finish = null;
      f();
    }
  }

  const progress = (label) => (loaded, total) => self.postMessage({ type: "progress", label, loaded, total });

  async function load(manifest, version) {
    const w = manifest.whisper;
    cacheVersion = version;
    const jsUrl = URL.createObjectURL(await transcribrFetchCached.fetchCachedBlob(w.libJsUrl, version, progress("whisper engine")));
    const wasmUrl = URL.createObjectURL(await transcribrFetchCached.fetchCachedBlob(w.wasmUrl, version, progress("whisper engine")));

    await new Promise((resolve, reject) => {
      self.Module = {
        print: onPrint,
        printErr: onPrintErr,
        locateFile: (path) => (path.endsWith(".wasm") ? wasmUrl : path),
        // pthread workers re-load the main script; without this they would
        // load this file (self.location) instead of the engine glue.
        mainScriptUrlOrBlob: jsUrl,
        onRuntimeInitialized: resolve,
        onAbort: (what) => {
          if (!self.Module.full_default) return reject(new Error("whisper engine failed to start: " + what));
          // Aborted after startup: the runtime is dead, so report it as
          // fatal and let app.js replace this worker.
          finish = null;
          self.postMessage({ type: "error", fatal: true, error: "whisper engine stopped: " + what });
        },
      };
      importScripts(jsUrl);
    });
  }

  // Swap in a different model only when asked for one; the loaded one is
  // reused across jobs.
  async function ensureModel(url) {
    if (url === modelUrl) return;
    const Module = self.Module;
    const blob = await transcribrFetchCached.fetchCachedBlob(url, cacheVersion, progress("whisper model"));
    if (instance) {
      Module.free(instance);
      instance = 0;
      modelUrl = null;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try { Module.FS_unlink("whisper.bin"); } catch (e) {}
    Module.FS_createDataFile("/", "whisper.bin", bytes, true, true);
    instance = Module.init("whisper.bin");
    // init() has read the model into wasm memory; drop the in-memory file copy.
    try { Module.FS_unlink("whisper.bin"); } catch (e) {}
    if (!instance) throw new Error("whisper engine could not load its model");
    modelUrl = url;
  }

  async function transcribe(samples, language, translate, url) {
    await ensureModel(url);
    segments = [];
    durationSec = samples.length / 16000;
    return new Promise((resolve, reject) => {
      finish = () => resolve(segments.slice());
      const nthreads = Math.max(1, Math.min(8, (self.navigator.hardwareConcurrency || 4) - 1));
      const ret = self.Module.full_default(instance, samples, language || "auto", nthreads, Boolean(translate));
      if (ret !== 0) {
        finish = null;
        reject(new Error("whisper engine refused the audio (code " + ret + ")"));
      }
    });
  }

  self.onmessage = async (ev) => {
    const msg = ev.data;
    try {
      if (msg.type === "load") {
        await load(msg.manifest, msg.version);
        self.postMessage({ type: "loaded" });
      } else if (msg.type === "transcribe") {
        const result = await transcribe(msg.samples, msg.language, msg.translate, msg.modelUrl);
        self.postMessage({ type: "result", segments: result });
      }
    } catch (err) {
      self.postMessage({ type: "error", error: String((err && err.message) || err) });
    }
  };
})();
