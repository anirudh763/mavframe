import test from 'node:test';
import assert from 'node:assert/strict';
import { meaning, decodePayload } from '../../docs/js/core.js';

test('unsigned bit 31 and BigInt flags retain the official enum name', () => {
  assert.equal(meaning({ enum: 'MAV_SYS_STATUS_SENSOR' }, 2147483648), 'MAV_SYS_STATUS_EXTENSION_USED');
  assert.equal(meaning({ enum: 'HIL_SENSOR_UPDATED_FLAGS' }, 2147483648n), 'HIL_SENSOR_UPDATED_RESET');
});

test('v1 omits extension fields while v2 identifies partial and reconstructed wire values', () => {
  const v1 = decodePayload(24, new Uint8Array(30), 1);
  assert.ok(v1.fields.every(field => !field.ext));
  const v2 = decodePayload(24, new Uint8Array(2), 2);
  const timestamp = v2.fields.find(field => field.name === 'time_usec');
  assert.equal(timestamp.wireBytes, 2);
  assert.equal(timestamp.zeroFilled, true);
  assert.equal(timestamp.value, 0n);
  assert.ok(v2.fields.some(field => field.ext && field.wireBytes === 0 && field.zeroFilled));
});
