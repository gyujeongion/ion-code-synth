// grammar.js -- Strudel 2 Phase 1 Milestone 1 grammar layer.
//
// Pure JS, no DOM/AudioContext dependency (importable from Node for testing,
// see tests/phase1_grammar.mjs) and from the browser (strudel2.js wires this
// into `.vpatch()`/`.vset()`/`.vmod()` and the worklet message protocol).
//
// Responsibilities:
//   - wt.harmonics / wt.expr / wt.frames: build 2048-sample wavetable frames
//     from code, no sample files.
//   - env.dahdsr / lfo.draw: structured envelope/LFO descriptors.
//   - vitalPatch()/vitalPatch.extend(): compile a patch spec into a flat list
//     of Vital engine ops (param sets in RAW vital units, wavetable frame
//     loads, LFO shapes, modulation connections) plus a stable hash id.
//   - Unit conversion table (human units <-> Vital raw param units), derived
//     from src/common/synth_parameters.cpp's ValueDetails ranges/scales
//     (read directly, not guessed -- see GRAMMAR.md "units" table for the
//     source line for each conversion).
//
// IMPORTANT: this module does NOT talk to the wasm engine directly. It only
// produces plain-data "compiled patch" objects; strudel2.js/worklet.js are
// responsible for sending them to a v2 engine instance via the existing
// wrapper.cpp C API (v2_set_param, v2_load_wavetable_frame, v2_set_lfo_shape,
// v2_connect_modulation) -- no wrapper.cpp changes were needed for grammar
// M1 (see REPORT_PHASE1_M1.md "API deviations").

const WAVE_SIZE = 2048; // vital::WaveFrame::kWaveformSize

// ---------------------------------------------------------------------------
// wt.* -- wavetable frame builders. All return a Float32Array[2048] time-
// domain frame (raw samples, -1..1 range not enforced -- Vital's own
// postProcess() normalizes/analyzes on load).
// ---------------------------------------------------------------------------

function harmonics(amps, phases) {
  const frame = new Float32Array(WAVE_SIZE);
  for (let n = 0; n < WAVE_SIZE; n++) {
    const x = n / WAVE_SIZE;
    let s = 0;
    for (let h = 0; h < amps.length; h++) {
      const amp = amps[h];
      if (!amp) continue;
      const ph = (phases && phases[h]) || 0;
      s += amp * Math.sin(2 * Math.PI * (h + 1) * x + ph);
    }
    frame[n] = s;
  }
  return frame;
}

// --- wt.expr: SAFE restricted expression compiler ---------------------------
// Grammar: numeric literals, `x`, `TAU`, `PI`, + - * / ^, unary -, parens,
// function calls sin cos tri saw sqr pulse abs min max pow exp (fixed
// whitelist). No identifiers other than the above are legal -- this is a
// hand-written recursive-descent parser producing a closure-based evaluator,
// never `eval`/`new Function` on the user string, so it cannot execute
// arbitrary JS.
const EXPR_FUNCS = {
  sin: Math.sin, cos: Math.cos, abs: Math.abs, exp: Math.exp,
  tri: (v) => { const t = v / (2 * Math.PI); const f = t - Math.floor(t); return 4 * Math.abs(f - 0.5) - 1; },
  saw: (v) => { const t = v / (2 * Math.PI); const f = t - Math.floor(t); return 2 * f - 1; },
  sqr: (v) => { const t = v / (2 * Math.PI); const f = t - Math.floor(t); return f < 0.5 ? 1 : -1; },
  pulse: (v, w) => { const t = v / (2 * Math.PI); const f = t - Math.floor(t); const width = w === undefined ? 0.5 : w; return f < width ? 1 : -1; },
  min: Math.min, max: Math.max, pow: Math.pow,
};
const EXPR_CONSTS = { TAU: 2 * Math.PI, PI: Math.PI };

function tokenizeExpr(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) {
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1] || '')) break;
        j++;
      }
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new Error(`wt.expr: illegal character '${c}' at ${i}`);
  }
  return toks;
}

// recursive-descent: expr := term (('+'|'-') term)*
// term := unary (('*'|'/') unary)*
// unary := '-' unary | power
// power := atom ('^' unary)?      (right-assoc)
// atom := num | const | ident '(' args ')' | '(' expr ')' | 'x'
function parseExpr(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => {
    const tok = tokens[pos];
    if (!tok || (t && tok.t !== t)) throw new Error(`wt.expr: expected '${t}', got ${tok ? tok.t : 'EOF'}`);
    pos++;
    return tok;
  };
  function parseAtom() {
    const tok = peek();
    if (!tok) throw new Error('wt.expr: unexpected end of expression');
    if (tok.t === 'num') { eat(); return () => tok.v; }
    if (tok.t === '(') { eat('('); const e = parseAddSub(); eat(')'); return e; }
    if (tok.t === '-') { eat(); const e = parseUnary(); return (x) => -e(x); }
    if (tok.t === 'ident') {
      eat();
      const name = tok.v;
      if (peek() && peek().t === '(') {
        eat('(');
        const args = [];
        if (peek() && peek().t !== ')') {
          args.push(parseAddSub());
          while (peek() && peek().t === ',') { eat(','); args.push(parseAddSub()); }
        }
        eat(')');
        const fn = EXPR_FUNCS[name];
        if (!fn) throw new Error(`wt.expr: unknown function '${name}'`);
        return (x) => fn(...args.map((a) => a(x)));
      }
      if (name === 'x') return (x) => x;
      if (name in EXPR_CONSTS) { const v = EXPR_CONSTS[name]; return () => v; }
      throw new Error(`wt.expr: unknown identifier '${name}'`);
    }
    throw new Error(`wt.expr: unexpected token '${tok.t}'`);
  }
  function parseUnary() {
    if (peek() && peek().t === '-') { eat(); const e = parseUnary(); return (x) => -e(x); }
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (peek() && peek().t === '^') { eat('^'); const exp = parseUnary(); return (x) => Math.pow(base(x), exp(x)); }
    return base;
  }
  function parseMulDiv() {
    let e = parseUnary();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = eat().t;
      const rhs = parseUnary();
      const lhs = e;
      e = op === '*' ? (x) => lhs(x) * rhs(x) : (x) => lhs(x) / rhs(x);
    }
    return e;
  }
  function parseAddSub() {
    let e = parseMulDiv();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = eat().t;
      const rhs = parseMulDiv();
      const lhs = e;
      e = op === '+' ? (x) => lhs(x) + rhs(x) : (x) => lhs(x) - rhs(x);
    }
    return e;
  }
  const result = parseAddSub();
  if (pos !== tokens.length) throw new Error('wt.expr: trailing input');
  return result;
}

function expr(src) {
  const compiled = parseExpr(tokenizeExpr(src));
  const frame = new Float32Array(WAVE_SIZE);
  for (let n = 0; n < WAVE_SIZE; n++) {
    frame[n] = compiled(n / WAVE_SIZE);
  }
  return frame;
}

// wt.frames({at, wave}[]): keyframes, `at` in [0,1] mapped to Vital wave-frame
// slot 0..255 (kNumOscillatorWaveFrames-1). Returns a descriptor -- actual
// frame loading happens in compilePatch() (needs the osc index).
function frames(keyframeList) {
  return { __wtFrames: true, keyframes: keyframeList.slice().sort((a, b) => a.at - b.at) };
}

const wt = { harmonics, expr, frames, WAVE_SIZE };

// ---------------------------------------------------------------------------
// M11 (see REPORT_M11.md "wavetable via WavetableCreator"): build a real
// Vital wavetable-authoring JSON (one element of a .vital preset's top-level
// "wavetables" array) from wt.harmonics/wt.expr/wt.frames output, so the
// grammar/translator path loads wavetables through engine/wrapper.cpp's
// v2_load_wavetable_json() (WavetableCreator::jsonToState()+render(), the
// SAME call the native preset loader (v2_load_preset_json) uses), instead of
// the old raw-frame bypass (v2_load_wavetable_frame()+manual per-morph JS
// interpolation). Schema confirmed against a real serum2vital-produced
// .vital file's wavetables[i]: {groups:[{components:[{type:"Wave Source",
// interpolation, interpolation_style, keyframes:[{position, wave_data}]}]}],
// name, author, remove_all_dc, full_normalize} -- wave_data is
// base64(raw little-endian float32[2048] time-domain bytes), see
// WaveSourceKeyframe::jsonToState (common/wavetable/wave_source.cpp) and
// wrapper.cpp's v2_load_wavetable_json() comment. wt.harmonics/wt.expr/
// wt.frames' own surface syntax is UNCHANGED -- this only replaces what
// compilePatch() does internally with their Float32Array output.
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Portable (no Buffer/btoa dependency -- this module runs in Node,
// AudioWorkletGlobalScope, and the main-thread browser, and none of those
// three environments has BOTH available) base64 encoder for a byte array.
function bytesToBase64(bytes) {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < len ? bytes[i + 1] : 0, b2 = i + 2 < len ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += B64_CHARS[(triple >> 18) & 0x3f];
    out += B64_CHARS[(triple >> 12) & 0x3f];
    out += i + 1 < len ? B64_CHARS[(triple >> 6) & 0x3f] : '=';
    out += i + 2 < len ? B64_CHARS[triple & 0x3f] : '=';
  }
  return out;
}
// Float32Array[2048] time-domain frame -> base64 of its raw little-endian
// bytes (matches JUCE's Base64::toBase64(float*, byteCount) on every
// platform this engine runs on -- wasm/x86/arm64 are all little-endian).
function frameToWaveDataB64(frame) {
  const buf = new ArrayBuffer(WAVE_SIZE * 4);
  const view = new DataView(buf);
  for (let i = 0; i < WAVE_SIZE; i++) view.setFloat32(i * 4, frame[i], /*littleEndian=*/true);
  return bytesToBase64(new Uint8Array(buf));
}
// keyframes: [{at, wave}] (wave: Float32Array[2048]) -> one wavetables[i]
// JSON object. interpolation=1 (kFrequency, WaveSource::InterpolationMode)
// and interpolation_style=1 (kLinear, WavetableComponent::InterpolationStyle)
// match WavetableComponent's own constructor default (interpolation_style_
// (kLinear)) and the interpolation mode observed in real serum2vital .vital
// output for morphed oscillators -- see wrapper.cpp comment for the source
// citations. Single-keyframe (position 0) wavetables (the common
// wt.harmonics()/wt.expr() case, no wt.frames() morph) are unaffected by
// either setting (nothing to interpolate between).
function buildWavetableJson(keyframeList, name) {
  return {
    author: '',
    full_normalize: false,
    remove_all_dc: true,
    name: name || '',
    version: '1.0.6',
    groups: [{
      components: [{
        type: 'Wave Source',
        interpolation: 1,
        interpolation_style: 1,
        keyframes: keyframeList.map((kf) => ({ position: kf.position, wave_data: frameToWaveDataB64(kf.wave) })),
      }],
    }],
  };
}

// Procedural white-noise sources. M13 provenance correction: btesser's
// writer.py creates its placeholder with Python Random(0).randint(), not
// Serum's original noise recording. Reproducing that algorithm preserves
// the converted Vital source without embedding any recorded audio.
// mulberry32 remains the default for existing handwritten patches.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// CPython integer-seeded MT19937 for unsigned 32-bit seeds. The two
// init-by-array mixing passes and rejection-based getrandbits(16) reproduce
// Random(seed).randint(-32000, 32000), used by btesser's writer.py.
function pythonNoisePcm(seed, length) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('python-mt19937 seed must be an unsigned 32-bit integer');
  const mt = new Uint32Array(624);
  mt[0] = 19650218;
  for (let i = 1; i < 624; i++)
    mt[i] = (Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1812433253) + i) >>> 0;
  let i = 1;
  for (let k = 0; k < 624; k++) {
    mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + seed) >>> 0;
    if (++i >= 624) { mt[0] = mt[623]; i = 1; }
  }
  for (let k = 0; k < 623; k++) {
    mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
    if (++i >= 624) { mt[0] = mt[623]; i = 1; }
  }
  mt[0] = 0x80000000;
  let index = 624;
  function nextUint32() {
    if (index === 624) {
      for (let j = 0; j < 624; j++) {
        const y = (mt[j] & 0x80000000) | (mt[(j + 1) % 624] & 0x7fffffff);
        mt[j] = mt[(j + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
      }
      index = 0;
    }
    let y = mt[index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
  const bytes = new Uint8Array(length * 2);
  const view = new DataView(bytes.buffer);
  for (let j = 0; j < length; j++) {
    let r;
    do { r = nextUint32() >>> 16; } while (r >= 64001);
    view.setInt16(j * 2, r - 32000, true);
  }
  return bytesToBase64(bytes);
}
// Float32/PCM16 samples -> base64 of raw little-endian int16 bytes (matches
// JUCE's Base64::toBase64(int16*, byteCount), decoded back the same way by
// Sample::jsonToState()'s utils::pcmToFloatData(), synthesis/producers/
// sample_source.cpp -- same convention as buildWavetableJson()'s float32
// wave_data, just 16-bit PCM instead of float32 time-domain).
function samplesToPcm16B64(samples) {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(v * 32767), /*littleEndian=*/true);
  }
  return bytesToBase64(new Uint8Array(buf));
}
// buildSampleJson({noise, seed, length, sampleRate}) -> Sample::jsonToState()
// input {name, length, sample_rate, samples}. `noise: 'white'` is the only
// supported source (see GRAMMAR.md "Deviations" -- 'pink'/'brown' etc are
// NOT implemented, no test preset needed them; this throws rather than
// silently emitting white noise for an unrecognized type, matching HARD
// RULES "never silently substitute").
function buildSampleJson(spec) {
  const { noise = 'white', seed = 1, length = 2048, sampleRate = 44100, generator = 'mulberry32' } = spec || {};
  if (noise !== 'white') throw new Error(`sample: unsupported noise type '${noise}' (only 'white' is implemented)`);
  if (generator === 'python-mt19937')
    return { name: 'White Noise (generated)', length, sample_rate: sampleRate, samples: pythonNoisePcm(seed, length) };
  if (generator !== 'mulberry32') throw new Error(`sample: unsupported generator '${generator}'`);
  const rand = mulberry32(seed >>> 0);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) samples[i] = rand() * 2 - 1; // uniform [-1,1)
  return { name: 'White Noise (generated)', length, sample_rate: sampleRate, samples: samplesToPcm16B64(samples) };
}

// ---------------------------------------------------------------------------
// env.dahdsr / lfo.draw -- structured descriptors, unit-converted at compile
// time (see UNIT CONVERSIONS below).
// ---------------------------------------------------------------------------

function dahdsr(spec) {
  return { __env: true, ...spec };
}
const env = { dahdsr };

function draw(spec) {
  return { __lfo: true, points: spec.points, rate: spec.rate, sync: spec.sync !== false, mode: spec.mode || 'trigger', delay: spec.delay || 0, fade: spec.fade || 0 };
}
const lfo = { draw };

// ---------------------------------------------------------------------------
// UNIT CONVERSIONS (human units -> Vital raw param units).
// Source: src/common/synth_parameters.cpp ValueDetails (min,max,value_scale).
// See GRAMMAR.md "Units" table for the exact source line quoted per param.
// ---------------------------------------------------------------------------

// filter_N_cutoff: raw range [8,136], IS the standard MIDI note number
// (A4=69=440Hz reference) -- raw IS fed straight into
// utils::midiNoteToFrequency() engine-side (ladder_filter.cpp:79 etc; see
// synth_parameters.cpp "cutoff" ValueDetails min/max/default = 8/136/60,
// and common/synth_constants.h kMidi0Frequency=8.1757989156, the exact
// standard MIDI-note-0 frequency). The M1 report's "-8.35" was an
// EMPIRICAL-FIT WORKAROUND for a real engine bug, not a true constant of
// this parameter -- see REPORT_M2.md "filter cutoff root cause": the
// wrapper never called SoundEngine::checkOversampling() after
// setSampleRate(), so the engine stayed permanently stuck at the
// constructor's placeholder 2x oversampling (vs. the "oversampling"
// control's real default of 1x) regardless of the actual sample rate --
// FIXED in engine/wrapper.cpp v2_create(). With that engine fix, a direct
// instrumented measurement (engine/patched_src/synthesis/filters/
// ladder_filter.cpp's debug globals, read via
// v2_debug_ladder_base_frequency()) confirms the filter's actual cutoff
// converges to EXACTLY the standard formula (ratio 1.000, not ~5x off) once
// the modulation-smoothed control value settles (~100-150ms after a param
// change -- Vital's own mod-control smoothing, NOT part of this formula).
// raw = 12*log2(Hz) - 36.38  <=>  Hz = 440*2^((raw-69)/12)
const CUTOFF_SLOPE = 12;
const CUTOFF_MIDI_OFFSET = 69; // A4 = MIDI note 69 = 440Hz, the standard reference
function hzToCutoffRaw(hz) {
  const v = CUTOFF_SLOPE * Math.log2(hz / 440) + CUTOFF_MIDI_OFFSET;
  return Math.max(8, Math.min(136, v));
}
function cutoffRawToHz(raw) {
  return 440 * Math.pow(2, (raw - CUTOFF_MIDI_OFFSET) / 12);
}

// env_N_{attack,decay,release,delay,hold}: raw range [0, 2.37842], engine
// applies raw^4 -> seconds (ValueDetails::kQuartic). Max ~32.02s.
const ENV_TIME_MAX_RAW = 2.37842;
function secToEnvRaw(sec) {
  const raw = Math.pow(Math.max(0, sec), 0.25);
  return Math.max(0, Math.min(ENV_TIME_MAX_RAW, raw));
}

// osc_N_level: raw range [0,1], engine applies raw^2 -> amplitude
// (ValueDetails::kQuadratic).
function ampToLevelRaw(amp) {
  return Math.max(0, Math.min(1, Math.sqrt(Math.max(0, amp))));
}

// lfo_N_frequency (free/unsynced): raw range [-7,9], kExponential ->
// Hz = 2^raw.
function hzToLfoFreqRaw(hz) {
  const v = Math.log2(Math.max(1e-6, hz));
  return Math.max(-7, Math.min(9, v));
}

const TEMPO_SYNC_NAMES = ['Freeze', '32/1', '16/1', '8/1', '4/1', '2/1', '1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64'];
function tempoRateToIndex(rateStr) {
  const idx = TEMPO_SYNC_NAMES.indexOf(rateStr);
  if (idx < 0) throw new Error(`lfo.draw: unknown rate '${rateStr}', expected one of ${TEMPO_SYNC_NAMES.join(',')}`);
  return idx;
}

const FILTER_MODEL_NAMES = ['Analog', 'Dirty', 'Ladder', 'Digital', 'Diode', 'Formant', 'Comb', 'Phaser'];
function filterModelToIndex(name) {
  const idx = FILTER_MODEL_NAMES.findIndex((n) => n.toLowerCase() === String(name).toLowerCase());
  if (idx < 0) throw new Error(`filter model '${name}' not found, expected one of ${FILTER_MODEL_NAMES.join(',')}`);
  return idx;
}

// ---------------------------------------------------------------------------
// vitalPatch() -- compiles a patch spec into a flat op list + stable hash id.
// ---------------------------------------------------------------------------

function hashString(s) {
  // FNV-1a, 32-bit -- stable across runs/platforms (not crypto-strength, but
  // a patch-identity key doesn't need to be, only needs to be
  // content-deterministic so re-evaluating identical code reuses the same id).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function stableStringify(obj) {
  if (obj instanceof Float32Array) return `[f32:${Array.from(obj).join(',')}]`;
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${k}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(obj);
}

function compileOscillator(oscIndex, spec, ops) {
  const prefix = `osc_${oscIndex}`;
  ops.push({ op: 'param', name: `${prefix}_on`, value: 1 });
  if (spec.wave) {
    // M11 (see REPORT_M11.md "wavetable via WavetableCreator"): both branches
    // now go through buildWavetableJson()+the 'wavetableJson' op ->
    // engine/wrapper.cpp's v2_load_wavetable_json() (WavetableCreator::
    // jsonToState()+render(), same call the native preset loader uses per
    // oscillator) instead of the old v2_load_wavetable_frame() raw-frame
    // bypass. This REPLACES the M2-era manual 32-step JS-side linear
    // time-domain interpolation between wt.frames() keyframes (see the M2
    // FIX history this comment used to carry, still in REPORT_M2.md/
    // REPORT_PHASE1_M1.md) -- Vital's own WaveSource component now does the
    // keyframe-to-keyframe interpolation itself (kFrequency blend within a
    // pair, kLinear span selection across >2 keyframes; see
    // buildWavetableJson()'s comment), matching how the SAME morph would be
    // authored/played back in the real desktop app or a native-loaded
    // preset -- not an approximation of it.
    if (spec.wave.__wtFrames) {
      // FINDING (kept from the pre-M11 code): kNumOscillatorWaveFrames == 257
      // (common/synth_constants.h), so valid frame slots are 0..256
      // (v2_get_param_max('osc_1_wave_frame') measures 256, confirmed in
      // REPORT.md/offline_render_results.json) -- `at` in [0,1] maps to
      // `* 256`, not `* 255` (an earlier version's off-by-one, see
      // REPORT_PHASE1_M1.md item 3).
      const kfs = spec.wave.keyframes;
      const keyframeList = kfs.map((kf) => ({
        position: Math.round(kf.at * 256),
        wave: kf.wave instanceof Float32Array ? kf.wave : harmonics([1]),
      }));
      ops.push({ op: 'wavetableJson', osc: oscIndex, json: buildWavetableJson(keyframeList) });
    } else if (spec.wave instanceof Float32Array) {
      ops.push({ op: 'wavetableJson', osc: oscIndex, json: buildWavetableJson([{ position: 0, wave: spec.wave }]) });
    }
  }
  if (spec.warp) {
    const w = spec.warp;
    const base = { 'serum-pd': 13, 'serum-fm': 16, 'serum-am': 19, 'serum-rm': 22 }[w.mode];
    if (base === undefined) throw new Error(`unsupported warp mode '${w.mode}'`);
    const sources = oscIndex === 1 ? ['osc2', 'osc3'] : oscIndex === 2 ? ['osc1', 'osc3'] : ['osc1', 'osc2'];
    const offset = w.from === 'sample' ? 2 : sources.indexOf(w.from);
    if (offset < 0) throw new Error(`osc${oscIndex}: unsupported warp source '${w.from}'`);
    if (!Number.isFinite(w.amount) || w.amount < 0 || w.amount > 1)
      throw new Error('warp.amount must be between 0 and 1');
    ops.push({ op: 'param', name: `${prefix}_distortion_type`, value: base + offset });
    ops.push({ op: 'param', name: `${prefix}_distortion_amount`, value: w.amount });
  }
  if (spec.position !== undefined) ops.push({ op: 'param', name: `${prefix}_wave_frame`, value: spec.position * 256 });
  // M2 FIX (gain staging, see REPORT_M2.md and REPORT_RT2.md "the patch's
  // own gain staging ... causes real, audible clipping distortion on real
  // hardware"): Vital has NO built-in per-voice unison level compensation
  // control (confirmed -- synth_parameters.cpp's only unison_* params are
  // detune/voices/blend, no normalize/gain knob) -- summing N detuned
  // unison copies at full level multiplies RMS by roughly sqrt(N) (for
  // decorrelated-ish detuned copies), which is exactly what REPORT_RT2.md
  // measured (engine tap peak 2.10 with unison=8, 8 simultaneous notes, no
  // compensation). Standard equal-power unison compensation: scale level by
  // 1/sqrt(voices). Applied here (not left to the patch author) so
  // .vitalPatch({osc1:{unison:{voices:8}}}) doesn't silently clip by
  // default; an explicit spec.level still composes multiplicatively with
  // this compensation, not replaced by it.
  const linearLevel = spec.levelCurve === 'linear';
  if (spec.levelCurve !== undefined) {
    if (!['linear', 'quadratic'].includes(spec.levelCurve)) throw new Error('unsupported oscillator levelCurve');
    ops.push({ op: 'param', name: `${prefix}_serum_linear_level`, value: linearLevel ? 1 : 0 });
  }
  const unisonVoices = spec.unison && spec.unison.voices > 1 ? spec.unison.voices : 1;
  // Translated presets opt out: their authored level already belongs to
  // the source signal chain. Handwritten patches retain the safe default.
  const unisonCompensation = unisonVoices > 1 && spec.unison.normalize !== false ? 1 / Math.sqrt(unisonVoices) : 1;
  if (spec.level !== undefined || unisonVoices > 1 || spec.levelCurve !== undefined) {
    // ValueDetails default for osc_N_level is raw=0.70710678119 (kQuadratic
    // -> amplitude 0.5) -- see synth_parameters.cpp "level". Used as the
    // base when the patch doesn't specify an explicit level but DOES use
    // unison>1 (so compensation still has something to scale).
    const baseLevel = spec.level !== undefined ? spec.level : 0.5;
    ops.push({ op: 'param', name: `${prefix}_level`, value: linearLevel ? Math.max(0, Math.min(1, baseLevel * unisonCompensation)) : ampToLevelRaw(baseLevel * unisonCompensation) });
  }
  if (spec.transpose !== undefined) ops.push({ op: 'param', name: `${prefix}_transpose`, value: spec.transpose });
  if (spec.pan !== undefined) ops.push({ op: 'param', name: `${prefix}_pan`, value: spec.pan });
  if (spec.unison) {
    const u = spec.unison;
    if (u.voices !== undefined) ops.push({ op: 'param', name: `${prefix}_unison_voices`, value: u.voices });
    if (u.detune !== undefined) ops.push({ op: 'param', name: `${prefix}_unison_detune`, value: Math.max(0, Math.min(10, u.detune * 10)) });
    if (u.blend !== undefined) ops.push({ op: 'param', name: `${prefix}_unison_blend`, value: u.blend });
    if (u.stereo !== undefined) ops.push({ op: 'param', name: `${prefix}_stereo_spread`, value: u.stereo });
  }
}

function compileFilter(filtIndex, spec, ops) {
  const prefix = `filter_${filtIndex}`;
  ops.push({ op: 'param', name: `${prefix}_on`, value: 1 });
  if (spec.model !== undefined) ops.push({ op: 'param', name: `${prefix}_model`, value: filterModelToIndex(spec.model) });
  if (spec.cutoff !== undefined) ops.push({ op: 'param', name: `${prefix}_cutoff`, value: hzToCutoffRaw(spec.cutoff) });
  if (spec.resonance !== undefined) ops.push({ op: 'param', name: `${prefix}_resonance`, value: spec.resonance });
  if (spec.drive !== undefined) ops.push({ op: 'param', name: `${prefix}_drive`, value: spec.drive });
  if (spec.blend !== undefined) ops.push({ op: 'param', name: `${prefix}_blend`, value: spec.blend });
}

function compileEnv(envIndex, spec, ops) {
  const prefix = `env_${envIndex}`;
  const timeFields = ['delay', 'attack', 'hold', 'decay', 'release'];
  for (const f of timeFields) {
    if (spec[f] !== undefined) ops.push({ op: 'param', name: `${prefix}_${f}`, value: secToEnvRaw(spec[f]) });
  }
  // FINDING (see REPORT_PHASE1_M1.md "env sustain"): ValueDetails lists
  // env_N_sustain as kLinear (0..1, raw==value), but an offline measurement
  // (sustain=.5 raw -> measured output amplitude ratio -12.0dB, not the
  // -6.0dB a linear 0.5 amplitude fraction would give -- -12.0dB matches
  // 0.5^2 almost exactly) shows the ENGINE applies the envelope's output as
  // amplitude^2 when driving voice gain (same convention as osc level).
  // Converting human "sustain = perceived amplitude fraction" the same way
  // as level (sqrt()) makes the API's sustain value mean what it says.
  if (spec.sustain !== undefined) ops.push({ op: 'param', name: `${prefix}_sustain`, value: ampToLevelRaw(spec.sustain) });
  if (spec.power) {
    for (const f of ['attack', 'decay', 'release']) {
      if (spec.power[f] !== undefined) ops.push({ op: 'param', name: `${prefix}_${f}_power`, value: spec.power[f] });
    }
  }
}

// M11 FIX (see REPORT_M11.md "control diff" + "LFO retrigger mode"):
// lfo.draw({mode}) was already accepted into the descriptor (draw(), above
// -- 'trigger'/'sync'/'envelope'/'sustainEnvelope'/'loopPoint'/'loopHold')
// but compileLfo() never actually emitted an op for it -- confirmed via
// m11_control_diff.mjs that the native preset loader sets a real,
// non-default "lfo_N_sync_type" (SynthLfo::SyncType enum,
// synth_lfo.h/synth_parameters.cpp's lfo_parameter_list "sync_type" entry)
// on several actively-used LFOs that this grammar had silently left at 0
// (kTrigger) regardless of what the preset actually specified.
const LFO_MODE_NAMES = ['trigger', 'sync', 'envelope', 'sustainEnvelope', 'loopPoint', 'loopHold'];
function lfoModeToIndex(name) {
  const idx = LFO_MODE_NAMES.indexOf(name);
  if (idx < 0) throw new Error(`lfo.draw: unknown mode '${name}', expected one of ${LFO_MODE_NAMES.join(',')}`);
  return idx;
}

function compileLfo(lfoIndex, spec, ops) {
  const prefix = `lfo_${lfoIndex}`;
  if (spec.points) {
    const xs = new Float32Array(spec.points.length);
    const ys = new Float32Array(spec.points.length);
    const powers = new Float32Array(spec.points.length);
    spec.points.forEach((p, i) => { xs[i] = p[0]; ys[i] = p[1]; powers[i] = p[2] || 0; });
    ops.push({ op: 'lfoShape', lfo: lfoIndex, xs, ys, powers });
  }
  if (typeof spec.rate === 'string') {
    ops.push({ op: 'param', name: `${prefix}_sync`, value: 1 }); // "Tempo"
    ops.push({ op: 'param', name: `${prefix}_tempo`, value: tempoRateToIndex(spec.rate) });
  } else if (typeof spec.rate === 'number') {
    ops.push({ op: 'param', name: `${prefix}_sync`, value: 0 }); // "Seconds"
    ops.push({ op: 'param', name: `${prefix}_frequency`, value: hzToLfoFreqRaw(spec.rate) });
  }
  if (spec.mode) ops.push({ op: 'param', name: `${prefix}_sync_type`, value: lfoModeToIndex(spec.mode) });
  if (spec.delay) ops.push({ op: 'param', name: `${prefix}_delay_time`, value: spec.delay });
  if (spec.fade) ops.push({ op: 'param', name: `${prefix}_fade_time`, value: spec.fade });
}

// mods[]: {from, to, amount, bipolar, power}. `to` is "osc1.position" etc --
// mapped to the underlying Vital param name via the same prefix map used
// above. destination_scale is handled engine-side already (wrapper.cpp
// v2_connect_modulation uses Parameters::getParameterRange(dest), see
// REPORT_PHASE05.md) so `amount` here is a plain -1..1 fraction of the
// destination's full raw range -- NOT unit-aware (an `oct`/`semitones` unit
// on `mods[].unit` is accepted but not yet converted, see GRAMMAR.md
// "deviations": destination-specific mod-amount units are deferred to M2).
// M11 FIX (see REPORT_M11.md "control diff" + "LFO/env source range"): was
// only lfo1-4/env1-3 -- Vital actually has kNumLfos=8 and kNumEnvelopes=6
// (common/synth_constants.h). A mod from lfo5-8/env4-6 fell through to this
// map's `|| modSpec.from` raw-passthrough fallback as the LITERAL string
// 'lfo5' (no underscore) instead of the real control name 'lfo_5' --
// getModulationSource("lfo5") doesn't exist, so v2_connect_modulation()
// silently failed (returns 0, no connection made) for any mod sourced from
// lfo5-8/env4-6. Confirmed real: serum2strudel2.py's translated code for
// preset 05 (PLUCK - Guzheng Style) has a mod `from: 'lfo_5'` (its OWN
// build_mods() raw-passthrough already produces the correct underscored
// name when this map doesn't cover it -- the bug was JS-side only covering
// half the real range).
const SOURCE_NAME_MAP = {
  lfo1: 'lfo_1', lfo2: 'lfo_2', lfo3: 'lfo_3', lfo4: 'lfo_4',
  lfo5: 'lfo_5', lfo6: 'lfo_6', lfo7: 'lfo_7', lfo8: 'lfo_8',
  env1: 'env_1', env2: 'env_2', env3: 'env_3',
  env4: 'env_4', env5: 'env_5', env6: 'env_6',
};
const DEST_PATH_MAP = {
  'osc1.warp.amount': 'osc_1_distortion_amount',
  'osc2.warp.amount': 'osc_2_distortion_amount',
  'osc3.warp.amount': 'osc_3_distortion_amount',
  'osc1.position': 'osc_1_wave_frame', 'osc2.position': 'osc_2_wave_frame', 'osc3.position': 'osc_3_wave_frame',
  'osc1.level': 'osc_1_level', 'osc2.level': 'osc_2_level', 'osc3.level': 'osc_3_level',
  'osc1.transpose': 'osc_1_transpose', 'osc2.transpose': 'osc_2_transpose', 'osc3.transpose': 'osc_3_transpose',
  'filter1.cutoff': 'filter_1_cutoff', 'filter2.cutoff': 'filter_2_cutoff',
  'filter1.resonance': 'filter_1_resonance', 'filter2.resonance': 'filter_2_resonance',
};
// M4 FIX (see REPORT_M4.md "mods raw passthrough"): the readable DEST_PATH_MAP
// above only covers osc position/level/transpose and filter cutoff/resonance
// -- Serum 2 presets translated by serum2strudel2.py routinely modulate many
// more real Vital destinations (filter_fx_cutoff, distortion_drive,
// reverb_dry_wet, osc_N_distortion_amount, modulation_N_amount for
// mod-of-a-mod, ...) that have no readable name in this grammar yet. Rather
// than silently dropping those routings (which would audibly change the
// patch) or inventing readable names for dozens of FX/macro params ahead of
// need, a `to`/`from` value that is ALREADY a raw Vital param name (no dot,
// i.e. doesn't match the `wordN.field` shape) passes through unchanged --
// this is the same "raw escape hatch" spirit as `vitalPatch({ raw: {...} })`
// below, just for modulation routing instead of static param values.
function destPathToParam(path) {
  if (DEST_PATH_MAP[path]) return DEST_PATH_MAP[path];
  // fall back: "osc1.foo" -> "osc_1_foo"
  const m = /^([a-z]+)(\d+)\.(\w+)$/.exec(path);
  if (m) return `${m[1]}_${m[2]}_${m[3]}`;
  if (!path.includes('.')) return path; // raw passthrough (M4)
  throw new Error(`mods: unrecognized destination path '${path}'`);
}
function compileMod(modSpec, ops) {
  const src = SOURCE_NAME_MAP[modSpec.from] || modSpec.from;
  const dest = destPathToParam(modSpec.to);
  // M11 (see REPORT_M11.md "control diff"): optional `bipolar` (0 or 1) --
  // when a mod spec doesn't say, `bipolar` is left undefined and worklet.js/
  // render_strudel2.mjs's applyOps() pass -1 to v2_connect_modulation()'s
  // new bipolar arg, meaning "leave it at whatever createConnection()'s own
  // source-based default sets" (unchanged pre-M11 behavior). When present,
  // it's applied to the SAME connection slot v2_connect_modulation() just
  // resolved for this exact mod -- see that function's wrapper.cpp comment
  // for why a raw `modulation_N_bipolar` passthrough would be unsafe (slot
  // numbers depend on connection order, not on the original preset's own
  // numbering).
  const op = { op: 'mod', source: src, dest, amount: modSpec.amount };
  if (modSpec.bipolar !== undefined) op.bipolar = modSpec.bipolar ? 1 : 0;
  if (modSpec.range !== undefined) {
    if (!Number.isFinite(modSpec.range) || modSpec.range <= 0) throw new Error('mods.range must be positive');
    op.range = modSpec.range;
  }
  ops.push(op);
}

function deepMerge(base, override) {
  if (Array.isArray(override)) return override.slice();
  if (override && typeof override === 'object' && !(override instanceof Float32Array) && !override.__wtFrames && !override.__env && !override.__lfo) {
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    for (const k of Object.keys(override)) {
      out[k] = deepMerge(base ? base[k] : undefined, override[k]);
    }
    return out;
  }
  return override;
}

// M2 FIX (gain staging, item 2 "a patch-level output level"): a plain
// linear gain multiplier applied by worklet.js's renderPatchBlock() to
// THIS patch's summed output before it's mixed into the shared bus (see
// worklet.js "outputGain" handling). Deliberately NOT implemented via
// Vital's own "volume" engine parameter -- that control's raw<->dB
// conversion (ValueDetails::kSquareRoot, raw range [0,7399.4404] -> display
// dB = sqrt(raw)-80, verified in M13) is an authored engine parameter.
// Translation preserves it through raw.volume. output.level remains an
// independent JS-side multiplier for handwritten patches.
function compilePatch(spec) {
  const ops = [];
  for (const key of Object.keys(spec)) {
    if (/^osc\d+$/.test(key)) compileOscillator(Number(key.slice(3)), spec[key], ops);
    else if (/^filter\d+$/.test(key)) compileFilter(Number(key.slice(6)), spec[key], ops);
    else if (/^env\d+$/.test(key)) compileEnv(Number(key.slice(3)), spec[key], ops);
    else if (/^lfo\d+$/.test(key)) compileLfo(Number(key.slice(3)), spec[key], ops);
    else if (key === 'mods') { for (const m of spec.mods) compileMod(m, ops); }
    else if (key === 'output' && spec.output && spec.output.level !== undefined) {
      ops.push({ op: 'outputGain', value: Math.max(0, spec.output.level) });
    } else if (key === 'sample' && spec.sample) {
      // M12: patch-level (not per-osc) noise sample -- see buildSampleJson().
      // `sample_on`/`sample_level` themselves are plain scalar controls, set
      // via the normal raw: {} escape hatch by serum2strudel2.py (same
      // convention as everything else raw: {} carries) -- this op only
      // loads the PCM data itself, processed BEFORE raw: {} below so an
      // explicit raw.sample_on/sample_level (or a lfoN->sample_level mod)
      // still lands after the sample is loaded, same ordering guarantee
      // wavetableJson gets relative to osc_N_wave_frame.
      ops.push({ op: 'sampleJson', json: buildSampleJson(spec.sample) });
    }
  }
  // M4 FIX (see REPORT_M4.md "raw fallback"): `raw: { vital_param_name: value }`
  // is the documented escape hatch for anything this grammar's readable
  // osc/filter/env/lfo schema can't express yet (oscillator distortion/
  // spectral-morph params, filter style/mix, FX params, etc. -- see
  // serum2strudel2.py's RAW_CANDIDATES/STAGE_PARAMS-shaped list). Values are
  // ALREADY in raw Vital engine units (no unit conversion applied here) --
  // same convention as mods[].amount being a raw destination-range fraction.
  // Processed last so it can override anything set above via the readable
  // fields (matches how a human editing generated code would expect a
  // trailing `raw:` block to win).
  if (spec.raw && typeof spec.raw === 'object') {
    for (const name of Object.keys(spec.raw)) {
      ops.push({ op: 'param', name, value: spec.raw[name] });
    }
  }
  return ops;
}

function vitalPatch(spec) {
  const id = hashString(stableStringify(spec));
  return { __patch: true, id, spec, get ops() { return compilePatch(this.spec); } };
}
vitalPatch.extend = function extend(base, overrides) {
  const mergedSpec = deepMerge(base.spec, overrides);
  return vitalPatch(mergedSpec);
};

// .vset({path: value|pattern-string}) -> per-event raw param overrides.
// Values that are Strudel mininotation pattern strings (e.g. "<400 1200>")
// are left as-is for strudel2.js to resolve via Strudel's own pattern
// query at each hap's onset (this module has no Strudel dependency); plain
// numbers are unit-converted here using the same per-path table so both
// paths produce identical raw units.
function vsetPathToRawSetter(path, spec) {
  const paramName = destPathToParam(path.includes('.') && !DEST_PATH_MAP[path] && !/^[a-z]+\d+\.\w+$/.test(path) ? path : path);
  const isCutoff = /cutoff$/.test(paramName) && /^filter_/.test(paramName);
  const isEnvTime = /^env_\d+_(delay|attack|hold|decay|release)$/.test(paramName);
  const isEnvSustain = /^env_\d+_sustain$/.test(paramName);
  const isLevel = /_level$/.test(paramName) && !/_serum_linear_level$/.test(paramName);
  const oscLevel = /^osc_(\d+)_level$/.exec(paramName);
  const rawLevelCurve = oscLevel && spec?.raw?.[`osc_${oscLevel[1]}_serum_linear_level`];
  const linearLevel = oscLevel && (rawLevelCurve !== undefined ? rawLevelCurve >= .5 : spec?.[`osc${oscLevel[1]}`]?.levelCurve === 'linear');
  return {
    paramName,
    convert(v) {
      if (isCutoff) return hzToCutoffRaw(v);
      if (isEnvTime) return secToEnvRaw(v);
      if (isEnvSustain) return ampToLevelRaw(v);
      if (isLevel) return linearLevel ? Math.max(0, Math.min(1, v)) : ampToLevelRaw(v);
      return v;
    },
  };
}

const units = { hzToCutoffRaw, cutoffRawToHz, secToEnvRaw, ampToLevelRaw, hzToLfoFreqRaw, tempoRateToIndex, filterModelToIndex, ENV_TIME_MAX_RAW };

// ESM-native (file is .mjs so Node's loader treats it as ESM regardless of
// package.json, and any static file server delivers it byte-for-byte to the
// browser's own ESM `import()` -- see strudel2.js/tests/phase1_grammar.mjs
// for both consumers).
export { wt, env, lfo, vitalPatch, units, destPathToParam, vsetPathToRawSetter, compilePatch, WAVE_SIZE };
