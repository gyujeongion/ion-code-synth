# Browser synth extension for Strudel

Experimental extension: live coded wavetable synthesis inside the [Strudel editor](https://strudel.cc). It adds `vitalPatch`, `wt.harmonics`, `env.dahdsr`, `lfo.draw`, `.vpatch()` and `.vset()` as JavaScript APIs. It does not change Strudel's parser or promise Serum-identical audio.

## Try it

Paste [example.strudel.js](example.strudel.js) into the Strudel editor and press Control+Enter. The example loads a pinned release through jsDelivr and constructs the sound in code. No sample recording or Serum plugin is used at playback time.

```js
const { readyPatch } = await import('https://cdn.jsdelivr.net/gh/gyujeongion/ion-code-synth@v0.1.0/ready_patch.js')
const voice = vitalPatch({
  osc1: { wave: wt.harmonics([1, 0.5, 0.2]), level: 0.35 },
  env1: env.dahdsr({ attack: 0.01, decay: 0.4, sustain: 0.6, release: 0.3 }),
})
await readyPatch(voice)
note('c3').s('vital').vpatch(voice)
```

This release includes the 10 MB browser engine, JavaScript grammar and AudioWorklet bridge. The [source archive](source.tar.gz) contains the Vital base tree, our C++ modifications, Emscripten build script, and browser JavaScript. The pinned Vital base source is `ZXMushroom63/vital` commit `946c8c0`; the source archive uses a relocatable path. Rebuild with Emscripten 6.0.9 or compatible from `source/strudel2/engine/build.sh`. This is a source snapshot, not a reproducible-build checksum guarantee.

## License and limits

The browser bridge is AGPLv3; modified Vital engine code remains GPLv3. See [LICENSE](LICENSE), [VITAL_LICENSE](VITAL_LICENSE), and upstream [Strudel](https://codeberg.org/uzu/strudel) and [Vital](https://github.com/mtytel/vital) projects. Third-party source notices are retained in the archive. This repository contains no author's preset, song, MIDI, or audio recording.

Browser playback was confirmed on https://strudel.cc using the pinned public jsDelivr URL in headless Chromium: the patch registered and the AudioWorklet produced audio (peak 0.289, RMS 0.088).
