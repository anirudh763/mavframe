import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadParser, analyze, decodePayload } from '../../docs/js/core.js';
import { SCENARIOS, scenarioById, observeTelemetry } from '../../docs/js/scenarios.js';

const root = new URL('../../', import.meta.url);
const parser = await loadParser(fs.readFileSync(new URL('docs/mavframe.wasm', root)));
const read = id => new Uint8Array(fs.readFileSync(new URL(`docs/sample/scenario-${id}.tlog`, root)));
const decode = (id, options = {}) => analyze(read(id), { parser, name: `${id}.tlog`, ...options });

test('scenario IDs are allowlisted, never paths or arbitrary URLs', () => {
  for (const scenario of SCENARIOS) assert.equal(scenarioById(scenario.id), scenario);
  for (const value of [null, '', '../crc', 'HEARTBEAT', 'https://example.com']) assert.equal(scenarioById(value), null);
});

for (const [id, valid, crc] of [['heartbeat', 2, 0], ['gps', 2, 0], ['altitude-control', 3, 0], ['crc', 0, 1]]) {
  test(`${id}: actual native C and Wasm accept/reject the same fixture`, async () => {
    const bytes = read(id);
    const native = spawnSync(new URL('build/mavframe-dump', root).pathname, { input: bytes });
    assert.equal(native.status, 0, native.stderr.toString());
    assert.match(native.stderr.toString(), new RegExp(`frames=${valid} bad_crc=${crc} unknown_msgid=0 bad_flags=0`));
    const result = await decode(id);
    assert.deepEqual([result.validFrames, result.crcErrors, result.gaps, result.rejects, result.unsupported], [valid, crc, 0, 0, 0]);
    const rows = native.stdout.toString().trim().split('\n').filter(Boolean);
    assert.equal(rows.length, valid);
    for (let i = 0; i < rows.length; i++) assert.match(rows[i], new RegExp(`off=${result.frames.off[i]} version=2 msgid=${result.frames.msgid[i]} `));
  });
}

test('normal heartbeat exposes actual unarmed standby telemetry without threshold findings', async () => {
  const observed = observeTelemetry(await decode('heartbeat'));
  assert.equal(observed.findings.length, 0);
  assert.deepEqual(observed.telemetry[0].values, [['Vehicle', 'Quadrotor'], ['Autopilot', 'ArduPilotMega'], ['State', 'Standby'], ['Armed', 'No']]);
});

test('GPS rate uses decoded positions and elapsed capture time; missing/reversed time disables rate heuristics', async () => {
  const result = await decode('gps');
  assert.match(observeTelemetry(result).findings[0].text, /1112 m in 1.0 s \(1112 m\/s\)/);
  result.frames.ts[1] = result.frames.ts[0];
  assert.equal(observeTelemetry(result).findings.length, 0);
  result.frames.ts[1] = NaN;
  assert.equal(observeTelemetry(result).findings.length, 0);
  result.frames.ts[1] = result.frames.ts[0] + 6e6;
  assert.equal(observeTelemetry(result).findings.length, 0);
  result.frames.ts[1] = result.frames.ts[0] + 1e6;
  result.timestampReversals = 1;
  assert.equal(observeTelemetry(result).findings.length, 0);
});

test('context checks do not combine different senders or invalid GPS coordinates', async () => {
  const result = await decode('gps');
  result.frames.hdr[6] = 2;
  assert.equal(observeTelemetry(result).findings.length, 0);
  result.frames.hdr[6] = 1;
  new DataView(result.bytes.buffer).setInt32(result.frames.off[1] + 10 + 8, 910000000, true);
  assert.equal(observeTelemetry(result).findings.length, 0);
});

test('altitude and command are separate observations, never execution or attack verdicts', async () => {
  const observed = observeTelemetry(await decode('altitude-control'));
  assert.equal(observed.findings.length, 2);
  assert.match(observed.findings[0].text, /requested altitude 110 m \(MAV_FRAME_GLOBAL_RELATIVE_ALT\).*does not prove execution or authorization/);
  assert.match(observed.findings[1].text, /100.0 m in 2.0 s \(50.0 m\/s\)/);
});

test('DO_CHANGE_ALTITUDE fixture matches vendored command schema, altitude param1 and frame param2', async () => {
  const xml = fs.readFileSync(new URL('tools/mavlink-xml/common.xml', root), 'utf8');
  const command = xml.match(/<entry value="186" name="MAV_CMD_DO_CHANGE_ALTITUDE"[\s\S]*?<\/entry>/)[0];
  assert.match(command, /<param index="1"[^>]*units="m"[^>]*>Altitude/);
  assert.match(command, /<param index="2"[^>]*enum="MAV_FRAME"/);
  const result = await decode('altitude-control');
  const index = [...result.frames.msgid].indexOf(76);
  const off = result.frames.off[index] + 10;
  const decoded = decodePayload(76, result.bytes.subarray(off, off + result.frames.hdr[index * 5 + 3]));
  const fields = Object.fromEntries(decoded.fields.map(field => [field.name, field.value]));
  assert.deepEqual([fields.command, fields.param1, fields.param2, fields.param7], [186, 110, 3, 0]);
});

test('CRC-rejected bytes never become contextual telemetry', async () => {
  const observed = observeTelemetry(await decode('crc'));
  assert.deepEqual(observed.telemetry, []);
  assert.deepEqual(observed.findings, []);
});
