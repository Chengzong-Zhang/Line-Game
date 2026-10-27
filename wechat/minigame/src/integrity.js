import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalize } from './core.js';

// Do not assume TextEncoder exists in the WeChat JS runtime. JSON serializes
// isolated surrogates as escapes; normal Unicode is encoded identically to UTF-8.
export function utf8(text) {
  const bytes = [];
  for (const character of String(text)) {
    let cp = character.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 128) bytes.push(cp);
    else if (cp < 2048) bytes.push(192 | cp >> 6, 128 | cp & 63);
    else if (cp < 65536) bytes.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
    else bytes.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
  }
  return Uint8Array.from(bytes);
}

export function checksum(value) {
  return `sha256:${bytesToHex(sha256(utf8(canonicalize(value))))}`;
}
