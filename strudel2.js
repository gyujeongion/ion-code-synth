// strudel2.js: registers a Strudel sound `v2` backed by the Vital-engine
// AudioWorklet, importable directly from the strudel.cc editor:
//
//   await import('http://localhost:30xx/strudel2.js')
//   note("c3 e3 g3 c4").s('v2')
//
// (Strudel's mini-notation parses double quotes, so URLs passed to import()
// from *inside* Strudel code must use single quotes -- see task notes.)
//
// Scheduling: unlike the reference vital_strudel.js (setTimeout-based, see
// serum2strudel/web/vital_strudel.js), this bridge hands the AudioContext
// time straight to the AudioWorkletProcessor via loader.js's noteOn/noteOff,
// which queue {frameTimeSec, kind} events applied at the exact sample frame
// inside process() -- no setTimeout jitter.
const V2_BASE = globalThis.V2_BASE || (new URL('.', import.meta.url)).href;

async function boot() {
  if (globalThis.__v2) return globalThis.__v2;

  const ctx = getAudioContext(); // provided by strudel.cc's global scope
  const { loadVitalV2 } = await import(V2_BASE + 'loader.js');
  const G = await import(V2_BASE + 'grammar.mjs');
  const v2 = await loadVitalV2(ctx, V2_BASE + 'build/vital_engine_simd.js');
  v2.node.port.addEventListener('message', (event) => {
    if (event.data?.type === 'error') console.error('[strudel2] ' + event.data.message);
    if (event.data?.type === 'patchReady') console.info('[strudel2] patch ready ' + event.data.patchId);
  });

  const out = ctx.createGain();
  out.gain.value = 1;

  // M2 FIX (gain staging / output clipping, see REPORT_M2.md and
  // REPORT_RT2.md S3: BlackHole loopback capture showed the actual
  // rendered output hard-clipping at +/-1.0 while the engine's own
  // pre-destination tap peaked at 2.10 -- unison=8 x up to 8 simultaneous
  // notes with no per-patch output ceiling or limiter). grammar.mjs now
  // applies 1/sqrt(voices) unison compensation at the patch level (see
  // compileOscillator), but multiple simultaneous notes/patches (each
  // individually capped at the engine's own internal +/-2.1 Clamp, see
  // sound_engine.cpp) can still sum arbitrarily far past 0dBFS when
  // several patches/notes stack (worklet.js renderPatchBlock() sums every
  // registered patch's audio into one shared bus) -- there is no single
  // fixed "worst case" ceiling to design a static preGain against.
  //
  // M2 CORRECTION (a WaveShaperNode-based version of this fix was tried
  // first and measured NOT working -- see REPORT_M2.md "gain staging
  // retest"): a WaveShaperNode's curve array is addressed by mapping
  // input sample value -1..1 to the curve INDEX, and the Web Audio spec
  // clamps any input OUTSIDE that domain to the curve's own endpoint
  // value -- so any sample arriving above +1.0 (routine here, given the
  // stacking behavior above) came out at EXACTLY +-1.0 regardless of
  // curve shape, a hard ceiling indistinguishable from having no limiter
  // at all, which is exactly the defect this was supposed to fix.
  //
  // Fixed properly with a DynamicsCompressorNode used as a limiter --
  // unlike WaveShaperNode it operates directly on the true (unbounded)
  // sample value, not a fixed -1..1 curve domain, so it compresses
  // correctly no matter how many patches/notes stack. threshold=-1dB,
  // knee=0 (hard knee right at threshold, minimal gray-zone), ratio=20:1
  // (extremely high but not literally 1:inf so it stays a smooth
  // limiter, not a brickwall gate), fast attack (3ms) so transients
  // don't slip through before gain reduction engages, moderate release
  // (100ms) short enough to recover between notes without audible
  // pumping on sustained material.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.0;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;

  // M2 CORRECTION #2 (the compressor alone was retested and still left
  // 26k-131k samples/60s at >=0.999 full scale -- see REPORT_M2.md "gain
  // staging retest 2"): DynamicsCompressorNode's gain reduction is
  // ENVELOPE-FOLLOWING, not sample-accurate -- even a 3ms attack can't
  // fully catch a hard unison=8-voice chord onset's very first few
  // samples, and with fast/dense patterns those onset transients recur
  // often enough to show up as a real fraction of samples pinned at the
  // ceiling. A DynamicsCompressorNode cannot, by itself, GUARANTEE a
  // sample-accurate ceiling. Fixed by adding a final hard-clamp stage
  // after the compressor has already done the musical loudness
  // management (so this stage only ever has to catch rare, small
  // transient overshoot, not do the real work): a WaveShaperNode whose
  // curve is an actual hard clamp to +/-0.98 (not a soft tanh knee this
  // time -- deliberately a flat ceiling) applied sample-by-sample,
  // unconditionally, regardless of the compressor's envelope timing.
  const finalClampCurve = new Float32Array(65536);
  for (let i = 0; i < finalClampCurve.length; i++) {
    const x = (i / (finalClampCurve.length - 1)) * 2 - 1; // -1..1
    finalClampCurve[i] = Math.max(-0.98, Math.min(0.98, x));
  }
  const finalClamp = ctx.createWaveShaper();
  finalClamp.curve = finalClampCurve;
  finalClamp.oversample = 'none'; // this stage is a hard limiter by design, not a saturation curve -- no oversample smoothing needed

  v2.node.connect(out).connect(limiter).connect(finalClamp).connect(ctx.destination);

  // Params exposed as pattern controls, e.g. note("...").s('v2').cutoff(80)
  // -- forwarded to set_param() at each hap's onset time (legacy single-
  // engine path, kept for backward compat with phase-0/0.5 patterns that
  // don't use .vpatch()). Add more names here (they must match Vital's own
  // parameter names, see vital::Parameters / synth_parameters.cpp) to expose
  // more controls.
  const PARAM_CONTROL_NAMES = {
    cutoff: 'filter_1_cutoff',
    resonance: 'filter_1_resonance',
    waveframe: 'osc_1_wave_frame',
    attack: 'env_1_attack',
    release: 'env_1_release',
  };

  const registeredPatchIds = new Set();

  function ensurePatchRegistered(patch) {
    if (registeredPatchIds.has(patch.id)) return;
    registeredPatchIds.add(patch.id);
    v2.registerPatch(patch.id, patch.ops);
  }

  // .vset({path: value|'<...>' pattern string}) resolves each path's value
  // at the hap's own onset (Strudel pattern semantics: a mini-notation
  // pattern string on a control is itself queried per-cycle by Strudel's
  // pattern engine before it ever reaches this sound function -- by the
  // time `value[key]` is read here it is already a plain number for THIS
  // hap, matching the spec's ".vset() evaluates once at note start" rule).
  function compileVsetOps(vsetSpec) {
    const setters = [];
    for (const path of Object.keys(vsetSpec)) {
      const { paramName, convert } = G.vsetPathToRawSetter(path);
      setters.push({ path, paramName, convert });
    }
    return setters;
  }

  registerSound(
    'vital',
    (t, value, onended, cps) => {
      const midi = Math.round(valueToMidi(value, 60));
      const vel = Math.max(0.05, Math.min(1, value.gain ?? value.velocity ?? 0.9));
      // M2 FIX (see REPORT_M2.md item 3, REPORT_RT2.md S4 "0.5s-duration
      // bug"): superdough's own driver (packages/superdough/superdough.mjs
      // -- confirmed by reading its published source) sets
      // `value.duration = hapDuration` unconditionally before calling this
      // callback, so `value.duration` SHOULD already be the hap's real
      // duration in seconds and this fallback should rarely fire. It stays
      // as a defensive fallback only (never remove -- a hap value object
      // reaching here without going through superdough's normal call path
      // is possible, e.g. future direct-call test harnesses), but it must
      // NOT be a fixed 0.5s regardless of tempo -- that silently breaks at
      // any cps other than the one 0.5s happens to match. Falls back to one
      // 1/16-note at the actual current tempo instead (cps is beats/sec at
      // 1 cycle=1 cycle here; Strudel's onTrigger signature passes it as
      // the 4th arg -- see superdough.mjs `onTrigger(t, value, onEnded,
      // cps)`), which is a much safer "something audible, not held forever
      // or clipped to nothing" default than an arbitrary fixed constant.
      const hapDuration = value.duration ?? (typeof cps === 'number' && cps > 0 ? 0.25 / cps : 0.5);
      const clip = Number.isFinite(Number(value.clip)) ? Math.max(0, Number(value.clip)) : 1;
      const dur = hapDuration * clip;

      const patch = value.__vitalPatch;
      if (patch) {
        ensurePatchRegistered(patch);
        if (value.__vitalVsetOps) {
          const vsetOverrides = value.__vitalVsetOps.map(({ path, paramName, convert }) => ({
            name: paramName,
            value: G.vsetPathToRawSetter(path, patch.spec).convert(Number(value.__vitalVsetValues && value.__vitalVsetValues[path] !== undefined ? value.__vitalVsetValues[path] : NaN)),
          })).filter((o) => Number.isFinite(o.value));
          if (vsetOverrides.length) v2.patchVset(patch.id, vsetOverrides, t);
        }
        v2.patchNoteOn(patch.id, midi, vel, t);
        v2.patchNoteOff(patch.id, midi, t + dur);
      } else {
        // legacy single-engine path (no .vpatch() on this pattern)
        v2.noteOn(midi, vel, t);
        for (const [hapKey, paramName] of Object.entries(PARAM_CONTROL_NAMES)) {
          if (value[hapKey] !== undefined) v2.setParam(paramName, Number(value[hapKey]), t);
        }
        v2.noteOff(midi, t + dur);
      }

      if (typeof onended === 'function') {
        const msUntilEnd = Math.max(0, (t + dur - ctx.currentTime) * 1000);
        setTimeout(onended, msUntilEnd);
      }

      // The real audio comes out of v2.node -> out -> destination (wired
      // once, above -- ALL patches' wasm instances mix inside the single
      // AudioWorkletProcessor and share this one node, see worklet.js
      // renderPatchBlock()), not through Strudel's per-hap node graph, so
      // hand back a silent dummy node -- same pattern as the prior-art
      // bridge.
      const dummy = ctx.createGain();
      dummy.gain.value = 0;
      return { node: dummy, stop: () => (patch ? v2.patchNoteOff(patch.id, midi, ctx.currentTime) : v2.noteOff(midi, ctx.currentTime)) };
    },
    { type: 'synth' }
  );

  // --- Pattern control methods: .vpatch(patch), .vset({...}) -----------
  // Strudel's Pattern.prototype gets these added so `.s('vital').vpatch(p)`
  // reads naturally. Implemented as `.fmap`-style value annotators: they
  // stash the compiled patch/vset info on each hap's value object, read
  // back by the 'vital' sound function above at onset time. This keeps
  // patch compilation (hashing, op-list building) OUT of the per-event hot
  // path -- see compileVsetOps()/G.vitalPatch -- matching the spec's "one
  // compile per evaluation, event messages carry only id+overrides" rule.
  if (typeof Pattern !== 'undefined' && Pattern.prototype && !Pattern.prototype.vpatch) {
    Pattern.prototype.vpatch = function vpatch(patch) {
      return this.fmap((v) => ({ ...v, __vitalPatch: patch }));
    };
    Pattern.prototype.vset = function vset(spec) {
      const compiled = compileVsetOps(spec);
      return this.fmap((v) => ({
        ...v,
        __vitalVsetOps: compiled,
        __vitalVsetValues: Object.fromEntries(Object.keys(spec).map((k) => [k, v[k] !== undefined ? v[k] : spec[k]])),
      }));
    };
  } else if (typeof Pattern === 'undefined') {
    console.warn('[strudel2] global Pattern class not found -- .vpatch()/.vset() not installed (only the legacy .cutoff()/.attack() param controls will work). This build was not verified against strudel.cc\'s actual Pattern prototype shape within the M1 time-box -- see REPORT_PHASE1_M1.md.');
  }

  globalThis.__v2 = v2;
  globalThis.vitalPatch = G.vitalPatch;
  globalThis.wt = G.wt;
  globalThis.env = G.env;
  globalThis.lfo = G.lfo;
  console.log('[strudel2] v2/vital sound ready @', ctx.sampleRate, 'Hz');
  return v2;
}

export default await boot();
