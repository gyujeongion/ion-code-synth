// loader.js: loads the Vital-engine AudioWorklet into any page's
// AudioContext. Usage:
//
//   import { loadVitalV2 } from './loader.js';
//   const v2 = await loadVitalV2(audioContext, './build/vital_engine_simd.js');
//   v2.node.connect(audioContext.destination);
//   v2.noteOn(60, 0.8, audioContext.currentTime);
//   v2.noteOff(60, audioContext.currentTime + 0.5);
//   v2.setParam('filter_1_cutoff', 80);
//
// Design: the wasm-embedding JS glue (built with SINGLE_FILE=1, so the
// .wasm binary is inlined as base64 -- no separate binary fetch needed) is
// fetched HERE on the main thread (where `fetch` exists), then its full
// source text is posted into the AudioWorkletProcessor, which eval()s it
// inside AudioWorkletGlobalScope and calls the MODULARIZE factory itself.
// This sidesteps AudioWorkletGlobalScope's lack of `fetch`/`importScripts`
// for cross-origin module loading without needing pthreads or
// SharedArrayBuffer -- the whole thing is single-threaded and synchronous
// from the processor's point of view.
export async function loadVitalV2(audioContext, glueUrl, opts = {}) {
  const glueSource = await (await fetch(glueUrl)).text();

  await audioContext.audioWorklet.addModule(
    new URL('./worklet.js', import.meta.url).href
  );

  const node = new AudioWorkletNode(audioContext, 'vital-v2-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  const readyPromise = new Promise((resolve, reject) => {
    node.port.onmessage = (ev) => {
      if (ev.data.type === 'ready') resolve();
      else if (ev.data.type === 'error') reject(new Error(ev.data.message));
    };
  });

  node.port.postMessage({
    type: 'init',
    glueSource,
    sampleRate: audioContext.sampleRate,
    maxBlock: opts.maxBlock || 128,
  });

  await readyPromise;

  const api = {
    node,
    ctx: audioContext,
    noteOn(midi, velocity = 0.8, time = audioContext.currentTime) {
      node.port.postMessage({ type: 'event', event: { frameTimeSec: time, kind: 'noteOn', midi, velocity } });
    },
    noteOff(midi, time = audioContext.currentTime) {
      node.port.postMessage({ type: 'event', event: { frameTimeSec: time, kind: 'noteOff', midi } });
    },
    setParam(name, value, time = audioContext.currentTime) {
      node.port.postMessage({ type: 'event', event: { frameTimeSec: time, kind: 'param', name, value } });
    },
    loadWavetableFrame(osc, frameIndex, samples) {
      node.port.postMessage({ type: 'loadWavetable', osc, frame: frameIndex, samples });
    },
    // --- Phase 1 multi-patch API ---
    registerPatch(patchId, ops) {
      node.port.postMessage({ type: 'registerPatch', patchId, ops });
    },
    patchNoteOn(patchId, midi, velocity = 0.8, time = audioContext.currentTime) {
      node.port.postMessage({ type: 'patchEvent', patchId, event: { frameTimeSec: time, kind: 'noteOn', midi, velocity } });
    },
    patchNoteOff(patchId, midi, time = audioContext.currentTime) {
      node.port.postMessage({ type: 'patchEvent', patchId, event: { frameTimeSec: time, kind: 'noteOff', midi } });
    },
    patchVset(patchId, vsetOps, time = audioContext.currentTime) {
      node.port.postMessage({ type: 'patchEvent', patchId, event: { frameTimeSec: time, kind: 'vset', vsetOps } });
    },
  };
  return api;
}
