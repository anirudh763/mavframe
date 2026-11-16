import { MESSAGE_NAMES, MESSAGES } from './msgdefs.js';

export const MAX_CUSTOM_XML_BYTES = 1024 * 1024;
const MAX_MESSAGES = 512;
const MAX_FIELDS = 64;
const SIZES = { char: 1, uint8_t: 1, int8_t: 1, uint16_t: 2, int16_t: 2, uint32_t: 4, int32_t: 4, float: 4, uint64_t: 8, int64_t: 8, double: 8 };
const fail = message => { throw new Error(message); };

function x25(data, crc = 0xffff) {
  for (const value of data) {
    let tmp = (value ^ (crc & 0xff)) & 0xff;
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  }
  return crc;
}

function crcExtra(name, fields) {
  let crc = x25(new TextEncoder().encode(`${name} `));
  for (const field of fields) {
    crc = x25(new TextEncoder().encode(`${field.type} `), crc);
    crc = x25(new TextEncoder().encode(`${field.name} `), crc);
    if (field.count) crc = x25(Uint8Array.of(field.count), crc);
  }
  return (crc & 0xff) ^ (crc >> 8);
}

function fieldType(value) {
  const match = /^(char|uint8_t|int8_t|uint16_t|int16_t|uint32_t|int32_t|float|uint64_t|int64_t|double|uint8_t_mavlink_version)(?:\[(\d{1,3})\])?$/.exec(value || '');
  if (!match) fail(`Unsupported custom field type “${value || '(missing)'}”.`);
  const type = match[1] === 'uint8_t_mavlink_version' ? 'uint8_t' : match[1];
  const count = match[2] ? Number(match[2]) : 0;
  if (match[2] && (count < 1 || count > 255)) fail(`Array “${value}” must contain 1–255 elements.`);
  return { type, count };
}

export function parseCustomDialectXml(text, Parser = globalThis.DOMParser, options = {}) {
  const context = options.context || { sources: options.sources || {}, active: new Set(), visited: new Set(), files: [], includedFiles: new Set(), builtinIds: new Set(), totalBytes: 0 };
  const currentName = options.entryName || '__entry__.xml';
  const depth = options.depth || 0;
  if (depth > 8) fail('Custom dialect include depth exceeds the 8-file limit.');
  if (context.active.has(currentName)) fail(`Custom dialect include cycle detected at “${currentName}”.`);
  if (context.visited.has(currentName)) fail(`Custom dialect file “${currentName}” is included more than once.`);
  if (typeof text !== 'string') fail('Read the custom dialect as text.');
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > MAX_CUSTOM_XML_BYTES) fail('Each custom XML file is limited to 1 MiB.');
  context.totalBytes += byteLength;
  if (context.totalBytes > 4 * MAX_CUSTOM_XML_BYTES) fail('Selected dialect files exceed the 4 MiB total limit.');
  if (!Parser) fail('This browser has no XML parser; custom dialects are unavailable here.');
  if (/<!\s*(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i.test(text)) fail('XML declarations and entities are not accepted. Remove the DTD/entity declaration and retry.');
  context.active.add(currentName); context.visited.add(currentName); context.files.push(currentName);
  try {
    const doc = new Parser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) fail('Malformed XML. Check the dialect file and retry.');
    const root = doc.documentElement;
    if (!root || root.localName !== 'mavlink') fail('Expected an XML <mavlink> root element.');
    if ([...root.children].some(node => !['include', 'messages', 'enums', 'version', 'dialect', 'description'].includes(node.localName))) fail('Custom dialect contains an unsupported top-level element.');
    const includes = [...root.children].filter(node => node.localName === 'include');
    const ownMessages = [...root.children].find(node => node.localName === 'messages');
    if (!ownMessages && !includes.length) fail('The dialect must contain a <messages> element or selected local includes.');
    const nodes = ownMessages ? [...ownMessages.children] : [];
    if (nodes.some(node => node.localName !== 'message')) fail('Only <message> entries are supported inside <messages>.');
    if (nodes.length > MAX_MESSAGES) fail(`A dialect file can contain at most ${MAX_MESSAGES} messages.`);

    const messages = Object.create(null); const names = new Set(); let fieldTotal = 0;
    const addMessage = (msg, source) => {
      if (Object.prototype.hasOwnProperty.call(MESSAGE_NAMES, msg.id)) {
        const builtIn = MESSAGES[msg.id];
        const signature = value => JSON.stringify({ name: value.name, crc_extra: value.crc_extra, min_length: value.min_length, length: value.length,
          fields: value.fields.map(field => ({ name: field.name, type: field.type, count: field.count, ext: field.ext, offset: field.offset })) });
        if (!builtIn || signature(msg) !== signature(builtIn))
          fail(`Message ID ${msg.id} in “${source}” conflicts with a pinned built-in definition.`);
        context.builtinIds.add(msg.id); return;
      }
      if (Object.prototype.hasOwnProperty.call(messages, msg.id)) fail(`Message ID ${msg.id} is defined more than once across selected custom files.`);
      if (names.has(msg.name)) fail(`Message name “${msg.name}” is defined more than once across selected custom files.`);
      messages[msg.id] = msg; names.add(msg.name); fieldTotal += msg.fields.length;
      if (Object.keys(messages).length > MAX_MESSAGES) fail(`Combined custom dialect exceeds ${MAX_MESSAGES} messages.`);
      if (fieldTotal > 8192) fail('The dialect exceeds the 8,192-field limit.');
    };

    for (const include of includes) {
      const filename = include.textContent.trim();
      if (!/^[A-Za-z0-9_.-]{1,80}\.xml$/.test(filename) || filename === '.' || filename === '..' || filename.includes('..'))
        fail('Includes must name a selected local .xml file without a path or URL.');
      if (context.active.has(filename)) fail(`Custom dialect include cycle detected at “${filename}”.`);
      if (context.visited.has(filename)) continue;
      const source = context.sources instanceof Map ? context.sources.get(filename) : context.sources[filename];
      if (typeof source !== 'string') fail(`Select the referenced local file “${filename}”; remote includes are never fetched.`);
      context.includedFiles.add(filename);
      const included = parseCustomDialectXml(source, Parser, { context, entryName: filename, depth: depth + 1 });
      for (const message of Object.values(included.messages)) addMessage(message, filename);
    }

    for (const node of nodes) {
      const id = Number(node.getAttribute('id'));
      const name = node.getAttribute('name') || '';
      if (!Number.isInteger(id) || id < 0 || id > 0xffffff) fail(`Message “${name || '(unnamed)'}” needs an ID from 0 through 16777215.`);
      if (!/^[A-Z][A-Z0-9_]{0,49}$/.test(name)) fail(`Message name “${name || '(missing)'}” is invalid.`);
      let extension = false; const declared = [];
      for (const child of node.children) {
        if (child.localName === 'extensions') { if (extension) fail(`${name} has more than one <extensions> marker.`); extension = true; continue; }
        if (child.localName === 'description') continue;
        if (child.localName !== 'field') fail(`${name} uses unsupported XML element <${child.localName}>.`);
        const fieldName = child.getAttribute('name') || '';
        if (!/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(fieldName) || declared.some(field => field.name === fieldName)) fail(`${name} has an invalid or duplicate field name “${fieldName}”.`);
        const { type, count } = fieldType(child.getAttribute('type'));
        declared.push({ name: fieldName, type, count, ext: extension,
          ...(child.getAttribute('units') ? { units: child.getAttribute('units').slice(0, 32) } : {}),
          ...(child.getAttribute('enum') ? { enum: child.getAttribute('enum').slice(0, 64) } : {}),
          ...(child.getAttribute('invalid') && /^\d+$/.test(child.getAttribute('invalid')) ? { invalid: Number(child.getAttribute('invalid')) } : {}) });
      }
      if (!declared.length || declared.length > MAX_FIELDS) fail(`${name} must have 1–${MAX_FIELDS} fields.`);
      const base = declared.filter(field => !field.ext); const ext = declared.filter(field => field.ext);
      const orderedBase = base.map((field, order) => ({ field, order })).sort((a, b) => SIZES[b.field.type] - SIZES[a.field.type] || a.order - b.order).map(item => item.field);
      let offset = 0;
      const fields = [...orderedBase, ...ext].map(field => { const output = { ...field, offset }; offset += SIZES[field.type] * Math.max(field.count, 1); return output; });
      const minLength = orderedBase.reduce((sum, field) => sum + SIZES[field.type] * Math.max(field.count, 1), 0);
      if (offset > 255) fail(`${name} payload is ${offset} bytes; MAVLink payloads are limited to 255 bytes.`);
      const desc = [...node.children].find(child => child.localName === 'description')?.textContent?.trim().split('. ')[0].slice(0, 240) || '';
      addMessage({ id, name, description: desc ? `${desc.replace(/\.$/, '')}.` : 'Custom dialect message.', min_length: minLength, length: offset, crc_extra: crcExtra(name, orderedBase), fields }, currentName);
    }

    const ids = Object.keys(messages).map(Number).sort((a, b) => a - b);
    return { name: root.getAttribute('name')?.slice(0, 80) || 'Custom dialect', messages,
      pairs: Uint32Array.from(ids, id => ((id << 8) | messages[id].crc_extra) >>> 0), messageCount: ids.length, fieldCount: fieldTotal,
      includedFiles: [...context.includedFiles].sort(), includedBuiltins: [...context.builtinIds].sort((a, b) => a - b) };
  } finally { context.active.delete(currentName); }
}
