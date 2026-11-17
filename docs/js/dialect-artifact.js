// The XML container preserves local filenames and exact source text without a JSON artifact limit.
import { MAX_CUSTOM_XML_BYTES } from './custom-dialect.js';
export const MAX_DIALECT_ARTIFACT_BYTES = 32 * 1024 * 1024;
function filesFrom(sources) {
  if (typeof sources?.entryName !== 'string' || typeof sources?.source !== 'string' || !Array.isArray(sources?.includes)) throw new Error('Saved custom definitions are invalid.');
  const files = [[sources.entryName, sources.source], ...sources.includes];
  const names = new Set(); let total = 0;
  for (const file of files) {
    if (!Array.isArray(file) || file.length !== 2 || file.some(value => typeof value !== 'string') || !file[0] || names.has(file[0])) throw new Error('Custom definition filenames must be present and unique.');
    names.add(file[0]); const size = new TextEncoder().encode(file[1]).length; total += size;
    if (size > MAX_CUSTOM_XML_BYTES || total > 4 * MAX_CUSTOM_XML_BYTES) throw new Error('Custom definitions exceed 1 MiB per file or 4 MiB combined. Keep the original XML files and reduce the selection.');
  }
  return files;
}
export function encodeDialectArtifact(sources) {
  const files = filesFrom(sources);
  const doc = document.implementation.createDocument(null, 'mavframe-dialects'); doc.documentElement.setAttribute('version', '1');
  for (const [name, source] of files) { const file = doc.createElement('file'); file.setAttribute('name', name); file.textContent = source; doc.documentElement.append(file); }
  const text = new XMLSerializer().serializeToString(doc);
  if (new TextEncoder().encode(text).length > MAX_DIALECT_ARTIFACT_BYTES) throw new Error('Custom definitions exceed the 32 MiB saved-artifact limit. Keep the original XML files.');
  return text;
}
export function decodeDialectArtifact(text) {
  if (new TextEncoder().encode(text).length > MAX_DIALECT_ARTIFACT_BYTES || /<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) throw new Error('Saved custom definitions are oversized or contain a forbidden declaration.');
  const doc = new DOMParser().parseFromString(text, 'application/xml'); const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'mavframe-dialects' || root.getAttribute('version') !== '1' || !root.children.length) throw new Error('The saved custom-definition container is invalid.');
  const files = [...root.children].map(file => { if (file.localName !== 'file' || file.children.length) throw new Error('The saved custom-definition entry is invalid.'); return [file.getAttribute('name'), file.textContent]; });
  const sources = { entryName: files[0][0], source: files[0][1], includes: files.slice(1) }; filesFrom(sources); return sources;
}
