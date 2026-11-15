import { loadParser, rawEvents } from './core.js';
import { liveAnalyzer } from './live-core.js';

let parser, live;
const ready = () => parser ? Promise.resolve(parser) : loadParser(new URL('../mavframe.wasm', import.meta.url)).then(value => (parser = value));
self.onmessage = async ({ data }) => {
  try {
    const engine = await ready();
    if (data.command === 'start') {
      if (live) throw new Error('A live session is already active.');
      live = liveAnalyzer(engine);
      self.postMessage({ id: data.id, result: live.summary() });
    } else if (data.command === 'feed') {
      if (!live) throw new Error('No live parser session.');
      self.postMessage({ id: data.id, result: live.feed(new Uint8Array(data.bytes), data.arrivalMs) });
    } else if (data.command === 'snapshot') {
      if (!live) throw new Error('No live parser session.');
      const result = live.snapshot();
      self.postMessage({ id: data.id, result }, [result.bytes.buffer]);
    } else if (data.command === 'fuzz') {
      if (live) throw new Error('Fuzzing requires a separate parser worker.');
      const original = new Uint8Array(data.frame);
      if (!original.length || original.length > 280) throw new Error('Load a valid frame before fuzzing.');
      const started = performance.now();
      let seed = 0x5eed1234;
      const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
      const totals = { calls: 0, frames: 0, bad_crc: 0, unknown_msgid: 0, bad_flags: 0, bytes: 0 };
      for (let i = 0; i < 1000; i++) {
        let bytes;
        if (i % 5 === 0) bytes = original.slice();
        else if (i % 5 === 1) bytes = new Uint8Array(0);
        else if (i % 5 === 2) { bytes = new Uint8Array(random() % 281); for (let k = 0; k < bytes.length; k++) bytes[k] = random() & 255; }
        else if (i % 5 === 3) { bytes = original.slice(); bytes[random() % bytes.length] ^= 1 << (random() % 8); }
        else bytes = original.slice(0, random() % original.length);
        const result = rawEvents(engine, bytes, bytes.length ? [bytes.length] : []);
        totals.calls++;
        for (const key of ['frames', 'bad_crc', 'unknown_msgid', 'bad_flags', 'bytes']) totals[key] += result.stats[key];
        if ((i + 1) % 50 === 0) {
          self.postMessage({ progress: i + 1 });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      self.postMessage({ id: data.id, result: { ...totals, elapsed_ms: performance.now() - started, seed: '0x5eed1234' } });
    } else throw new Error('Unknown worker operation.');
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
