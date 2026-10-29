// Match TextEncoder's UTF-8 and replacement-character semantics without
// depending on browser globals absent from some Mini Game runtimes.
export function utf8Bytes(value) {
  const bytes = [];
  for (const character of String(value)) {
    let cp = character.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | cp >> 6, 0x80 | cp & 0x3f);
    else if (cp < 0x10000) bytes.push(0xe0 | cp >> 12, 0x80 | cp >> 6 & 0x3f, 0x80 | cp & 0x3f);
    else bytes.push(0xf0 | cp >> 18, 0x80 | cp >> 12 & 0x3f, 0x80 | cp >> 6 & 0x3f, 0x80 | cp & 0x3f);
  }
  return Uint8Array.from(bytes);
}
