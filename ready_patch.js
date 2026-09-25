// Register an authored synth patch before starting a Strudel pattern.
import './strudel2.js';
const readyIds = new Set();

export async function readyPatch(patch) {
  if (!patch?.id || !Array.isArray(patch.ops)) throw new Error('Invalid vitalPatch');
  if (readyIds.has(patch.id)) return patch;
  const v2 = globalThis.__v2;
  if (!v2) throw new Error('Synth engine did not initialize');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      v2.node.port.removeEventListener('message', onMessage);
      reject(new Error(`Synth patch ${patch.id} took too long to load`));
    }, 30000);
    function onMessage(event) {
      const data = event.data || {};
      if (data.type === 'patchReady' && data.patchId === patch.id) finish();
      else if (data.type === 'error' && String(data.message).includes(patch.id)) finish(new Error(data.message));
    }
    function finish(error) {
      clearTimeout(timer);
      v2.node.port.removeEventListener('message', onMessage);
      if (error) reject(error);
      else resolve();
    }
    v2.node.port.addEventListener('message', onMessage);
    v2.registerPatch(patch.id, patch.ops);
  });
  readyIds.add(patch.id);
  return patch;
}
