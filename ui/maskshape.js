// Shape masks. The maths is the same as the export's (engine/src/model.rs Mask::geq_expr), so the
// preview matches the finished video. The mask is drawn once into a small alpha picture and
// laid over the clip with CSS.
export const MASK_SHAPES = [
  { id: '', label: 'None' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'ellipse', label: 'Circle' },
  { id: 'heart', label: 'Heart' },
  { id: 'linear', label: 'Line' },
  { id: 'mirror', label: 'Mirror' },
];

export function defaultMask(shape) {
  return { shape, x: 0, y: 0, w: shape === 'linear' || shape === 'mirror' ? 1 : 0.6, h: shape === 'mirror' ? 0.4 : 0.6, rot: 0, feather: 0.1, invert: false };
}

const clip01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function alphaAt(m, X, Y, W, H) {
  const a = (m.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = X - (0.5 + m.x) * W, dy = Y - (0.5 + m.y) * H;
  const px = (dx * c + dy * s) / (m.w * W / 2);
  const py = (-dx * s + dy * c) / (m.h * H / 2);
  const f = Math.max(m.feather, 0.002);
  let v;
  switch (m.shape) {
    case 'ellipse': v = clip01((1 - Math.hypot(px, py)) / f); break;
    case 'rect': v = clip01((1 - Math.max(Math.abs(px), Math.abs(py))) / f); break;
    case 'linear': v = clip01(-py / f + 0.5); break;
    case 'mirror': v = clip01((1 - Math.abs(py)) / f); break;
    default: {
      const x = px * 1.15, y = -py * 1.15;
      const e = Math.pow(x * x + y * y - 1, 3) - x * x * Math.pow(y, 3);
      v = clip01(0.5 - e / (0.03 + f * 0.6));
    }
  }
  return m.invert ? 1 - v : v;
}

const cache = new Map();
// A data URL of an alpha picture for this mask (cached by its settings).
export function maskUrl(m) {
  const key = [m.shape, m.x, m.y, m.w, m.h, m.rot, m.feather, m.invert].join('|');
  if (cache.has(key)) return cache.get(key);
  const W = 192, H = 108;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      img.data[i + 3] = Math.round(alphaAt(m, (x + 0.5) / W * 640, (y + 0.5) / H * 360, 640, 360) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const url = `url(${cv.toDataURL('image/png')})`;
  if (cache.size > 60) cache.clear();
  cache.set(key, url);
  return url;
}
