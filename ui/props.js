// Properties panel: edits the selected clip. Every change is one undoable step per drag.
import {
  S, US, on, mutate, selected, media, clipKind, setSpeed, deleteClip, duration, clamp, defaultAdj, fmtDur,
  propAt, kfTrack, hasKfAt, setPropAt, toggleKf, EASES, easeAt, setEaseAt, detachAudio,
} from './state.js';
import { h } from './ui.js';
import { speedCurveSection } from './speedcurve.js';
import { MASK_SHAPES, defaultMask } from './maskshape.js';
import { api, waitJob } from './api.js';
import { toast } from './ui.js';

export const TRANSITIONS = [
  { id: '', label: 'None' },
  { id: 'dissolve', label: 'Dissolve' },
  { id: 'zoom', label: 'Zoom in' },
  { id: 'slide-left', label: 'Slide left' },
  { id: 'slide-right', label: 'Slide right' },
  { id: 'slide-up', label: 'Slide up' },
];

let syncs = [];
const root = () => document.getElementById('props');

export function initProps() {
  on('select', render);
  on('change', (d) => { if (d && d.source === 'prop') return; render(); });
  on('propsrefresh', () => syncs.forEach((f) => f()));
  on('time', () => syncs.forEach((f) => f()));
}

const shown = (v, step) => {
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return Number(v).toFixed(dec);
};

function sec(title, ...rows) { return h('div', { class: 'sec' }, h('h4', { text: title }), ...rows); }

function slider(label, get, set, { min, max, step, def, key, kf }) {
  const range = h('input', { type: 'range', min, max, step, 'aria-label': label });
  const num = h('input', { type: 'number', class: 'field', min, max, step, 'aria-label': label + ' value' });
  const diamond = kf ? h('button', { class: 'kf', type: 'button', title: 'Add or remove a keyframe at the playhead', 'aria-label': label + ' keyframe' }, '◆') : null;
  const clipNow = () => (S.doc && S.doc.tracks.flatMap((t) => t.clips).find((x) => x.id === S.sel)) || null;
  const sync = () => {
    const c = kf ? clipNow() : null;
    const v = c ? propAt(c, kf, S.t) : get();
    range.value = v; num.value = shown(v, step);
    if (diamond && c) { diamond.classList.toggle('on', hasKfAt(c, kf, S.t)); diamond.classList.toggle('anim', !!kfTrack(c, kf)); }
  };
  const apply = (v) => {
    if (!Number.isFinite(v)) { sync(); return; }
    v = clamp(v, min, max);
    if (kf) {
      const c = clipNow();
      if (c) mutate(label, () => setPropAt(c, kf, S.t, v), { coalesce: (key || label) + ':' + Math.round(S.t / 1000), source: 'prop' });
    } else {
      mutate(label, () => set(v), { coalesce: key || label, source: 'prop' });
    }
    sync();
  };
  if (diamond) diamond.addEventListener('click', () => {
    const c = clipNow();
    if (!c) return;
    mutate('Keyframe ' + label, () => toggleKf(c, kf, S.t), { source: 'prop' });
    sync();
  });
  range.addEventListener('input', () => apply(parseFloat(range.value)));
  num.addEventListener('change', () => apply(parseFloat(num.value)));
  if (def !== undefined) range.addEventListener('dblclick', () => apply(def));
  range.title = def !== undefined ? 'Double-click to reset' : '';
  syncs.push(sync);
  sync();
  return h('div', { class: 'prow' + (diamond ? ' kfrow' : '') }, h('label', { text: label }), range, num, ...(diamond ? [diamond] : []));
}

// How the animation moves between the two keyframes around the playhead (applies to every animated property).
function easingRow() {
  const clipNow = () => (S.doc && S.doc.tracks.flatMap((t) => t.clips).find((x) => x.id === S.sel)) || null;
  const btns = EASES.map(([id, label]) => h('button', {
    class: 'btn sm', type: 'button', text: label,
    onclick: () => {
      const c = clipNow();
      if (!c) return;
      mutate('Keyframe easing', () => setEaseAt(c, S.t, id), { source: 'prop' });
      sync();
    },
  }));
  const row = h('div', { class: 'chips', title: 'How the animation moves between the keyframes around the playhead' }, ...btns);
  function sync() {
    const c = clipNow();
    const cur = c ? easeAt(c, S.t) : null;
    row.style.opacity = cur === null ? '0.45' : '1';
    btns.forEach((b, i) => { b.disabled = cur === null; b.classList.toggle('on', cur !== null && EASES[i][0] === cur); });
  }
  syncs.push(sync);
  sync();
  return h('div', { class: 'prow two' }, h('label', { text: 'Easing' }), row);
}

function check(label, get, set) {
  const box = h('input', { type: 'checkbox' });
  box.checked = !!get();
  box.addEventListener('change', () => { mutate(label, () => set(box.checked), { source: 'prop' }); });
  syncs.push(() => { box.checked = !!get(); });
  return h('div', { class: 'prow two' }, h('span', {}), h('label', { class: 'check' }, box, label));
}

let cutoutBusy = new Set(); // media ids being processed
const cutoutJobs = new Map(); // media id -> running job id (so it can be cancelled)

// Background removal: the AI matte is made once per video (kept in the cache), then switched on or off per clip.
function cutoutSection(c, m) {
  const status = h('div', { class: 'hint' });
  const bar = h('div', { class: 'bar', hidden: true }, h('i'));
  const btn = h('button', { class: 'btn', type: 'button' });
  const stop = h('button', { class: 'btn', type: 'button', text: 'Cancel', hidden: true, onclick: () => { const j = cutoutJobs.get(m.id); if (j) api('job_cancel', { id: j }); } });
  const busy = cutoutBusy.has(m.id);
  const paint = () => {
    btn.textContent = c.cutout ? 'Bring the background back' : 'Remove background';
    btn.disabled = cutoutBusy.has(m.id) || !(S.sys && S.sys.cutout);
    status.textContent = !(S.sys && S.sys.cutout)
      ? 'Background removal is not included in this copy of the app.'
      : cutoutBusy.has(m.id) ? 'Finding the person or object… you can keep editing.'
      : c.cutout ? 'Background removed. Works best on a clear subject. Moves with the clip.'
      : 'Cuts out the main person or object using a built-in AI model. Nothing is uploaded.';
  };
  btn.addEventListener('click', async () => {
    if (c.cutout) { mutate('Bring background back', () => { delete c.cutout; }); return; }
    if (cutoutBusy.has(m.id)) return;
    cutoutBusy.add(m.id);
    bar.hidden = false;
    paint();
    try {
      const r = await api('cutout_start', { id: m.id, path: m.path, proxy: m.proxy || '', dur: m.dur / US });
      let mask = r.mask;
      if (r.job) {
        cutoutJobs.set(m.id, r.job);
        stop.hidden = false;
        const j = await waitJob(r.job, (p) => { bar.firstChild.style.width = p + '%'; });
        cutoutJobs.delete(m.id);
        if (j.state === 'cancelled' || /cancel/i.test(j.message || '')) return;
        if (j.state !== 'done') throw new Error(j.message || 'Background removal did not finish');
        mask = j.result.mask;
      }
      m.cutoutMask = mask;
      cutoutBusy.delete(m.id);
      mutate('Remove background', () => { c.cutout = mask; });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      cutoutBusy.delete(m.id);
      cutoutJobs.delete(m.id);
      bar.hidden = true;
      stop.hidden = true;
      paint();
    }
  });
  paint();
  bar.hidden = !busy;
  stop.hidden = !busy;
  const edge = c.cutout ? [
    slider('Edge softness', () => c.cutout_soft || 0, (v) => { c.cutout_soft = v; }, { min: 0, max: 1, step: 0.05, def: 0 }),
    slider('Grow / shrink', () => c.cutout_grow || 0, (v) => { c.cutout_grow = v; }, { min: -1, max: 1, step: 0.05, def: 0 }),
  ] : [];
  return sec('Background', h('div', { class: 'row' }, btn, stop), bar, status, ...edge);
}

function render() {
  const el = root();
  if (!el) return;
  syncs = [];
  el.replaceChildren();
  if (!S.doc) return;
  const f = selected();
  if (!f) { el.append(projectInfo()); return; }
  const { clip: c, track: tr } = f;
  const kind = clipKind(c, tr);
  const m = media(c.media);
  const visual = kind === 'video' || kind === 'image' || kind === 'text';
  const locked = tr.locked;

  el.append(h('div', { class: 'sec' },
    h('b', { text: kind === 'text' ? 'Text' : (m ? m.name : 'Clip'), style: 'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }),
    h('div', { class: 'hint', text: `${kind[0].toUpperCase() + kind.slice(1)} clip, ${(c.dur / US).toFixed(2)} s${locked ? ', track is locked' : ''}` })));

  if (c.text) {
    const ta = h('textarea', { rows: 3, style: 'width:100%', 'aria-label': 'Text' });
    ta.value = c.text.content;
    ta.addEventListener('input', () => mutate('Edit text', () => { c.text.content = ta.value; }, { coalesce: 'text:' + c.id, source: 'prop' }));
    const color = h('input', { type: 'color', 'aria-label': 'Text colour' });
    color.value = /^#[0-9a-f]{6}$/i.test(c.text.color) ? c.text.color : '#ffffff';
    color.addEventListener('input', () => mutate('Text colour', () => { c.text.color = color.value; }, { coalesce: 'tcolor:' + c.id, source: 'prop' }));
    el.append(sec('Text', ta,
      slider('Size', () => c.text.size, (v) => { c.text.size = v; }, { min: 0.02, max: 0.3, step: 0.005, def: 0.09 }),
      h('div', { class: 'prow two' }, h('label', { text: 'Colour' }), color),
      check('Bold', () => c.text.bold, (v) => { c.text.bold = v; }),
      check('Outline', () => c.text.outline, (v) => { c.text.outline = v; }),
      check('Shadow', () => c.text.shadow, (v) => { c.text.shadow = v; }),
      check('Background box', () => c.text.boxed, (v) => { c.text.boxed = v; })));
  }

  if (visual) {
    el.append(sec('Position and size',
      slider('X', () => c.x, (v) => { c.x = Math.round(v); }, { min: -S.doc.width, max: S.doc.width, step: 1, def: 0, kf: 'x' }),
      slider('Y', () => c.y, (v) => { c.y = Math.round(v); }, { min: -S.doc.height, max: S.doc.height, step: 1, def: 0, kf: 'y' }),
      slider('Scale', () => c.scale, (v) => { c.scale = v; }, { min: 0.1, max: 4, step: 0.01, def: 1, kf: 'scale' }),
      slider('Rotation', () => c.rot, (v) => { c.rot = v; }, { min: -180, max: 180, step: 1, def: 0, kf: 'rot' }),
      slider('Opacity', () => c.opacity, (v) => { c.opacity = v; }, { min: 0, max: 1, step: 0.01, def: 1, kf: 'opacity' }),
      easingRow(),
      kind !== 'text' ? check('Mirror', () => c.mirror, (v) => { c.mirror = v; }) : null));
  }

  if (kind === 'video' || kind === 'audio') {
    el.append(sec('Speed',
      slider('Speed', () => c.speed, (v) => setSpeed(c, tr, v), { min: 0.25, max: 4, step: 0.05, def: 1 }),
      h('div', { class: 'hint', text: 'Changing the speed changes how long the clip is.' })));
    const curveBox = speedCurveSection(c, tr, () => { syncs.forEach((f) => f()); document.dispatchEvent(new Event('tlredraw')); });
    syncs.push(() => curveBox.redraw());
    el.append(sec('Speed curve', curveBox));
  }

  if (visual && kind !== 'text') {
    const mk = c.mask && c.mask.shape ? c.mask : null;
    const chips = h('div', { class: 'chips' }, ...MASK_SHAPES.map((sh) => h('button', {
      class: 'btn sm' + ((mk ? mk.shape : '') === sh.id ? ' on' : ''), type: 'button', text: sh.label,
      onclick: () => mutate('Mask: ' + sh.label, () => { if (!sh.id) delete c.mask; else c.mask = mk && mk.shape ? Object.assign({}, mk, { shape: sh.id }) : defaultMask(sh.id); }),
    })));
    const ms = (label, key, min, max, step, def) => slider(label, () => (c.mask ? c.mask[key] : def), (v) => { if (c.mask) c.mask[key] = v; }, { min, max, step, def, key: 'mask-' + key });
    el.append(sec('Mask', chips, ...(mk ? [
      ms('X', 'x', -1, 1, 0.01, 0), ms('Y', 'y', -1, 1, 0.01, 0),
      ms('Width', 'w', 0.05, 3, 0.01, 0.6), ms('Height', 'h', 0.05, 3, 0.01, 0.6),
      ms('Rotation', 'rot', -180, 180, 1, 0), ms('Feather', 'feather', 0, 1, 0.01, 0.1),
      check('Invert', () => c.mask && c.mask.invert, (v) => { if (c.mask) c.mask.invert = v; }),
    ] : [])));
  }

  if (kind === 'video' && m) el.append(cutoutSection(c, m));

  if (kind === 'audio' || (kind === 'video' && m && m.has_audio)) {
    const maxFade = Math.max(0.1, Math.min(5, c.dur / US / 2));
    el.append(sec('Audio',
      slider('Volume', () => c.volume, (v) => { c.volume = v; }, { min: 0, max: 2, step: 0.01, def: 1 }),
      slider('Fade in', () => c.fade_in / US, (v) => { c.fade_in = Math.round(v * US); }, { min: 0, max: maxFade, step: 0.1, def: 0 }),
      slider('Fade out', () => c.fade_out / US, (v) => { c.fade_out = Math.round(v * US); }, { min: 0, max: maxFade, step: 0.1, def: 0 }),
      ...(kind === 'video' ? [h('div', { class: 'prow two' }, h('span', {}), h('button', {
        class: 'btn sm', type: 'button', text: 'Detach audio', title: 'Move this clip\'s sound to its own audio track',
        onclick: () => { if (!detachAudio(c.id)) toast('This clip has no sound to detach.'); },
      }))] : [])));
  }

  if (kind === 'video' || kind === 'image') {
    const adj = () => (c.adj ||= defaultAdj());
    const reset = h('button', { class: 'btn sm', text: 'Reset colour', onclick: () => { mutate('Reset colour', () => { c.adj = defaultAdj(); }); } });
    el.append(sec('Colour',
      slider('Brightness', () => adj().brightness, (v) => { adj().brightness = v; }, { min: -1, max: 1, step: 0.01, def: 0 }),
      slider('Contrast', () => adj().contrast, (v) => { adj().contrast = v; }, { min: 0, max: 2, step: 0.01, def: 1 }),
      slider('Saturation', () => adj().saturation, (v) => { adj().saturation = v; }, { min: 0, max: 3, step: 0.01, def: 1 }),
      slider('Hue', () => adj().hue, (v) => { adj().hue = v; }, { min: -180, max: 180, step: 1, def: 0 }),
      slider('Warmth', () => adj().warmth, (v) => { adj().warmth = v; }, { min: -1, max: 1, step: 0.01, def: 0 }),
      slider('Blur', () => adj().blur, (v) => { adj().blur = v; }, { min: 0, max: 40, step: 0.5, def: 0 }),
      h('div', { class: 'prow two' }, h('span', {}), reset)));

    const sel = h('select', { class: 'field', 'aria-label': 'Transition' }, TRANSITIONS.map((t) => h('option', { value: t.id, text: t.label })));
    sel.value = c.transition_in ? c.transition_in.kind : '';
    sel.addEventListener('change', () => {
      mutate('Transition', () => {
        c.transition_in = sel.value ? { kind: sel.value, dur: c.transition_in ? c.transition_in.dur : 600000 } : null;
      });
    });
    const rows = [h('div', { class: 'prow two' }, h('label', { text: 'Style' }), sel)];
    if (c.transition_in) {
      rows.push(slider('Length', () => (c.transition_in ? c.transition_in.dur / US : 0.6), (v) => { if (c.transition_in) c.transition_in.dur = Math.round(v * US); },
        { min: 0.1, max: Math.max(0.2, Math.min(3, c.dur / US)), step: 0.05, def: 0.6 }));
    }
    el.append(sec('Transition in', ...rows, h('div', { class: 'hint', text: 'Plays as this clip begins.' })));
  }

  el.append(sec('Clip',
    h('div', { class: 'row', style: 'gap:8px' },
      h('button', { class: 'btn sm danger', text: 'Delete', onclick: () => deleteClip(c.id, false) }),
      h('button', { class: 'btn sm', text: 'Delete and close gap', onclick: () => deleteClip(c.id, true) }))));
}

function projectInfo() {
  let clips = 0;
  for (const t of S.doc.tracks) clips += t.clips.length;
  return h('div', {},
    sec('Project',
      h('div', { class: 'prow two' }, h('label', { text: 'Size' }), h('span', { text: `${S.doc.width} × ${S.doc.height}` })),
      h('div', { class: 'prow two' }, h('label', { text: 'Frame rate' }), h('span', { text: `${S.doc.fps} fps` })),
      h('div', { class: 'prow two' }, h('label', { text: 'Length' }), h('span', { text: duration() ? fmtDur(duration()) : 'empty' })),
      h('div', { class: 'prow two' }, h('label', { text: 'Clips' }), h('span', { text: String(clips) }))),
    h('p', { class: 'hint', text: 'Select a clip on the timeline or in the preview to edit it here.' }));
}

export { render as renderProps };
