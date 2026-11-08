// Speed curve editor: a graph of speed (vertical, 0.1x to 10x on a log scale) over the clip's
// length (horizontal). Click empty space to add a point, drag a point to move it, double-click a
// point to remove it. Presets give common looks. The clip gets longer or shorter so it keeps
// the same footage.
import {
  S, mutate, setCurve, curveSpeedAt, curveAvg, normaliseCurve, SPEED_MIN, SPEED_MAX, clamp,
  beginGesture, endGesture,
} from './state.js';
import { h } from './ui.js';

export const CURVE_PRESETS = [
  { id: 'flat', label: 'Flat', pts: null },
  { id: 'ramp-up', label: 'Ramp up', pts: [[0, 0.4], [1, 4]] },
  { id: 'ramp-down', label: 'Ramp down', pts: [[0, 4], [1, 0.4]] },
  { id: 'ease', label: 'Slow middle', pts: [[0, 2.5], [0.35, 0.4], [0.65, 0.4], [1, 2.5]] },
  { id: 'hero', label: 'Hero', pts: [[0, 1], [0.3, 1], [0.45, 0.2], [0.7, 0.2], [0.85, 1.5], [1, 1]] },
  { id: 'montage', label: 'Montage', pts: [[0, 1], [0.15, 4], [0.3, 0.5], [0.5, 4], [0.7, 0.5], [1, 1]] },
  { id: 'pulse', label: 'Pulse', pts: [[0, 1], [0.25, 3], [0.5, 0.3], [0.75, 3], [1, 1]] },
  { id: 'flash', label: 'Flash in', pts: [[0, 0.15], [0.25, 0.15], [0.4, 3], [1, 1]] },
];

const LMIN = Math.log10(SPEED_MIN), LMAX = Math.log10(SPEED_MAX);
const toY = (s, H) => H - ((Math.log10(clamp(s, SPEED_MIN, SPEED_MAX)) - LMIN) / (LMAX - LMIN)) * H;
const fromY = (y, H) => Math.pow(10, LMIN + (1 - y / H) * (LMAX - LMIN));

export function speedCurveSection(c, tr, redraw) {
  const cv = h('canvas', { class: 'curve', height: 130, 'aria-label': 'Speed curve' });
  const info = h('div', { class: 'hint' });
  const live = () => (c.curve && c.curve.length >= 2 ? c.curve : [[0, c.speed], [1, c.speed]]);
  let drag = -1;

  function draw() {
    const W = cv.clientWidth || 260, H = 130, dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n, d) => css.getPropertyValue(n).trim() || d;
    g.clearRect(0, 0, W, H);
    g.fillStyle = col('--c-surface-2', '#1d2026'); g.fillRect(0, 0, W, H);
    g.strokeStyle = col('--c-border', '#333'); g.fillStyle = col('--c-text-muted', '#999'); g.font = '10px sans-serif';
    for (const v of [0.1, 0.5, 1, 2, 5, 10]) {
      const y = toY(v, H);
      g.globalAlpha = v === 1 ? 0.9 : 0.4;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      g.globalAlpha = 1; g.fillText(v + '×', 3, Math.min(H - 2, Math.max(10, y - 2)));
    }
    const k = live();
    const acc = col('--c-accent', '#4cc2ff');
    g.strokeStyle = acc; g.lineWidth = 2; g.beginPath();
    k.forEach(([u, s], i) => { const x = u * W, y = toY(s, H); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    // playhead
    if (S.t >= c.start && S.t <= c.start + c.dur) {
      const x = ((S.t - c.start) / c.dur) * W;
      g.strokeStyle = col('--c-text', '#fff'); g.lineWidth = 1; g.globalAlpha = 0.6;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.globalAlpha = 1;
    }
    if (c.curve) for (const [u, s] of k) { g.fillStyle = acc; g.beginPath(); g.arc(u * W, toY(s, H), 5, 0, 7); g.fill(); }
    info.textContent = c.curve
      ? `Average ${curveAvg(k).toFixed(2)}×, clip is ${(c.dur / 1e6).toFixed(1)} s. Click to add a point, double-click a point to remove it.`
      : 'Pick a preset or click the graph to start a curve.';
  }

  const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top)]; };
  const hit = (u, y, W, H) => live().findIndex(([pu, ps]) => Math.hypot(pu * W - u * W, toY(ps, H) - y) < 9);
  const edit = (label, fn, coalesce) => {
    mutate(label, () => { const k = fn(live().map((p) => p.slice())); setCurve(c, tr, k); }, { coalesce, source: 'prop' });
    draw(); if (redraw) redraw();
  };

  cv.addEventListener('pointerdown', (e) => {
    const W = cv.clientWidth, H = 130, [u, y] = pos(e);
    let i = c.curve ? hit(u, y, W, H) : -1;
    cv.setPointerCapture(e.pointerId);
    if (i < 0) {
      const sp = fromY(y, H);
      const base = c.curve ? live() : [[0, c.speed], [1, c.speed]];
      const pts = base.map((p) => p.slice()); pts.push([clamp(u, 0, 1), sp]); pts.sort((a, b) => a[0] - b[0]);
      mutate('Add speed point', () => setCurve(c, tr, pts), { source: 'prop' });
      i = c.curve.findIndex(([pu]) => Math.abs(pu - clamp(u, 0, 1)) < 1e-6);
      if (redraw) redraw();
    }
    drag = i;
    beginGesture();
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    const W = cv.clientWidth, H = 130, [u, y] = pos(e);
    if (drag < 0) { cv.style.cursor = c.curve && hit(u, y, W, H) >= 0 ? 'grab' : 'crosshair'; return; }
    const sp = clamp(fromY(clamp(y, 0, H), H), SPEED_MIN, SPEED_MAX);
    const last = live().length - 1;
    edit('Move speed point', (k) => {
      k[drag][1] = sp;
      if (drag > 0 && drag < last) k[drag][0] = clamp(u, k[drag - 1][0] + 0.01, k[drag + 1][0] - 0.01);
      return k;
    }, 'speedcurve');
  });
  const end = () => { if (drag >= 0) { drag = -1; endGesture(); } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', (e) => {
    const W = cv.clientWidth, H = 130, [u, y] = pos(e);
    const i = c.curve ? hit(u, y, W, H) : -1;
    if (i < 0 || live().length <= 2) return;
    edit('Remove speed point', (k) => { k.splice(i, 1); return k; });
  });

  const presets = h('div', { class: 'chips' }, ...CURVE_PRESETS.map((p) => h('button', {
    class: 'btn sm', text: p.label, title: p.label + ' speed curve',
    onclick: () => { mutate('Speed curve: ' + p.label, () => setCurve(c, tr, p.pts), { source: 'prop' }); draw(); if (redraw) redraw(); },
  })));

  const box = h('div', {}, presets, cv, info);
  requestAnimationFrame(draw);
  box.redraw = draw;
  return box;
}
