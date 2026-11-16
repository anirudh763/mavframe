import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, startServer } from './browser.mjs';
import { MESSAGE_NAMES, MESSAGES } from '../../docs/js/msgdefs.js';

let server, base, browser;
before(async () => {
  ({ server, base } = await startServer());
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
});
after(async () => { await browser?.close(); server?.close(); });

const xml = `<mavlink name="test-extension"><messages><message id="60000" name="CUSTOM_PACKET"><description>Test custom fields.</description><field type="uint8_t" name="kind"/><field type="uint16_t" name="count"/><extensions/><field type="uint8_t[2]" name="tail"/></message></messages></mavlink>`;
function x25(data, crc = 0xffff) {
  for (const value of data) { let tmp = (value ^ (crc & 255)) & 255; tmp = (tmp ^ (tmp << 4)) & 255; crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff; }
  return crc;
}
function customFrame(extra) {
  const payload = Uint8Array.of(0x34, 0x12, 7, 9, 8);
  const frame = new Uint8Array(10 + payload.length + 2);
  frame.set([0xfd, payload.length, 0, 0, 1, 1, 1, 0x60, 0xea, 0], 0); frame.set(payload, 10);
  let crc = x25(frame.subarray(1, 10 + payload.length)); crc = x25(Uint8Array.of(extra), crc);
  frame[15] = crc & 255; frame[16] = crc >> 8;
  return frame;
}

test('pinned common plus ArduPilotMega payload and CRC definitions cover the full generated map', () => {
  assert.equal(Object.keys(MESSAGE_NAMES).length, 326);
  assert.equal(Object.keys(MESSAGES).length, 326);
  for (const [id, def] of Object.entries(MESSAGES)) {
    assert.equal(Number(id), def.id);
    assert.ok(Number.isInteger(def.crc_extra) && def.crc_extra >= 0 && def.crc_extra <= 255);
    assert.ok(def.fields.every((field, index) => index === 0 || field.offset >= def.fields[index - 1].offset));
  }
});

test('custom fields, arrays, extensions and CRC_EXTRA are accepted by the C/Wasm parser', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base + '#/');
    const result = await page.evaluate(async source => {
      const dialectModule = await import('./js/custom-dialect.js');
      const core = await import('./js/core.js');
      const defs = dialectModule.parseCustomDialectXml(source);
      const parser = await core.loadParser(new URL('./mavframe.wasm', location.href));
      const bytes = new Uint8Array([253, 5, 0, 0, 1, 1, 1, 0x60, 0xea, 0, 0x34, 0x12, 7, 9, 8, 0, 0]);
      let crc = 0xffff;
      const accumulate = value => { let tmp = (value ^ (crc & 255)) & 255; tmp = (tmp ^ (tmp << 4)) & 255; crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff; };
      for (const value of bytes.subarray(1, 15)) accumulate(value);
      accumulate(defs.messages[60000].crc_extra); bytes[15] = crc & 255; bytes[16] = crc >> 8;
      const parsed = await core.analyze(bytes, { parser, format: 'raw', customDialect: defs });
      const decoded = core.decodePayload(60000, bytes.subarray(10, 15), 2);
      const without = await core.analyze(bytes, { parser, format: 'raw' });
      return { def: defs.messages[60000], valid: parsed.validFrames, crc: parsed.crcErrors, name: parsed.messages[0].name,
        decoded: decoded.fields.map(field => [field.name, field.value]), unsupported: without.issues.filter(issue => issue.kind === 'unsupported').length };
    }, xml);
    assert.equal(result.valid, 1); assert.equal(result.crc, 0); assert.equal(result.name, 'CUSTOM_PACKET');
    assert.equal(result.def.fields.find(field => field.name === 'count').offset, 0);
    assert.deepEqual(result.decoded, [['count', 4660], ['kind', 7], ['tail', [9, 8]]]);
    assert.equal(result.unsupported, 1, 'a later analysis without the custom dialect clears it');
  } finally { await page.close(); }
});

test('custom XML rejects entities, includes, built-in collisions, duplicates and unsupported types', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base + '#/');
    const errors = await page.evaluate(async () => {
      const { parseCustomDialectXml } = await import('./js/custom-dialect.js');
      const cases = [
        '<!DOCTYPE mavlink [<!ENTITY x SYSTEM "file:///etc/passwd">]><mavlink><messages/></mavlink>',
        '<mavlink><include>https://example.invalid/x.xml</include><messages><message id="60001" name="CUSTOM"><field type="uint8_t" name="x"/></message></messages></mavlink>',
        '<mavlink><messages><message id="0" name="COLLIDE"><field type="uint8_t" name="x"/></message></messages></mavlink>',
        '<mavlink><messages><message id="60001" name="ONE"><field type="uint8_t" name="x"/></message><message id="60001" name="TWO"><field type="uint8_t" name="y"/></message></messages></mavlink>',
        '<mavlink><messages><message id="60001" name="BAD"><field type="pointer" name="x"/></message></messages></mavlink>',
        '<mavlink><messages><message id="60001" name="BAD"><description>bad</description><unknown/></message></messages></mavlink>',
      ];
      return cases.map(source => { try { parseCustomDialectXml(source); return null; } catch (error) { return error.message; } });
    });
    assert.ok(errors.every(Boolean), errors.join('\n'));
    assert.match(errors[0], /declarations and entities/);
    assert.match(errors[1], /selected local/);
    assert.match(errors[2], /conflicts with a pinned built-in/);
    assert.match(errors[3], /defined more than once/);
    assert.match(errors[4], /Unsupported custom field type/);
    assert.match(errors[5], /unsupported XML element/);
  } finally { await page.close(); }
});

test('selected local includes resolve safely, verify pinned built-ins and reject cycles or conflicts', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base + '#/');
    const result = await page.evaluate(async () => {
      const { parseCustomDialectXml } = await import('./js/custom-dialect.js');
      const entry = '<mavlink name="selected"><include>common.xml</include><include>extra.xml</include></mavlink>';
      const common = '<mavlink><messages><message id="0" name="HEARTBEAT"><field type="uint32_t" name="custom_mode"/><field type="uint8_t" name="type"/><field type="uint8_t" name="autopilot"/><field type="uint8_t" name="base_mode"/><field type="uint8_t" name="system_status"/><field type="uint8_t_mavlink_version" name="mavlink_version"/></message></messages></mavlink>';
      const extra = '<mavlink><messages><message id="60002" name="EXTRA"><field type="uint16_t" name="count"/></message></messages></mavlink>';
      const merged = parseCustomDialectXml(entry, undefined, { entryName: 'entry.xml', sources: new Map([['common.xml', common], ['extra.xml', extra]]) });
      const includeChain = count => {
        const sources = new Map();
        for (let index = 1; index <= count; index++) sources.set(`level-${index}.xml`, index === count
          ? '<mavlink><messages><message id="60004" name="DEEPEST"><field type="uint8_t" name="value"/></message></messages></mavlink>'
          : `<mavlink><include>level-${index + 1}.xml</include></mavlink>`);
        return parseCustomDialectXml('<mavlink><include>level-1.xml</include></mavlink>', undefined, { entryName: 'entry.xml', sources });
      };
      const deepestAccepted = includeChain(8).messageCount;
      let depthError = '';
      try { includeChain(9); } catch (error) { depthError = error.message; }
      const cases = [
        ['<mavlink><include>a.xml</include></mavlink>', { 'a.xml': '<mavlink><include>b.xml</include></mavlink>', 'b.xml': '<mavlink><include>a.xml</include></mavlink>' }],
        ['<mavlink><include>https://example.invalid/x.xml</include></mavlink>', {}],
        ['<mavlink><include>../evil.xml</include></mavlink>', { '../evil.xml': extra }],
        ['<mavlink><include>bad.xml</include></mavlink>', { 'bad.xml': '<mavlink><messages><message id="0" name="HEARTBEAT"><field type="uint8_t" name="wrong"/></message></messages></mavlink>' }],
        ['<mavlink><include>a.xml</include><messages><message id="60002" name="DUP"><field type="uint8_t" name="x"/></message></messages></mavlink>', { 'a.xml': extra }],
      ];
      const errors = cases.map(([source, files]) => { try { parseCustomDialectXml(source, undefined, { entryName: 'entry.xml', sources: files }); return null; } catch (error) { return error.message; } });
      return { messageCount: merged.messageCount, customName: merged.messages[60002].name, builtins: merged.includedBuiltins,
        deepestAccepted, depthError,
        included: merged.includedFiles.sort(), errors };
    });
    assert.equal(result.messageCount, 1); assert.equal(result.customName, 'EXTRA');
    assert.deepEqual(result.builtins, [0]); assert.deepEqual(result.included, ['common.xml', 'extra.xml']);
    assert.equal(result.deepestAccepted, 1); assert.match(result.depthError, /include depth exceeds the 8-file limit/);
    assert.ok(result.errors.every(Boolean));
    assert.match(result.errors[0], /cycle/); assert.match(result.errors[3], /pinned built-in/); assert.match(result.errors[4], /defined more than once/);
  } finally { await page.close(); }
});

test('uploaded custom dialect validates a frame and clearing restores unsupported status', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base + '#/capture');
    await page.waitForFunction(() => !!window.location.hash && !document.querySelector('#load-sample')?.disabled);
    await page.setInputFiles('#custom-dialect-file', { name: 'custom.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
    await page.waitForFunction(() => document.querySelector('#custom-dialect-name').textContent.includes('1 custom message'));
    const extra = await page.evaluate(async source => (await import('./js/custom-dialect.js')).parseCustomDialectXml(source).messages[60000].crc_extra, xml);
    await page.setInputFiles('#file', { name: 'custom.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(customFrame(extra)) });
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'custom.bin loaded.');
    await page.goto(base + '#/frames');
    await page.waitForSelector('#frame-table tbody tr');
    assert.match(await page.locator('#frame-table tbody tr').first().textContent(), /CUSTOM_PACKET/);
    await page.goto(base + '#/capture');
    await page.locator('#custom-dialect-panel').evaluate(element => { element.open = true; });
    await page.getByRole('button', { name: 'Clear custom dialect' }).click();
    await page.waitForFunction(() => document.querySelector('#custom-dialect-status').textContent.includes('pinned common/ArduPilotMega'));
    await page.goto(base + '#/frames');
    await page.waitForFunction(() => document.querySelector('#frame-table tbody tr')?.textContent.includes('Unsupported'));
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#frame-table tbody tr')].map(row => row.cells[0].textContent.trim())), ['Unsupported (not checked)']);
  } finally { await page.close(); }
});

test('the custom dialect upload waits for explicitly selected local includes and clears them together', async () => {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) pageErrors.push(message.text()); });
  try {
    await page.goto(base + '#/capture');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'sample-flight.tlog loaded.');
    await page.locator('#custom-dialect-panel').evaluate(element => { element.open = true; });
    const entry = Buffer.from('<mavlink><include>telemetry.xml</include></mavlink>');
    const include = Buffer.from('<mavlink><messages><message id="60003" name="INCLUDED_PACKET"><field type="uint16_t" name="reading"/></message></messages></mavlink>');
    await page.locator('#custom-dialect-file').setInputFiles({ name: 'entry.xml', mimeType: 'application/xml', buffer: entry });
    await page.waitForFunction(() => /Select the referenced local file/.test(document.getElementById('custom-dialect-status').textContent));
    await page.locator('#custom-dialect-includes').setInputFiles({ name: 'telemetry.xml', mimeType: 'application/xml', buffer: include });
    await page.waitForFunction(() => /Rechecked sample-flight\.tlog with 1 custom definitions/.test(document.getElementById('custom-dialect-status').textContent));
    assert.match(await page.locator('#custom-dialect-name').textContent(), /1 local includes/);
    await page.getByRole('button', { name: 'Clear custom dialect' }).click();
    assert.match(await page.locator('#custom-dialect-name').textContent(), /No custom dialect loaded/);
    assert.deepEqual(pageErrors, []);
  } finally { await page.close(); }
});
