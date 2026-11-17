import { frameAt, decodePayload, meaning } from './core.js';

export const SCENARIOS = Object.freeze([
  { id: 'heartbeat', label: 'Normal heartbeat', preview: 'Two heartbeats, one second apart: vehicle type, autopilot and standby state.' },
  { id: 'gps', label: 'Suspicious GPS sequence', preview: 'Synthetic GPS positions move about 1.1 km in one second, with valid checksums.' },
  { id: 'altitude-control', label: 'Unexpected altitude / control sequence', preview: 'Synthetic relative altitude rises 100 m in two seconds; an altitude-change command is also present.' },
  { id: 'crc', label: 'Corrupted CRC', preview: 'One heartbeat with a deliberately changed checksum byte. The parser must reject it.' },
]);
export const scenarioById = id => SCENARIOS.find(scenario => scenario.id === id) || null;

// Observations use only frames accepted by C/Wasm; CRC failures never become telemetry.
export function observeTelemetry(result) {
  const telemetry = [];
  const findings = [];
  const previous = new Map();
  const limit = Math.min(result.frameCount, 10000);
  for (let index = 0; index < limit; index++) {
    const frame = frameAt(result, index);
    if (![0, 24, 33, 76].includes(frame.msgid)) continue;
    const header = result.bytes[frame.off] === 0xfe ? 6 : 10;
    const decoded = decodePayload(frame.msgid, result.bytes.subarray(frame.off + header, frame.off + header + frame.len), header === 6 ? 1 : 2);
    const fields = Object.fromEntries(decoded.fields.map(field => [field.name, field]));
    const value = name => fields[name]?.value;
    const human = name => {
      const text = fields[name]?.meaning;
      if (!text) return String(value(name));
      if (text === 'MAV_AUTOPILOT_ARDUPILOTMEGA') return 'ArduPilotMega';
      const words = text.replace(/^(MAV_TYPE_|MAV_AUTOPILOT_|MAV_STATE_|GPS_FIX_TYPE_|MAV_CMD_)/, '').replaceAll('_', ' ').toLowerCase();
      return words.charAt(0).toUpperCase() + words.slice(1);
    };
    const source = `System ${frame.sysid}, component ${frame.compid}`;
    const reading = { name: decoded.name, source, timestamp: frame.ts, values: [] };
    if (frame.msgid === 0) reading.values = [['Vehicle', human('type')], ['Autopilot', human('autopilot')], ['State', human('system_status')], ['Armed', (value('base_mode') & 128) ? 'Yes' : 'No']];
    if (frame.msgid === 24) reading.values = [['Latitude', human('lat')], ['Longitude', human('lon')], ['Altitude above mean sea level', human('alt')], ['GPS fix', human('fix_type')], ['Satellites', String(value('satellites_visible'))]];
    if (frame.msgid === 33) reading.values = [['Relative altitude', human('relative_alt')], ['Altitude above mean sea level', human('alt')], ['Latitude', human('lat')], ['Longitude', human('lon')]];
    if (frame.msgid === 76) {
      reading.values = [['Command', human('command')], ['Target system', String(value('target_system'))], ['Target component', String(value('target_component'))]];
      if (value('command') === 186) {
        const frameName = meaning({ enum: 'MAV_FRAME' }, value('param2')) || String(value('param2'));
        reading.values.push(['Requested altitude', `${value('param1')} m`], ['Coordinate frame', frameName]);
        if (findings.length < 100) findings.push({ kind: 'context', text: `Altitude-change command observed for system ${value('target_system')}, component ${value('target_component')}; requested altitude ${value('param1')} m (${frameName}). Receipt does not prove execution or authorization.` });
      }
    }
    // Keep the most recent reading of each message/source, with bounded UI output.
    const key = `${frame.sysid}:${frame.compid}:${frame.msgid}`;
    const prior = previous.get(key);
    const seconds = prior ? (frame.ts - prior.frame.ts) / 1e6 : NaN;
    if (seconds > 0 && seconds <= 5 && !result.timestampReversals) {
      if (frame.msgid === 24 && value('fix_type') >= 3 && prior.values.fix_type >= 3 &&
          [value('lat'), prior.values.lat].every(lat => Math.abs(lat) <= 900000000) &&
          [value('lon'), prior.values.lon].every(lon => Math.abs(lon) <= 1800000000)) {
        const rad = degrees => degrees * Math.PI / 180;
        const lat = value('lat') / 1e7, oldLat = prior.values.lat / 1e7;
        const a = Math.sin(rad(lat - oldLat) / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(oldLat)) * Math.sin(rad((value('lon') - prior.values.lon) / 1e7) / 2) ** 2;
        const distance = 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
        if (distance / seconds > 100 && findings.length < 100) findings.push({ kind: 'context', text: `${source}: GPS position changed ${distance.toFixed(0)} m in ${seconds.toFixed(1)} s (${(distance / seconds).toFixed(0)} m/s), above the 100 m/s review threshold.` });
      }
      if (frame.msgid === 33) {
        const change = (value('relative_alt') - prior.values.relative_alt) / 1000;
        if (Math.abs(change / seconds) > 20 && findings.length < 100) findings.push({ kind: 'context', text: `${source}: relative altitude changed ${change.toFixed(1)} m in ${seconds.toFixed(1)} s (${(change / seconds).toFixed(1)} m/s), above the 20 m/s review threshold.` });
      }
    }
    const slot = telemetry.findIndex(item => item.key === key);
    if (slot >= 0) telemetry[slot] = { ...reading, key };
    else if (telemetry.length < 12) telemetry.push({ ...reading, key });
    previous.set(key, { frame, values: Object.fromEntries(decoded.fields.map(field => [field.name, field.value])) });
  }
  return { telemetry, findings: findings.slice(0, 100), limited: result.frameCount > limit };
}
