import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const crcTable = new Uint32Array(256);
for (let value = 0; value < 256; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  crcTable[value] = crc >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const body = Buffer.concat([name, data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}

function makePlaceholderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (y * size + x) * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = 255;
  };
  const fillRect = (x0, y0, x1, y1, color) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) set(x, y, color);
  };
  const background = [19, 28, 24];
  const board = [207, 180, 112];
  const darkStone = [14, 19, 17];
  const lightStone = [245, 235, 207];
  const goldStone = [191, 151, 72];
  fillRect(0, 0, size, size, background);

  const margin = Math.round(size * 0.12);
  const right = size - margin;
  const lineWidth = Math.max(2, Math.round(size * 0.012));
  const positions = [margin, Math.round(margin + (right - margin) / 4), Math.round(margin + (right - margin) / 2), Math.round(margin + (right - margin) * 3 / 4), right];
  for (const x of positions) fillRect(x - lineWidth / 2, margin, x + lineWidth / 2 + 1, right + 1, board);
  for (const y of positions) fillRect(margin, y - lineWidth / 2, right + 1, y + lineWidth / 2 + 1, board);

  const stone = (column, row, color) => {
    const cx = positions[column];
    const cy = positions[row];
    const radius = Math.round(size * 0.075);
    for (let y = cy - radius; y <= cy + radius; y += 1) {
      for (let x = cx - radius; x <= cx + radius; x += 1) {
        const distance = Math.hypot(x - cx, y - cy);
        if (distance <= radius) {
          const shade = Math.max(0, Math.round((radius - distance) / radius * 18));
          set(x, y, color.map((channel) => Math.min(255, channel + shade)));
        }
      }
    }
  };
  stone(1, 1, darkStone);
  stone(3, 1, lightStone);
  stone(2, 3, goldStone);
  stone(4, 3, darkStone);

  const scanlines = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) pixels.copy(scanlines, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function writePlaceholderOnce(filePath, content) {
  try {
    await writeFile(filePath, content, { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing Harmony resource: ${filePath}`);
    }
    throw error;
  }
}

export async function generateHarmonyPlaceholderAssets({ root = mobileRoot } = {}) {
  const appResources = path.join(root, 'harmony/AppScope/resources/base');
  const moduleResources = path.join(root, 'harmony/entry/src/main/resources/base');
  for (const directory of [
    path.join(appResources, 'media'), path.join(appResources, 'element'),
    path.join(moduleResources, 'media'), path.join(moduleResources, 'element'),
  ]) await mkdir(directory, { recursive: true });

  const appStrings = { string: [{ name: 'app_name', value: 'LIFELINE' }] };
  const moduleStrings = {
    string: [
      { name: 'app_name', value: 'LIFELINE' },
      { name: 'EntryAbility_label', value: 'LIFELINE' },
      { name: 'EntryAbility_desc', value: 'Play LIFELINE on a local board.' },
    ],
  };
  const moduleColors = { color: [{ name: 'start_window_background', value: '#FF131C18' }] };
  const icon = makePlaceholderIcon(512);
  const startIcon = makePlaceholderIcon(512);
  const outputs = [
    [path.join(appResources, 'element/string.json'), `${JSON.stringify(appStrings, null, 2)}\n`],
    [path.join(appResources, 'media/app_icon.png'), icon],
    [path.join(moduleResources, 'element/string.json'), `${JSON.stringify(moduleStrings, null, 2)}\n`],
    [path.join(moduleResources, 'element/color.json'), `${JSON.stringify(moduleColors, null, 2)}\n`],
    [path.join(moduleResources, 'media/app_icon.png'), icon],
    [path.join(moduleResources, 'media/startIcon.png'), startIcon],
  ];
  for (const [filePath, content] of outputs) await writePlaceholderOnce(filePath, content);
  return { status: 'PASS-CURRENT', iconSize: 512, appIconBytes: icon.length, startIconBytes: startIcon.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await generateHarmonyPlaceholderAssets()));
}
