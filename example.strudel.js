// On https://strudel.cc, load the pinned public GitHub release through jsDelivr.
const { readyPatch } = await import('https://cdn.jsdelivr.net/gh/gyujeongion/ion-code-synth@v0.1.0/ready_patch.js')
const voice = vitalPatch({
  osc1: { wave: wt.harmonics([1, 0.5, 0.2]), level: 0.35 },
  env1: env.dahdsr({ attack: 0.01, decay: 0.4, sustain: 0.6, release: 0.3 }),
})
await readyPatch(voice)
setcpm(120/4)
note('c3').s('vital').vpatch(voice)
