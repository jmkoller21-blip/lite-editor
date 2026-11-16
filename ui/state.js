// Project state, undo/redo, and the edit operations. Times are integer microseconds.
import { api } from './api.js';

export const US = 1e6;
export const MIN_DUR = 100000; // 0.1 s
export const S = {
  doc: null, sel: null, t: 0, playing: false, pps: 80, snap: true,
  undo: [], redo: [], dirty: false, sys: null, settings: {}, saving: false,
};

const listeners = {};
export const on = (ev, fn) => { (listeners[ev] ||= []).push(fn); };
export const emit = (ev, d) => { (listeners[ev] || []).forEach((f) => f(d)); };

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const frameUs = () => US / (S.doc ? S.doc.fps : 30);

export function fmtTime(us, withFrames = true) {
  us = Math.max(0, Math.round(us));
  const total = us / US;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((us % US) / frameUs());
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${withFrames ? '.' + String(f).padStart(2, '0') : ''}`;
}
export function fmtDur(us) {
  const s = Math.round(us / US);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- lookups
export const tracksTopDown = () => [...S.doc.tracks].reverse();
export const media = (id) => S.doc.media.find((m) => m.id === id);
export function findClip(id) {
  if (!S.doc || !id) return null;
  for (const tr of S.doc.tracks) {
    const clip = tr.clips.find((c) => c.id === id);
    if (clip) return { clip, track: tr };
  }
  return null;
}
export const selected = () => findClip(S.sel);
export function duration() {
  let d = 0;
  for (const tr of S.doc.tracks) for (const c of tr.clips) d = Math.max(d, c.start + c.dur);
  return d;
}
export const clipEnd = (c) => c.start + c.dur;
export function clipKind(c, tr) {
  if (c.text) return 'text';
  const m = media(c.media);
  return m ? m.kind : tr.kind;
}
export function trackLabel(tr) {
  const same = S.doc.tracks.filter((t) => t.kind === tr.kind);
  const idx = same.indexOf(tr) + 1; // bottom up
  if (tr.kind === 'text') return same.length > 1 ? 'Text ' + idx : 'Text';
  if (tr.kind === 'audio') return 'Audio ' + idx;
  return 'Video ' + idx;
}

// ---- undo
let gesture = false;
let gestureSnap = null;
let last = { key: null, t: 0 };
const snapshot = () => JSON.stringify({ tracks: S.doc.tracks, markers: S.doc.markers });
function restore(s) {
  const o = JSON.parse(s);
  S.doc.tracks = o.tracks;
  S.doc.markers = o.markers || [];
  if (S.sel && !findClip(S.sel)) S.sel = null;
}
export function mutate(label, fn, opts = {}) {
  if (!gesture) {
    const now = performance.now();
    if (!(opts.coalesce && last.key === opts.coalesce && now - last.t < 1000)) {
      S.undo.push(snapshot());
      if (S.undo.length > 100) S.undo.shift();
    }
    last = { key: opts.coalesce || null, t: now };
  }
  S.redo.length = 0;
  fn();
  markDirty();
  emit('change', { source: opts.source || 'edit', label });
}
// A gesture (drag, trim) is one undo step however many mutate calls it makes.
export function beginGesture() { gesture = true; gestureSnap = snapshot(); }
export function endGesture() {
  if (!gesture) return;
  gesture = false;
  if (gestureSnap !== snapshot()) {
    S.undo.push(gestureSnap);
    if (S.undo.length > 100) S.undo.shift();
  }
  gestureSnap = null;
  last = { key: null, t: 0 };
}
export function undo() {
  if (!S.undo.length) return;
  S.redo.push(snapshot());
  restore(S.undo.pop());
  last = { key: null, t: 0 };
  markDirty();
  emit('change', { source: 'undo' });
}
export function redo() {
  if (!S.redo.length) return;
  S.undo.push(snapshot());
  restore(S.redo.pop());
  last = { key: null, t: 0 };
  markDirty();
  emit('change', { source: 'undo' });
}

// ---- saving
let saveTimer = null;
export function markDirty() {
  S.dirty = true;
  emit('savestate', 'dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}
export async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.doc || (!S.dirty && !S.saving)) return;
  if (S.saving) { saveTimer = setTimeout(saveNow, 300); return; }
  S.saving = true;
  S.dirty = false;
  emit('savestate', 'saving');
  try {
    await api('project_save', { doc: S.doc });
    emit('savestate', S.dirty ? 'dirty' : 'saved');
  } catch (e) {
    S.dirty = true;
    emit('savestate', 'error');
  } finally {
    S.saving = false;
  }
}

// ---- track and clip helpers
export function trackAcceptsKind(tr, kind) {
  if (tr.kind === 'text') return kind === 'text';
  if (tr.kind === 'audio') return kind === 'audio';
  return kind === 'video' || kind === 'image';
}
export function overlaps(tr, start, dur, exceptId) {
  const end = start + dur;
  return tr.clips.some((c) => c.id !== exceptId && c.start < end && clipEnd(c) > start);
}
export function neighbours(tr, c) {
  let prevEnd = 0, nextStart = Infinity;
  for (const o of tr.clips) {
    if (o.id === c.id) continue;
    if (clipEnd(o) <= c.start + 1) prevEnd = Math.max(prevEnd, clipEnd(o));
    else if (o.start >= clipEnd(c) - 1) nextStart = Math.min(nextStart, o.start);
  }
  return { prevEnd, nextStart };
}
export function defaultAdj() { return { brightness: 0, contrast: 1, saturation: 1, hue: 0, warmth: 0, blur: 0 }; }
export function newClip(m, start) {
  const dur = m.kind === 'image' ? 5 * US : m.dur;
  return {
    id: uid(), media: m.id, start, dur, in: 0, speed: 1, x: 0, y: 0, scale: 1, rot: 0, opacity: 1,
    mirror: false, volume: 1, fade_in: 0, fade_out: 0, adj: defaultAdj(),
  };
}
export function newTextClip(start, preset = {}) {
  return {
    id: uid(), start, dur: 4 * US, in: 0, speed: 1, x: 0, y: preset.y ?? 0, scale: 1, rot: 0, opacity: 1, mirror: false,
    volume: 1, fade_in: 0, fade_out: 0, adj: defaultAdj(),
    text: { content: preset.content || 'Your text', size: preset.size || 0.09, color: preset.color || '#ffffff', bold: preset.bold ?? true, outline: preset.outline ?? true, shadow: !!preset.shadow, boxed: !!preset.boxed },
  };
}

// First track of the right kind with room at `start`, scanning bottom up. Returns {track, start}.
export function placeOn(kind, start, dur, preferTrackId) {
  const cands = S.doc.tracks.filter((t) => trackAcceptsKind(t, kind));
  const ordered = preferTrackId ? [...cands.filter((t) => t.id === preferTrackId), ...cands.filter((t) => t.id !== preferTrackId)] : cands;
  for (const tr of ordered) if (!tr.locked && !overlaps(tr, start, dur)) return { track: tr, start };
  const tr = ordered.find((t) => !t.locked) || ordered[0];
  if (!tr) return null;
  const endOfLast = tr.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  return { track: tr, start: Math.max(start, endOfLast) };
}

export function addClipToTrack(tr, clip) {
  tr.clips.push(clip);
  tr.clips.sort((a, b) => a.start - b.start);
}

export function addMediaClip(m, start, preferTrackId) {
  const probe = newClip(m, 0);
  const spot = placeOn(m.kind, start, probe.dur, preferTrackId);
  if (!spot) return null;
  let created = null;
  mutate('Add clip', () => {
    created = { ...probe, start: spot.start };
    addClipToTrack(spot.track, created);
    S.sel = created.id;
  });
  return created;
}

export function addTextClip(preset, start) {
  const c = newTextClip(start, preset);
  const spot = placeOn('text', start, c.dur);
  if (!spot) return null;
  c.start = spot.start;
  mutate('Add text', () => { addClipToTrack(spot.track, c); S.sel = c.id; });
  return c;
}

export function splitAt(t) {
  const sel = selected();
  const targets = [];
  if (sel && t > sel.clip.start + MIN_DUR / 2 && t < clipEnd(sel.clip) - MIN_DUR / 2) targets.push(sel);
  else if (!sel) {
    for (const tr of S.doc.tracks) {
      if (tr.locked) continue;
      for (const c of tr.clips) if (t > c.start + MIN_DUR / 2 && t < clipEnd(c) - MIN_DUR / 2) targets.push({ clip: c, track: tr });
    }
  }
  if (!targets.length) return false;
  mutate('Split', () => {
    for (const { clip: c, track: tr } of targets) {
      const right = JSON.parse(JSON.stringify(c));
      right.id = uid();
      right.start = t;
      right.dur = clipEnd(c) - t;
      const u = (t - c.start) / c.dur;
      right.in = c.in + Math.round(srcOffset(c, t - c.start));
      if (c.curve) {
        right.curve = cropCurve(c, u, 1);
        const lc = cropCurve(c, 0, u);
        right.speed = curveAvg(right.curve);
        c.curve = lc;
        c.speed = curveAvg(lc);
      }
      if (c.kf) {
        const rk = cropKf(c, u, 1), lk = cropKf(c, 0, u);
        if (rk) right.kf = rk; else delete right.kf;
        if (lk) c.kf = lk; else delete c.kf;
      }
      right.transition_in = null;
      right.fade_in = 0;
      c.dur = t - c.start;
      c.fade_out = 0;
      addClipToTrack(tr, right);
      if (S.sel === c.id) S.sel = right.id;
    }
  });
  return true;
}

export function trimSide(side, t) {
  const sel = selected();
  if (!sel) return false;
  const c = sel.clip;
  if (sel.track.locked || !(t > c.start + MIN_DUR / 2 && t < clipEnd(c) - MIN_DUR / 2)) return false;
  mutate(side === 'left' ? 'Delete left' : 'Delete right', () => {
    if (side === 'left') {
      const u = (t - c.start) / c.dur;
      c.in += Math.round(srcOffset(c, t - c.start));
      if (c.curve) { c.curve = cropCurve(c, u, 1); c.speed = curveAvg(c.curve); }
      if (c.kf) { const k = cropKf(c, u, 1); if (k) c.kf = k; else delete c.kf; }
      c.dur = clipEnd(c) - t;
      c.start = t;
      c.fade_in = 0;
      c.transition_in = null;
    } else {
      if (c.curve) { c.curve = cropCurve(c, 0, (t - c.start) / c.dur); c.speed = curveAvg(c.curve); }
      if (c.kf) { const k = cropKf(c, 0, (t - c.start) / c.dur); if (k) c.kf = k; else delete c.kf; }
      c.dur = t - c.start;
      c.fade_out = 0;
    }
  });
  return true;
}

export function deleteClip(id, ripple) {
  const f = findClip(id);
  if (!f || f.track.locked) return false;
  mutate(ripple ? 'Ripple delete' : 'Delete', () => {
    const { clip: c, track: tr } = f;
    tr.clips = tr.clips.filter((x) => x.id !== id);
    if (ripple) for (const o of tr.clips) if (o.start >= clipEnd(c) - 1) o.start -= c.dur;
    if (S.sel === id) S.sel = null;
  });
  return true;
}


// ---- speed curve -------------------------------------------------------
// c.curve = [[u, speed], ...]: u is the position along the clip's own length (0..1),
// speed is a multiplier (0.1..10). Speed is linear between points. Without a curve the
// clip uses the flat c.speed.
export const SPEED_MIN = 0.1;
export const SPEED_MAX = 10;
export function curvePts(c) {
  const k = c.curve;
  if (!k || k.length < 2) return null;
  return k;
}
export function curveSpeedAt(c, u) {
  const k = curvePts(c);
  if (!k) return c.speed;
  if (u <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (u <= k[i][0]) {
      const [u0, s0] = k[i - 1], [u1, s1] = k[i];
      return u1 === u0 ? s1 : s0 + (s1 - s0) * ((u - u0) / (u1 - u0));
    }
  }
  return k[k.length - 1][1];
}
// integral of speed from 0 to u (in units of "clip lengths of source")
export function curveIntegral(k, u) {
  let acc = 0, px = 0, ps = k[0][1];
  for (let i = 0; i < k.length; i++) {
    const [x, sp] = k[i];
    if (x > px) {
      const xe = Math.min(x, u);
      if (xe > px) {
        const se = ps + (sp - ps) * ((xe - px) / (x - px));
        acc += (ps + se) / 2 * (xe - px);
      }
      if (x >= u) return acc;
      px = x; ps = sp;
    } else { ps = sp; }
  }
  if (u > px) acc += ps * (u - px);
  return acc;
}
// source time (us) that is shown tlOff us into the clip
export function srcOffset(c, tlOff) {
  const k = curvePts(c);
  if (!k) return tlOff * c.speed;
  return c.dur * curveIntegral(k, clamp(tlOff / c.dur, 0, 1));
}
export function curveAvg(k) { return curveIntegral(k, 1); }
// the part of a curve between u0 and u1, re-based to 0..1
export function cropCurve(c, u0, u1) {
  const k = curvePts(c);
  if (!k) return null;
  const span = Math.max(1e-6, u1 - u0);
  const pts = [[0, curveSpeedAt(c, u0)]];
  for (const [x, sp] of k) if (x > u0 + 1e-6 && x < u1 - 1e-6) pts.push([(x - u0) / span, sp]);
  pts.push([1, curveSpeedAt(c, u1)]);
  return pts;
}
export function normaliseCurve(k) {
  const pts = k.map(([x, sp]) => [clamp(x, 0, 1), clamp(sp, SPEED_MIN, SPEED_MAX)]).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
  if (pts[pts.length - 1][0] < 1) pts.push([1, pts[pts.length - 1][1]]);
  return pts;
}
// set or clear the curve; the amount of source footage stays the same, so the clip gets longer or shorter
export function setCurve(c, tr, k) {
  const srcSpan = c.dur * c.speed;
  const pts = k ? normaliseCurve(k) : null;
  const avg = pts ? Math.max(0.05, curveAvg(pts)) : (c.flatSpeed || 1);
  let dur = Math.max(MIN_DUR, Math.round(srcSpan / avg));
  const { nextStart } = neighbours(tr, c);
  if (c.start + dur > nextStart) dur = Math.max(MIN_DUR, nextStart - c.start);
  if (pts) { c.curve = pts; c.flatSpeed = c.flatSpeed || c.speed; } else { delete c.curve; delete c.flatSpeed; }
  c.speed = avg;
  c.dur = dur;
}

// ---- keyframes ---------------------------------------------------------
// c.kf = { x:[[u,v],...], y, scale, rot, opacity }: u is the position along the clip (0..1).
// A property with keyframes follows them (linear between points); otherwise it is the plain c[prop].
export const KF_PROPS = ['x', 'y', 'scale', 'rot', 'opacity'];
export function kfTrack(c, p) { return c.kf && c.kf[p] && c.kf[p].length ? c.kf[p] : null; }
// A point is [u, value] or [u, value, ease]; the ease shapes the stretch from that point to the next.
export const EASES = [['', 'Linear'], ['ease', 'Smooth'], ['in', 'Ease in'], ['out', 'Ease out'], ['hold', 'Hold']];
export function easeFn(e, p) {
  switch (e) {
    case 'ease': return p * p * (3 - 2 * p);
    case 'in': return p * p;
    case 'out': return p * (2 - p);
    case 'hold': return 0;
    default: return p;
  }
}
export function kfValue(k, u) {
  if (u <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (u <= k[i][0]) {
      const [u0, v0, e] = k[i - 1], [u1, v1] = k[i];
      return u1 === u0 ? v1 : v0 + (v1 - v0) * easeFn(e, (u - u0) / (u1 - u0));
    }
  }
  return k[k.length - 1][1];
}
// index of the point that starts the stretch containing u (-1 before the first point or after the last)
function segStart(k, u) {
  for (let i = 0; i < k.length - 1; i++) if (u >= k[i][0] - 1e-9 && u < k[i + 1][0] - 1e-9) return i;
  return -1;
}
// easing of the stretch under the playhead, taken from the first animated property
export function easeAt(c, t) {
  const u = clamp((t - c.start) / Math.max(1, c.dur), 0, 1);
  for (const p of KF_PROPS) {
    const k = kfTrack(c, p);
    if (!k || k.length < 2) continue;
    const i = segStart(k, u);
    if (i >= 0) return k[i][2] || '';
  }
  return null; // no stretch to ease here
}
// set the easing of the stretch under the playhead for every animated property
export function setEaseAt(c, t, e) {
  const u = clamp((t - c.start) / Math.max(1, c.dur), 0, 1);
  for (const p of KF_PROPS) {
    const k = kfTrack(c, p);
    if (!k || k.length < 2) continue;
    const i = segStart(k, u);
    if (i < 0) continue;
    k[i] = e ? [k[i][0], k[i][1], e] : [k[i][0], k[i][1]];
  }
}
export function propAt(c, p, t) {
  const k = kfTrack(c, p);
  return k ? kfValue(k, clamp((t - c.start) / Math.max(1, c.dur), 0, 1)) : c[p];
}
const KF_TOL = 0.004; // keyframes closer than this (fraction of the clip) count as the same one
export function kfIndexAt(c, p, t) {
  const k = kfTrack(c, p);
  if (!k) return -1;
  const u = (t - c.start) / Math.max(1, c.dur);
  return k.findIndex(([x]) => Math.abs(x - u) < KF_TOL);
}
export function hasKfAt(c, p, t) { return kfIndexAt(c, p, t) >= 0; }
export function anyKf(c) { return KF_PROPS.some((p) => kfTrack(c, p)); }
function putKf(c, p, u, v) {
  c.kf = c.kf || {};
  const k = c.kf[p] = c.kf[p] || [];
  const i = k.findIndex(([x]) => Math.abs(x - u) < KF_TOL);
  if (i >= 0) { k[i][1] = v; return; }
  // a new point splits a stretch: it keeps that stretch's easing
  const s = k.length > 1 ? segStart(k, u) : -1;
  const e = s >= 0 ? k[s][2] : '';
  k.push(e ? [u, v, e] : [u, v]);
  k.sort((a, b) => a[0] - b[0]);
}
// change a property at the playhead: edits or adds a keyframe when the property is animated
export function setPropAt(c, p, t, v) {
  if (kfTrack(c, p)) putKf(c, p, clamp((t - c.start) / Math.max(1, c.dur), 0, 1), v);
  else c[p] = v;
}
// the diamond button: add a keyframe here with the current value, or remove the one here
export function toggleKf(c, p, t) {
  const u = clamp((t - c.start) / Math.max(1, c.dur), 0, 1);
  const i = kfIndexAt(c, p, t);
  if (i < 0) { putKf(c, p, u, propAt(c, p, t)); return; }
  const k = c.kf[p];
  if (k.length === 1) c[p] = k[0][1];
  k.splice(i, 1);
  if (!k.length) delete c.kf[p];
  if (!Object.keys(c.kf).length) delete c.kf;
}
export function cropKf(c, u0, u1) {
  if (!c.kf) return null;
  const span = Math.max(1e-6, u1 - u0), out = {};
  for (const p of KF_PROPS) {
    const k = kfTrack(c, p);
    if (!k) continue;
    const s0 = segStart(k, u0);
    const e0 = s0 >= 0 ? k[s0][2] : '';
    const pts = [e0 ? [0, kfValue(k, u0), e0] : [0, kfValue(k, u0)]];
    for (const [x, v, e] of k) if (x > u0 + 1e-6 && x < u1 - 1e-6) pts.push(e ? [(x - u0) / span, v, e] : [(x - u0) / span, v]);
    pts.push([1, kfValue(k, u1)]);
    out[p] = pts;
  }
  return Object.keys(out).length ? out : null;
}

export function setSpeed(c, tr, speed) {
  if (c.curve) { delete c.curve; delete c.flatSpeed; }
  speed = clamp(speed, 0.1, 16);
  const srcSpan = c.dur * c.speed;
  let dur = Math.max(MIN_DUR, Math.round(srcSpan / speed));
  const { nextStart } = neighbours(tr, c);
  if (c.start + dur > nextStart) dur = Math.max(MIN_DUR, nextStart - c.start);
  c.speed = speed;
  c.dur = dur;
}

// Split the sound of a video clip onto its own audio track, at the same place and speed.
// The video clip is silenced. Returns the new audio clip, or null if there is nothing to detach.
export function detachAudio(clipId) {
  const f = findClip(clipId);
  if (!f) return null;
  const { clip: c, track: tr } = f;
  const m = media(c.media);
  if (tr.kind !== 'video' || !m || !m.has_audio) return null;
  const a = {
    id: uid(), media: c.media, start: c.start, dur: c.dur, in: c.in, speed: c.speed, x: 0, y: 0, scale: 1, rot: 0, opacity: 1,
    mirror: false, volume: c.volume, fade_in: c.fade_in || 0, fade_out: c.fade_out || 0, adj: defaultAdj(),
  };
  if (c.curve) { a.curve = c.curve.map((p) => p.slice()); if (c.flatSpeed) a.flatSpeed = c.flatSpeed; }
  mutate('Detach audio', () => {
    let at = S.doc.tracks.find((t) => t.kind === 'audio' && !t.locked && !overlaps(t, a.start, a.dur));
    if (!at) {
      at = { id: 't-' + uid(), kind: 'audio', muted: false, hidden: false, locked: false, clips: [] };
      S.doc.tracks.unshift(at);
    }
    addClipToTrack(at, a);
    c.volume = 0;
    c.fade_in = 0;
    c.fade_out = 0;
    S.sel = a.id;
  });
  return a;
}

export function addTrack(kind) {
  const id = 't-' + uid();
  const tr = { id, kind, muted: false, hidden: false, locked: false, clips: [] };
  mutate('Add track', () => {
    const tracks = S.doc.tracks;
    if (kind === 'audio') {
      tracks.unshift(tr); // below everything
    } else {
      // above the top video track, below text
      let idx = tracks.map((t) => t.kind).lastIndexOf('video');
      tracks.splice(idx + 1, 0, tr);
    }
  });
}
export function removeTrack(id) {
  const tr = S.doc.tracks.find((t) => t.id === id);
  if (!tr || tr.clips.length) return false;
  if (S.doc.tracks.filter((t) => t.kind === tr.kind).length < 2) return false;
  mutate('Remove track', () => { S.doc.tracks = S.doc.tracks.filter((t) => t.id !== id); });
  return true;
}
export function toggleTrack(id, key) {
  const tr = S.doc.tracks.find((t) => t.id === id);
  if (tr) mutate('Track ' + key, () => { tr[key] = !tr[key]; });
}

// Snap points: 0, playhead, markers and every clip edge except the clip being moved.
export function snapPoints(exceptId) {
  const pts = [0, S.t];
  for (const m of S.doc.markers || []) pts.push(m.time);
  for (const tr of S.doc.tracks) for (const c of tr.clips) if (c.id !== exceptId) { pts.push(c.start, clipEnd(c)); }
  return pts;
}
export function snapTime(t, exceptId, thresholdUs) {
  if (!S.snap) return { t, hit: null };
  let best = null, bd = thresholdUs;
  for (const p of snapPoints(exceptId)) {
    const d = Math.abs(p - t);
    if (d <= bd) { bd = d; best = p; }
  }
  return best === null ? { t, hit: null } : { t: best, hit: best };
}
