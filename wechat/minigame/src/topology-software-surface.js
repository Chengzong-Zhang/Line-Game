import { DEFAULT_SURFACE_PALETTE, NEUTRAL_SURFACE_COLOR, surfaceShadow } from './topology/TopologySurface3D.js';

// Native Mini Game canvases cannot reliably copy a WebGL offscreen surface to
// the 2D screen canvas. Rasterize into a 2D surface instead. Depth is tested per
// pixel, including grid lines and pieces, so the far side stays occluded.
export function createSoftwareSurfaceRenderer(canvas) {
  let ctx;
  try { ctx = canvas?.getContext('2d'); } catch (_) { return null; }
  if (!ctx || typeof ctx.createImageData !== 'function' || typeof ctx.putImageData !== 'function') return null;
  let image = null, depth = null;
  const rgb = (value, shade = 0) => {
    const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value || '');
    const hex = match ? (match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1]) : '998f7d';
    return [0, 2, 4].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - shade)));
  };
  return {
    draw(data, width, height, rotate, zoom = 1, palette = {}, dpr = 1) {
      width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      if (!image || image.width !== width || image.height !== height) {
        image = ctx.createImageData(width, height);
        depth = new Float32Array(width * height);
      }
      const pixels = image.data;
      depth.fill(-Infinity);
      for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 246; pixels[i + 1] = 241; pixels[i + 2] = 232; pixels[i + 3] = 255; }
      const scale = Math.min(width, height) * 0.3 * zoom;
      const colors = new Map();
      const colorFor = (value, shade = 0) => {
        const key = `${value}|${shade}`;
        let color = colors.get(key);
        if (!color) { color = rgb(value, shade); colors.set(key, color); }
        return color;
      };
      const project = (p, lift = 0) => {
        const q = rotate(p);
        return [width / 2 + q[0] * scale, height / 2 - q[1] * scale, q[2] + lift];
      };
      const put = (x, y, z, color) => {
        if (x < 0 || y < 0 || x >= width || y >= height || !Number.isFinite(z)) return;
        const index = y * width + x;
        if (z < depth[index]) return;
        depth[index] = z;
        const pos = index * 4; pixels[pos] = color[0]; pixels[pos + 1] = color[1]; pixels[pos + 2] = color[2];
      };
      const triangle = (a, b, c, color) => {
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (!Number.isFinite(area) || Math.abs(area) < 1e-8) return;
        const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
        const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5, py = y + 0.5;
          const u = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
          const v = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
          const w = 1 - u - v;
          if (u >= -1e-7 && v >= -1e-7 && w >= -1e-7) put(x, y, u * a[2] + v * b[2] + w * c[2], color);
        }
      };
      const disc = (p, radius, color) => {
        const minX = Math.max(0, Math.floor(p[0] - radius)), maxX = Math.min(width - 1, Math.ceil(p[0] + radius));
        const minY = Math.max(0, Math.floor(p[1] - radius)), maxY = Math.min(height - 1, Math.ceil(p[1] + radius));
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          if ((x + 0.5 - p[0]) ** 2 + (y + 0.5 - p[1]) ** 2 <= radius ** 2) put(x, y, p[2], color);
        }
      };
      for (const cell of data.cells) {
        if (cell.points.some(p => !p)) continue;
        const rotated = cell.points.map(rotate), shade = Math.round(surfaceShadow(rotated) * 12) / 12;
        const color = colorFor(palette[cell.player]?.surface ?? palette[cell.player]?.territory ?? DEFAULT_SURFACE_PALETTE[cell.player]?.surface ?? NEUTRAL_SURFACE_COLOR, shade);
        const p = rotated.map(q => [width / 2 + q[0] * scale, height / 2 - q[1] * scale, q[2]]);
        triangle(p[0], p[1], p[2], color); triangle(p[0], p[2], p[3], color);
      }
      for (const line of data.lines) {
        if (line.points.some(p => !p)) continue;
        const points = line.points.map(p => project(p, line.player ? 0.004 : 0.002));
        const color = colorFor(palette[line.player]?.line ?? DEFAULT_SURFACE_PALETTE[line.player]?.line ?? '#655b4b');
        const steps = Math.max(1, Math.ceil(Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) * 1.5));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          disc([points[0][0] + (points[1][0] - points[0][0]) * t,
            points[0][1] + (points[1][1] - points[0][1]) * t,
            points[0][2] + (points[1][2] - points[0][2]) * t], line.player ? Math.max(1, dpr) : Math.max(0.6, dpr * 0.5), color);
        }
      }
      for (const node of data.nodes) if (node.point && node.latest)
        disc(project(node.point, 0.006), (node.start ? 8.5 : 6.5) * dpr, colorFor('#fffdf7'));
      for (const node of data.nodes) if (node.point) {
        disc(project(node.point, 0.0061), (node.start ? 6 : 4) * dpr,
          colorFor(palette[node.player]?.node ?? DEFAULT_SURFACE_PALETTE[node.player]?.node ?? '#3a3125'));
      }
      ctx.putImageData(image, 0, 0);
    },
    destroy() { image = null; depth = null; },
  };
}
