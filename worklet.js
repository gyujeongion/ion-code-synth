// AudioWorkletProcessor that owns one Vital SoundEngine WASM instance and
// renders stereo audio, sample-accurately, entirely inside
// AudioWorkletGlobalScope -- no pthreads, no SharedArrayBuffer.
//
// Loading strategy (documented per spec): the wasm bytes/module code are
// fetched on the MAIN thread by loader.js and postMessage'd (as the
// MODULARIZE glue's source text, since we build with SINGLE_FILE=1 so the
// wasm binary is embedded as base64 inside the JS -- no separate .wasm
// fetch is needed from inside the worklet, which matters because
// AudioWorkletGlobalScope has no `fetch`). The processor eval()s that glue
// exactly once (per AudioWorkletProcessor instance) and calls the
// MODULARIZE factory function synchronously; instantiation itself resolves
// via a Promise the processor awaits before accepting note events.
//
// Sample-accurate scheduling: every 'noteOn'/'noteOff' message carries a
// `time` field in AudioContext currentTime seconds. process() is called
// once per 128-frame render quantum with `currentTime` (via
// currentFrame/sampleRate, standard AudioWorkletGlobalScope globals). We
// compute each queued event's target sample offset within the block
// (event_time - block_start_time) * sampleRate, clamp to [0, blockSize),
// sort pending events for this block, and render in sub-chunks so the
// engine's internal state changes (note on/off) land on the exact frame
// requested, not just "sometime in this 128-frame block".

// --- Phase 1 Milestone 1: multi-patch support -------------------------------
// DESIGN DECISION (see REPORT_PHASE1_M1.md "multi-patch"): one WASM engine
// INSTANCE per distinct registered patch (identified by vitalPatch()'s
// content hash id), not the single-shared-engine-with-a-voice-pool design
// the reference API doc sketches. Each MODULARIZE factory() call already
// creates a fully independent wasm memory/instance (confirmed in phase 0:
// ~161MB per instance) -- reusing that as-is for "N patches = N instances"
// needed ZERO wrapper.cpp changes and was implementable within the M1 time
// box; a real shared-engine-with-tagged-voice-pool would need wrapper.cpp
// changes (per-voice patch-id tagging inside SynthVoiceHandler) that were
// out of scope here. Hard cap MAX_PATCHES below trades this off against
// memory: a browser tab holding e.g. 4 simultaneous distinct patches costs
// ~4*161MB=~644MB, judged acceptable for a live-coding session; exceeding
// the cap logs a warning and reuses the least-recently-registered patch's
// slot (evicting it) rather than growing unbounded.
const MAX_PATCHES = 4;

class VitalV2Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false; // true once patch 0 (the "default"/single-patch legacy path) is up
    this.engineHandle = null;
    this.Module = null;
    this.pendingEvents = []; // {frameTimeSec, kind, midi, velocity, params:[[name,value],...]} -- legacy single-engine path (still used by loadVitalV2()'s .noteOn()/.setParam() for backward compat with strudel2.js's non-patch usage)
    this.sampleRate_ = sampleRate; // AudioWorkletGlobalScope global
    this.glueSource_ = null;

    // patches: Map<patchId, {Module, cwrapped fns, outLPtr, outRPtr, pendingEvents:[], registeredAt}>
    this.patches = new Map();

    // --- Phase 0.5 instrumentation (see REPORT_PHASE05.md "Real-time load"
    // and "Event timing"). Always on -- a handful of counters and Date.now()
    // calls per 128-frame block is negligible next to the DSP cost, and this
    // is exactly the kind of thing that's only observable from inside the
    // worklet. Batched and flushed periodically (not per-block/per-event)
    // to keep postMessage traffic bounded over long runs.
    this._lastFrame = null; // last block's starting currentFrame, to detect skipped render quanta
    this._statsBuf = { blocks: 0, missedBlocks: 0, missedFramesTotal: 0, maxGapBlocks: 0,
                        durSumMs: 0, durMaxMs: 0, durCount: 0 };
    this._timingBuf = [];
    this._flushEveryBlocks = 1000; // ~2.9s at 128/44100
    this._flushEveryTimingEntries = 500;
    this._blocksSinceFlush = 0;

    // --- REPORT_REALDEVICE.md additions: SOL_AUDIT_P05.md item 3 objected
    // that "process() call count" and "currentFrame advance" were reported
    // without a shared clock basis, so "+39 calls" could not be checked
    // against reported gaps. Fixed here by recording process-call-count,
    // first/last currentFrame, and first/last wall-clock timestamp from the
    // SAME moments (top of every process() call, including calls before the
    // engine is `ready`, so nothing is silently excluded), plus a bounded
    // per-gap and per-slow-block detail log (currentTime-stamped) instead of
    // only aggregate counters. Best available in-worklet timer is chosen
    // once at construction time and reported so results can be judged by
    // their actual resolution rather than assumed.
    this._hasPerf = typeof performance !== 'undefined' && typeof performance.now === 'function';
    this._timerName = this._hasPerf ? 'performance.now' : 'Date.now';
    this._now = this._hasPerf ? () => performance.now() : () => Date.now();
    // Empirically probe this timer's resolution: smallest observed nonzero
    // delta between back-to-back calls, sampled a bounded number of times
    // right now (cheap, one-time, not per-block).
    this._timerResolutionMs = (() => {
      let minDelta = Infinity;
      let prev = this._now();
      for (let i = 0; i < 2000; i++) {
        const t = this._now();
        const d = t - prev;
        if (d > 0 && d < minDelta) minDelta = d;
        prev = t;
      }
      return Number.isFinite(minDelta) ? minDelta : null;
    })();
    this._processCallCount = 0;
    this._sessionFirstFrame = null;
    this._sessionFirstWallMs = null; // Date.now(), for correlation with Playwright-side wall clock
    this._sessionFirstPerfMs = null; // this._now(), whichever timer that is
    this._sessionLastFrame = null;
    this._sessionLastWallMs = null;
    this._sessionLastPerfMs = null;
    this._gapEvents = []; // {frames, currentTimeSec, atCall} for every gap >0 (i.e. >128 frames), capped
    this._gapEventsCap = 500;
    this._slowBlocks = []; // {durMs, currentTimeSec, atCall} for every block >1ms, capped
    this._slowBlocksCap = 500;
    this._overBudgetCount = 0; // blocks whose durMs exceeded the 128-frame budget (2.67ms @48k)

    this.port.onmessage = (ev) => this.handleMessage(ev.data);
  }

  _flushStats(force) {
    if (force || this._blocksSinceFlush >= this._flushEveryBlocks) {
      this.port.postMessage({ type: 'stats', stats: this._statsBuf });
      this._statsBuf = { blocks: 0, missedBlocks: 0, missedFramesTotal: 0, maxGapBlocks: 0,
                          durSumMs: 0, durMaxMs: 0, durCount: 0 };
      this._blocksSinceFlush = 0;
    }
    if (force || this._timingBuf.length >= this._flushEveryTimingEntries) {
      if (this._timingBuf.length) {
        this.port.postMessage({ type: 'timingBatch', entries: this._timingBuf });
        this._timingBuf = [];
      }
    }
    if (force || this._gapEvents.length >= this._gapEventsCap || this._slowBlocks.length >= this._slowBlocksCap) {
      if (this._gapEvents.length || this._slowBlocks.length) {
        this.port.postMessage({ type: 'detailBatch', gapEvents: this._gapEvents, slowBlocks: this._slowBlocks });
        this._gapEvents = [];
        this._slowBlocks = [];
      }
    }
  }

  // --- Phase 1 multi-patch: register a compiled patch (ops list from
  // grammar.js's compilePatch()) under its stable hash id. Idempotent --
  // re-registering the same id (e.g. Strudel re-evaluated the same code) is
  // a no-op if that id's instance already exists (see "live re-eval" below
  // for why structural changes go through THIS path with a NEW id instead of
  // mutating in place).
  async registerPatch(patchId, ops) {
    if (this.patches.has(patchId)) return; // already registered, nothing to do (live re-eval with unchanged patch content hashes the same)
    if (this.patches.size >= MAX_PATCHES) {
      // Evict the oldest-registered patch that currently has zero pending/active
      // voices we know about (best-effort -- we don't track per-voice liveness
      // here, so this can cut off a still-sounding old patch under heavy
      // pressure; documented limitation, see REPORT_PHASE1_M1.md).
      let oldestId = null, oldestT = Infinity;
      for (const [id, p] of this.patches) if (p.registeredAt < oldestT) { oldestT = p.registeredAt; oldestId = id; }
      if (oldestId) {
        const old = this.patches.get(oldestId);
        try { old.Module._free(old.outLPtr); old.Module._free(old.outRPtr); } catch (e) { /* best effort */ }
        this.patches.delete(oldestId);
        console.warn(`[strudel2] MAX_PATCHES (${MAX_PATCHES}) exceeded, evicted patch ${oldestId} to register ${patchId}`);
      }
    }
    try {
      const factory = this._factory || (this._factory = new Function(`${this.glueSource_}\nreturn typeof createVitalEngine_simd !== 'undefined' ? createVitalEngine_simd : module.exports;`)());
      const Module = await factory({});
      const p = {
        Module,
        create: Module.cwrap('v2_create', 'number', ['number', 'number']),
        noteOn: Module.cwrap('v2_note_on', null, ['number', 'number']),
        noteOff: Module.cwrap('v2_note_off', null, ['number']),
        process: Module.cwrap('v2_process', null, ['number', 'number', 'number']),
        setParam: Module.cwrap('v2_set_param', 'number', ['string', 'number']),
        loadWavetableFrame: Module.cwrap('v2_load_wavetable_frame', 'number', ['number', 'number', 'number', 'number']),
        wavetablePostprocess: Module.cwrap('v2_wavetable_postprocess', 'number', ['number']),
        loadWavetableJson: Module.cwrap('v2_load_wavetable_json', 'number', ['number', 'string']),
        loadSampleJson: Module.cwrap('v2_load_sample_json', 'number', ['string']),
        connectModulation: Module.cwrap('v2_connect_modulation', 'number', ['string', 'string', 'number', 'number']),
        connectModulationScaled: Module.cwrap('v2_connect_modulation_scaled', 'number', ['string', 'string', 'number', 'number', 'number']),
        setLfoShape: Module.cwrap('v2_set_lfo_shape', 'number', ['number', 'number', 'number', 'number', 'number']),
        snapSmoothed: Module.cwrap('v2_snap_smoothed_controls', null, []),
        pendingEvents: [],
        registeredAt: (this._registerCounter = (this._registerCounter || 0) + 1),
        outputGain: 1.0, // M2 FIX: patch-level output level, see grammar.mjs compilePatch() 'outputGain' op
      };
      p.create(this.sampleRate_, 128);
      const framesCap = 256;
      p.outLPtr = Module._malloc(framesCap * 4);
      p.outRPtr = Module._malloc(framesCap * 4);
      this.applyOps(p, ops);
      // M11 FIX (see REPORT_M11.md "smoothing snap" and engine/wrapper.cpp's
      // snapSmoothedControls() comment): applyOps() above just called
      // p.setParam() (v2_set_param) once per patch field via the SAME
      // SmoothValue-backed controls v2_load_preset_json() sets -- without
      // this snap, a note played immediately after registration hears
      // smoothed params (e.g. sample_level) still ramping from the
      // constructor's default instead of the patch's actual value (confirmed:
      // sample_on=1/sample_level=0 leaked -23.4dB RMS in the first 20ms of an
      // immediate noteOn, silent once settled). Snap ONCE here, at
      // registration time, before this patch can receive any noteOn/
      // patchEvent -- never after a per-note .vset() override (see
      // renderPatchBlock()'s 'vset' handling below), which must keep
      // smoothing to avoid audible zipper/click artifacts.
      p.snapSmoothed();
      this.patches.set(patchId, p);
      this.port.postMessage({ type: 'patchReady', patchId });
    } catch (e) {
      this.port.postMessage({ type: 'error', message: `registerPatch(${patchId}): ${String((e && e.stack) || e)}` });
    }
  }

  applyOps(p, ops) {
    // M2 FIX (see engine/wrapper.cpp v2_load_wavetable_frame comment and
    // REPORT_M2.md): postProcess() is destructive/cumulative across a
    // wavetable's WHOLE frame set, not per-frame -- it must be called
    // exactly ONCE per oscillator, after every frame for that oscillator
    // has been loaded, never once-per-frame (that was the root cause of
    // the M1 "wt.frames pos0 renders a square-like spectrum" bug). Track
    // which osc indices got a 'wavetable' op in this batch and postprocess
    // each exactly once at the end.
    const oscsToPostprocess = new Set();
    for (const op of ops) {
      if (op.op === 'param') p.setParam(op.name, op.value);
      else if (op.op === 'wavetableJson') {
        // M11: routes through WavetableCreator (see engine/wrapper.cpp's
        // v2_load_wavetable_json() and grammar.mjs's buildWavetableJson()),
        // not the old v2_load_wavetable_frame() raw-frame bypass -- no
        // separate postprocess call needed, jsonToState()+render() already
        // does WavetableCreator's own DC-removal/normalization.
        p.loadWavetableJson(op.osc, JSON.stringify(op.json));
      } else if (op.op === 'sampleJson') {
        // M12: patch-level noise sample (see grammar.mjs buildSampleJson()
        // and engine/wrapper.cpp v2_load_sample_json()) -- one call, no
        // per-osc index (Vital has a single global Sample module).
        p.loadSampleJson(JSON.stringify(op.json));
      } else if (op.op === 'wavetable') {
        // Legacy raw-frame path -- kept for any caller still emitting this
        // op shape (e.g. an older cached patch id), grammar.mjs's
        // compileOscillator() no longer emits it (see M11 note above).
        const n = op.samples.length;
        const ptr = p.Module._malloc(n * 4);
        p.Module.HEAPF32.set(op.samples, ptr / 4);
        p.loadWavetableFrame(op.osc, op.frame, ptr, n);
        p.Module._free(ptr);
        oscsToPostprocess.add(op.osc);
      } else if (op.op === 'lfoShape') {
        const n = op.xs.length;
        const xp = p.Module._malloc(n * 4), yp = p.Module._malloc(n * 4), pp = p.Module._malloc(n * 4);
        p.Module.HEAPF32.set(op.xs, xp / 4);
        p.Module.HEAPF32.set(op.ys, yp / 4);
        p.Module.HEAPF32.set(op.powers, pp / 4);
        p.setLfoShape(op.lfo, xp, yp, pp, n);
        p.Module._free(xp); p.Module._free(yp); p.Module._free(pp);
      } else if (op.op === 'mod') {
        if (op.range !== undefined) p.connectModulationScaled(op.source, op.dest, op.amount, op.bipolar === undefined ? -1 : op.bipolar, op.range);
      else p.connectModulation(op.source, op.dest, op.amount, op.bipolar === undefined ? -1 : op.bipolar);
      } else if (op.op === 'outputGain') {
        p.outputGain = op.value;
      }
    }
    for (const osc of oscsToPostprocess) p.wavetablePostprocess(osc);
  }

  handleMessage(msg) {
    if (msg.type === 'init') {
      this.glueSource_ = msg.glueSource;
      this.initEngine(msg.glueSource, msg.sampleRate, msg.maxBlock);
    } else if (msg.type === 'registerPatch') {
      this.registerPatch(msg.patchId, msg.ops);
    } else if (msg.type === 'patchEvent') {
      // {patchId, frameTimeSec, kind: 'noteOn'|'noteOff'|'vset', midi, velocity, vsetOps: [{name,value}]}
      const targetAbsFrame = Math.round(msg.event.frameTimeSec * this.sampleRate_);
      const p = this.patches.get(msg.patchId);
      if (p) p.pendingEvents.push({ ...msg.event, targetAbsFrame });
      else this.port.postMessage({ type: 'error', message: `patchEvent for unregistered patch ${msg.patchId}` });
    } else if (msg.type === 'event') {
      // Stamp with the target absolute sample frame (from the scheduled
      // AudioContext time) and the absolute frame at which this message was
      // actually handled (currentFrame is an AudioWorkletGlobalScope global,
      // valid here too, not just inside process()) -- lets us separate
      // "applied at the wrong frame within the block it arrived in" from
      // "arrived late from the main thread" (see applyEvent below).
      const targetAbsFrame = Math.round(msg.event.frameTimeSec * this.sampleRate_);
      const arrivalAbsFrame = typeof currentFrame === 'number' ? currentFrame : null;
      this.pendingEvents.push({ ...msg.event, targetAbsFrame, arrivalAbsFrame });
    } else if (msg.type === 'flushStats') {
      this._flushStats(true);
    } else if (msg.type === 'getSessionInfo') {
      // Single-clock-basis snapshot for SOL_AUDIT_P05.md item 3: first/last
      // currentFrame and first/last wall-clock ms, recorded from the SAME
      // process() calls (see process() below), plus which in-worklet timer
      // is actually in use and its empirically probed resolution.
      this.port.postMessage({
        type: 'sessionInfo',
        timerName: this._timerName,
        timerResolutionMs: this._timerResolutionMs,
        hasPerf: this._hasPerf,
        processCallCount: this._processCallCount,
        sessionFirstFrame: this._sessionFirstFrame,
        sessionFirstWallMs: this._sessionFirstWallMs,
        sessionFirstPerfMs: this._sessionFirstPerfMs,
        sessionLastFrame: this._sessionLastFrame,
        sessionLastWallMs: this._sessionLastWallMs,
        sessionLastPerfMs: this._sessionLastPerfMs,
        overBudgetCount: this._overBudgetCount,
        sampleRate: this.sampleRate_,
      });
    } else if (msg.type === 'setParam') {
      if (this.ready) this.setParamNow(msg.name, msg.value);
      else this.pendingEvents.push({ frameTimeSec: 0, kind: 'param', name: msg.name, value: msg.value });
    } else if (msg.type === 'loadWavetable') {
      if (this.ready) this.loadWavetableNow(msg.osc, msg.frame, msg.samples);
    }
  }

  async initEngine(glueSource, sr, maxBlock) {
    try {
      // eslint-disable-next-line no-new-func
      const factory = new Function(`${glueSource}\nreturn typeof createVitalEngine_simd !== 'undefined' ? createVitalEngine_simd : module.exports;`)();
      const Module = await factory({});
      this.Module = Module;
      this._create = Module.cwrap('v2_create', 'number', ['number', 'number']);
      this._noteOn = Module.cwrap('v2_note_on', null, ['number', 'number']);
      this._noteOff = Module.cwrap('v2_note_off', null, ['number']);
      this._process = Module.cwrap('v2_process', null, ['number', 'number', 'number']);
      this._setParam = Module.cwrap('v2_set_param', 'number', ['string', 'number']);
      this._loadWavetableFrame = Module.cwrap('v2_load_wavetable_frame', 'number', ['number', 'number', 'number', 'number']);
      this._wavetablePostprocess = Module.cwrap('v2_wavetable_postprocess', 'number', ['number']);

      this._create(sr, maxBlock);

      const framesCap = 256;
      this._outLPtr = Module._malloc(framesCap * 4);
      this._outRPtr = Module._malloc(framesCap * 4);
      this._framesCap = framesCap;

      this.ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (e) {
      this.port.postMessage({ type: 'error', message: String(e && e.stack || e) });
    }
  }

  setParamNow(name, value) {
    this._setParam(name, value);
  }

  loadWavetableNow(osc, frameIndex, samplesArray) {
    const Module = this.Module;
    const n = samplesArray.length;
    const ptr = Module._malloc(n * 4);
    Module.HEAPF32.set(samplesArray, ptr / 4);
    Module.cwrap('v2_load_wavetable_frame', 'number', ['number', 'number', 'number', 'number'])(osc, frameIndex, ptr, n);
    Module._free(ptr);
    // M2 FIX: postProcess is no longer automatic inside
    // v2_load_wavetable_frame (see applyOps() comment) -- this legacy
    // single-frame path calls it once per load, which is correct for its
    // one-frame-at-a-time usage pattern (each call is its own "whole table"
    // of 1 frame).
    this._wavetablePostprocess(osc);
  }

  process(inputs, outputs) {
    // --- REPORT_REALDEVICE.md: session-wide call count + first/last
    // currentFrame + first/last wall-clock, recorded unconditionally at the
    // very top of EVERY process() call (including pre-ready calls), all
    // from the same moment, so "calls" and "frames advanced" can be checked
    // against each other and against wall time on one shared basis
    // (SOL_AUDIT_P05.md item 3). blockStartFrame/blockStartSec below reuse
    // these same reads, not separate ones.
    this._processCallCount++;
    const _nowWallMs = Date.now();
    const _nowPerfMs = this._now();
    const _nowFrame = currentFrame;
    if (this._sessionFirstFrame === null) {
      this._sessionFirstFrame = _nowFrame;
      this._sessionFirstWallMs = _nowWallMs;
      this._sessionFirstPerfMs = _nowPerfMs;
    }
    this._sessionLastFrame = _nowFrame;
    this._sessionLastWallMs = _nowWallMs;
    this._sessionLastPerfMs = _nowPerfMs;

    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    const blockSize = left.length;

    if (!this.ready) {
      left.fill(0);
      if (right !== left) right.fill(0);
      return true;
    }

    const blockDurMs0 = _nowPerfMs; // best available in-worklet timer (this._timerName); see REPORT_REALDEVICE.md
    const blockStartFrame = _nowFrame; // AudioWorkletGlobalScope global: absolute sample index of this block's first sample
    if (this._lastFrame !== null) {
      const gapFrames = blockStartFrame - this._lastFrame - blockSize;
      if (gapFrames > 0) {
        // currentFrame jumped by more than one render quantum since the
        // last process() call -- the browser skipped calling us for that
        // interval (a genuine underrun/missed block), not a measurement
        // artifact: currentFrame is authoritative, unlike Date.now() timing.
        this._statsBuf.missedBlocks++;
        this._statsBuf.missedFramesTotal += gapFrames;
        this._statsBuf.maxGapBlocks = Math.max(this._statsBuf.maxGapBlocks, Math.round(gapFrames / blockSize));
        if (this._gapEvents.length < this._gapEventsCap) {
          this._gapEvents.push({ frames: gapFrames, currentTimeSec: currentTime, atCall: this._processCallCount });
        }
      }
    }
    this._lastFrame = blockStartFrame;

    const blockStartSec = currentTime; // AudioWorkletGlobalScope global: start time of this render quantum
    const sr = this.sampleRate_;

    // Partition this block's pending events by target frame offset.
    const due = [];
    const stillPending = [];
    for (const ev of this.pendingEvents) {
      const offsetSec = ev.frameTimeSec - blockStartSec;
      const frameOffset = Math.round(offsetSec * sr);
      if (frameOffset < blockSize) {
        due.push({ ...ev, frameOffset: Math.max(0, frameOffset) });
      } else {
        stillPending.push(ev);
      }
    }
    this.pendingEvents = stillPending;
    due.sort((a, b) => a.frameOffset - b.frameOffset);

    let cursor = 0;
    const applyEvent = (ev) => {
      if (ev.kind === 'noteOn') this._noteOn(ev.midi, ev.velocity);
      else if (ev.kind === 'noteOff') this._noteOff(ev.midi);
      else if (ev.kind === 'param') this.setParamNow(ev.name, ev.value);

      if (ev.targetAbsFrame != null && (ev.kind === 'noteOn' || ev.kind === 'noteOff')) {
        const appliedAbsFrame = blockStartFrame + ev.frameOffset;
        const lateArrival = ev.arrivalAbsFrame != null && ev.arrivalAbsFrame > ev.targetAbsFrame;
        this._timingBuf.push({
          kind: ev.kind,
          midi: ev.midi != null ? ev.midi : null, // note/pattern context for outlier explanation
          currentTimeSec: blockStartSec,
          targetAbsFrame: ev.targetAbsFrame,
          appliedAbsFrame,
          blockFrameOffset: ev.frameOffset, // where in this 128-frame block the event landed (0..127)
          errorSamples: appliedAbsFrame - ev.targetAbsFrame,
          lateArrival,
          latenessSamples: lateArrival ? (ev.arrivalAbsFrame - ev.targetAbsFrame) : 0,
        });
      }
    };

    for (const ev of due) {
      if (ev.frameOffset > cursor) {
        this.renderChunk(left, right, cursor, ev.frameOffset - cursor);
        cursor = ev.frameOffset;
      }
      applyEvent(ev);
    }
    if (cursor < blockSize)
      this.renderChunk(left, right, cursor, blockSize - cursor);

    const blockDurMs = this._now() - blockDurMs0; // measured with this._timerName, see getSessionInfo
    this._statsBuf.blocks++;
    this._statsBuf.durSumMs += blockDurMs;
    this._statsBuf.durMaxMs = Math.max(this._statsBuf.durMaxMs, blockDurMs);
    this._statsBuf.durCount++;
    if (blockDurMs > 1) {
      if (this._slowBlocks.length < this._slowBlocksCap) {
        this._slowBlocks.push({ durMs: blockDurMs, currentTimeSec: blockStartSec, atCall: this._processCallCount });
      }
    }
    const blockBudgetMs = (blockSize / sr) * 1000;
    if (blockDurMs > blockBudgetMs) this._overBudgetCount++;
    this._blocksSinceFlush++;
    this._flushStats(false);

    // --- Phase 1 multi-patch mixing: each registered patch is its own wasm
    // instance (see registerPatch()'s design-decision comment); ADD each
    // one's rendered output on top of the legacy single-engine path above
    // (additive summing at the orbit/output level, not multiple node
    // connections -- keeps the "shared worklet output connects to the graph
    // once" requirement from the reference API doc even though internally
    // there are N wasm instances).
    for (const [patchId, p] of this.patches) {
      this.renderPatchBlock(p, left, right, blockStartFrame, blockStartSec, blockSize, sr);
    }

    return true;
  }

  renderPatchBlock(p, left, right, blockStartFrame, blockStartSec, blockSize, sr) {
    const due = [];
    const stillPending = [];
    for (const ev of p.pendingEvents) {
      const offsetSec = ev.frameTimeSec - blockStartSec;
      const frameOffset = Math.round(offsetSec * sr);
      if (frameOffset < blockSize) due.push({ ...ev, frameOffset: Math.max(0, frameOffset) });
      else stillPending.push(ev);
    }
    p.pendingEvents = stillPending;
    due.sort((a, b) => a.frameOffset - b.frameOffset);

    const apply = (ev) => {
      if (ev.kind === 'noteOn') p.noteOn(ev.midi, ev.velocity);
      else if (ev.kind === 'noteOff') p.noteOff(ev.midi);
      else if (ev.kind === 'vset' && Array.isArray(ev.vsetOps)) {
        for (const o of ev.vsetOps) p.setParam(o.name, o.value);
      }
    };

    let cursor = 0;
    const addChunk = (offset, count) => {
      if (count <= 0) return;
      p.process(p.outLPtr, p.outRPtr, count);
      const outL = new Float32Array(p.Module.HEAPF32.buffer, p.outLPtr, count);
      const outR = new Float32Array(p.Module.HEAPF32.buffer, p.outRPtr, count);
      const g = p.outputGain; // M2 FIX: patch-level output level
      for (let i = 0; i < count; i++) {
        left[offset + i] += outL[i] * g;
        if (right !== left) right[offset + i] += outR[i] * g;
      }
    };
    for (const ev of due) {
      if (ev.frameOffset > cursor) { addChunk(cursor, ev.frameOffset - cursor); cursor = ev.frameOffset; }
      apply(ev);
    }
    if (cursor < blockSize) addChunk(cursor, blockSize - cursor);
  }

  renderChunk(left, right, offset, count) {
    if (count <= 0) return;
    const Module = this.Module;
    this._process(this._outLPtr, this._outRPtr, count);
    const outL = new Float32Array(Module.HEAPF32.buffer, this._outLPtr, count);
    const outR = new Float32Array(Module.HEAPF32.buffer, this._outRPtr, count);
    left.set(outL, offset);
    if (right !== left) right.set(outR, offset);
  }
}

registerProcessor('vital-v2-processor', VitalV2Processor);
