import { LIVE_RETAIN_BYTES } from './live-core.js';

const $ = id => document.getElementById(id);
const fmt = number => number.toLocaleString('en-US');

function parserWorker(progress = () => {}) {
  const worker = new Worker(new URL('./tools-worker.js', import.meta.url), { type: 'module' });
  let pending = null, nextId = 0, stopped = null;
  const reject = error => { if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; } };
  const close = error => { stopped = error; reject(error); worker.terminate(); };
  worker.onmessage = ({ data }) => {
    if (data.progress !== undefined) { progress(data.progress); return; }
    if (!pending || data.id !== pending.id) return;
    const current = pending; pending = null; clearTimeout(current.timer);
    if (data.error) current.reject(new Error(data.error)); else current.resolve(data.result);
  };
  worker.onerror = event => { event.preventDefault(); close(new Error('The native parser worker stopped. Reconnect or try the file inspector.')); };
  return {
    request(command, values = {}, transfer = []) {
      if (stopped) return Promise.reject(stopped);
      if (pending) return Promise.reject(new Error('The parser worker is still processing the previous read.'));
      return new Promise((resolve, fail) => {
        const id = ++nextId;
        pending = { id, resolve, reject: fail, timer: setTimeout(() => close(new Error('Parser response timed out. Reconnect to start a new session.')), 15000) };
        try { worker.postMessage({ id, command, ...values }, transfer); }
        catch (error) { reject(error); }
      });
    },
    close() { close(new DOMException('Operation cancelled', 'AbortError')); },
  };
}

export function wireSerial({ inspectCapture, selectedFrame }) {
  let session = null, opening = false, closing = null, fuzz = null, renderTimer = null;
  let summary = null, retained = null;
  const status = text => { $('live-status').textContent = text; };
  const supported = window.isSecureContext && !!navigator.serial?.requestPort;
  function controls() {
    $('connect-radio').disabled = !supported || opening || !!session;
    $('serial-baud').disabled = opening || !!session;
    $('disconnect-radio').disabled = !session || !!closing;
    $('inspect-live').disabled = (!session && !retained?.bytes.length) || !!closing;
  }
  function render() {
    renderTimer = null;
    if (!summary) return;
    const values = { 'live-bytes': fmt(summary.bytes), 'live-frames': fmt(summary.stats.frames), 'live-crc': fmt(summary.stats.bad_crc), 'live-gaps': fmt(summary.gaps), 'live-unsupported': fmt(summary.stats.unknown_msgid), 'live-rejected': fmt(summary.stats.bad_flags), 'live-retained': fmt(summary.retained_bytes), 'live-discarded': fmt(summary.discarded_history_bytes), 'live-rate': summary.rate_hz === null ? 'n/a' : summary.rate_hz.toFixed(2) + ' Hz' };
    for (const [id, text] of Object.entries(values)) $(id).textContent = text;
    const labels = { 1: 'Valid CRC', 2: 'CRC failed', 3: 'Unsupported', 4: 'Bad flags' };
    const rows = summary.recent.map(event => {
      const row = document.createElement('tr');
      for (const value of [event.offset, event.sysid + ':' + event.compid, event.message, event.seq, labels[event.status] || 'Unknown']) {
        const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell);
      }
      return row;
    });
    $('live-events').replaceChildren(...rows);
  }
  function show(next) { summary = next; if (!renderTimer) renderTimer = setTimeout(render, 200); }
  async function read(current) {
    const reader = current.reader;
    try {
      while (!current.stopping) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (value.byteLength > 1024 * 1024) throw new Error('Serial driver returned an oversized read. Reconnect with a smaller buffer.');
        const arrivalMs = performance.now();
        for (let offset = 0; offset < value.byteLength && !current.stopping; offset += 65536) {
          const bytes = value.slice(offset, offset + 65536);
          show(await current.rpc.request('feed', { bytes: bytes.buffer, arrivalMs }, [bytes.buffer]));
        }
      }
    } catch (error) { if (!current.stopping) current.problem = error.message; }
    finally { try { reader.releaseLock(); } catch { /* Port removal can already release its reader. */ } }
  }
  async function inspectRetained() {
    if (!retained?.bytes.length) {
      status('No bytes retained. Connect and receive data first.');
      return;
    }
    await inspectCapture(retained.bytes, `Retained tail: ${fmt(retained.bytes.length)} of ${fmt(retained.summary.bytes)} serial bytes; ${fmt(retained.discarded)} earlier bytes discarded. Fragment boundaries and timestamps are unavailable.`);
  }
  async function stop(inspect = false) {
    if (closing) return closing;
    if (!session) { if (inspect) await inspectRetained(); return; }
    const current = session;
    current.stopping = true;
    clearTimeout(current.deadline);
    closing = (async () => {
      let snapshot;
      try {
        try { await current.reader.cancel(); } catch { /* Disconnected ports can reject cancellation. */ }
        await current.reading;
        snapshot = await current.rpc.request('snapshot');
        retained = snapshot;
        show(snapshot.summary);
      } catch (error) { current.problem ||= error.message; }
      finally {
        current.rpc.close();
        try { await current.port.close(); } catch (error) { current.problem ||= `Could not close the port: ${error.message}`; }
        session = null;
      }
      status((current.problem ? `Disconnected: ${current.problem}` : 'Radio disconnected.') + (retained?.bytes.length ? ' Retained bytes are available until a new session or page close.' : ' No bytes retained.'));
      if (inspect) await inspectRetained();
    })();
    controls();
    try { await closing; } finally { closing = null; controls(); }
  }
  $('connect-radio').addEventListener('click', async () => {
    if (!supported || opening || session) return;
    opening = true; controls();
    let port, rpc;
    try {
      const baudRate = Number($('serial-baud').value);
      if (![57600, 115200, 230400, 460800, 921600].includes(baudRate)) throw new Error('Choose one of the listed baud rates.');
      port = await navigator.serial.requestPort();
      await port.open({ baudRate, bufferSize: 65536 });
      if (!port.readable) throw new Error('The selected port has no readable stream.');
      rpc = parserWorker();
      show(await rpc.request('start'));
      retained = null;
      const current = { port, rpc, reader: port.readable.getReader(), stopping: false, problem: '' };
      session = current;
      current.deadline = setTimeout(() => { current.problem = '30-minute session limit reached. Reconnect for another capture.'; stop().catch(error => status(error.message)); }, 30 * 60 * 1000);
      current.reading = read(current);
      current.reading.then(() => { if (session === current && !current.stopping) stop().catch(error => status(error.message)); });
      status('Connected. Reading serial bytes with C/Wasm; nothing is uploaded.');
    } catch (error) {
      rpc?.close();
      try { await port?.close(); } catch { /* A failed open need not leave an open port. */ }
      status(error.name === 'NotFoundError' ? 'No radio selected. Choose a port when ready.' : `Could not connect: ${error.message}`);
    } finally { opening = false; controls(); }
  });
  $('disconnect-radio').addEventListener('click', () => stop().catch(error => status(error.message)));
  $('inspect-live').addEventListener('click', () => stop(true).catch(error => status(error.message)));
  navigator.serial?.addEventListener('disconnect', event => { if (session && (event.target === session.port || event.port === session.port)) stop().catch(error => status(error.message)); });
  status(supported ? 'Choose a USB telemetry radio.' : 'Web Serial needs a secure context and supported desktop browser. Use Open capture file.');
  controls();

  $('run-fuzz').addEventListener('click', async () => {
    if (fuzz) return;
    const frame = selectedFrame();
    if (!frame) { $('fuzz-status').textContent = 'Load a capture with a valid frame before running this finite fuzz batch.'; return; }
    const current = parserWorker(count => { $('fuzz-status').textContent = `C/Wasm calls completed: ${count} / 1,000`; });
    fuzz = current; $('run-fuzz').disabled = true; $('cancel-fuzz').disabled = false;
    try {
      const result = await current.request('fuzz', { frame: frame.buffer }, [frame.buffer]);
      $('fuzz-status').textContent = `${result.calls} actual C/Wasm calls in ${result.elapsed_ms.toFixed(1)} ms; ${result.frames} valid, ${result.bad_crc} CRC candidates rejected, ${result.unknown_msgid} unknown IDs, ${result.bad_flags} unsupported flags. Seed ${result.seed}. No trap observed in this finite batch; not a security certification.`;
    } catch (error) { $('fuzz-status').textContent = error.name === 'AbortError' ? 'Fuzz batch cancelled; worker terminated.' : `Fuzz batch failed: ${error.message}`; }
    finally { current.close(); fuzz = null; $('run-fuzz').disabled = false; $('cancel-fuzz').disabled = true; }
  });
  $('cancel-fuzz').addEventListener('click', () => fuzz?.close());
  window.addEventListener('pagehide', () => {
    retained = null;
    fuzz?.close();
    if (session) {
      const current = session;
      session = null; controls();
      current.stopping = true; clearTimeout(current.deadline); current.rpc.close();
      current.reader.cancel().catch(() => {});
      current.reading.finally(() => current.port.close()).catch(() => {});
      status('Radio disconnected when leaving this page.');
    }
  });
}
