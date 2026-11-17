// Media library helpers: importing files, background proxy copies, and checking files still exist.
import { api, waitJob } from './api.js';
import { S, emit, markDirty, media } from './state.js';
import { toast } from './ui.js';

const repaired = new Set(); // files already given a repair attempt this session

// Wait for a proxy copy to finish, then switch the preview over to it.
export function watchProxy(m) {
  const job = m.proxy_job;
  if (!job) return;
  waitJob(job, null)
    .then((j) => {
      if (j.state === 'done' && j.result && j.result.proxy) m.proxy = j.result.proxy;
      else if (j.state === 'error' && repaired.has(m.id)) toast(`Could not make a preview copy of ${m.name || 'a clip'}: ${j.message}`, 'error');
      delete m.proxy_job;
      markDirty();
      emit('change', { source: 'media' });
      emit('media');
    })
    .catch(() => { delete m.proxy_job; emit('media'); });
}

// Reads the files, adds new ones to the project, and returns the media records for all of them.
export async function importPaths(paths) {
  if (!paths.length) return [];
  let r;
  try {
    r = await api('media_import', { paths });
  } catch (e) {
    toast(e.message, 'error');
    return [];
  }
  const out = [];
  for (const it of r.items) {
    if (it.error) {
      toast(`${it.name}: ${it.error}`, 'error');
      continue;
    }
    let m = media(it.id);
    if (!m) {
      m = it;
      S.doc.media.push(m);
    } else {
      m.missing = false;
    }
    out.push(m);
    watchProxy(m);
  }
  if (out.length) {
    markDirty();
    emit('change', { source: 'media' });
    emit('media');
  }
  return out;
}

// After opening a project: mark missing files and restart any proxy copies that are gone.
export async function checkMedia() {
  const items = S.doc.media.map((m) => ({ id: m.id, path: m.path, proxy: m.proxy || '', kind: m.kind }));
  if (!items.length) return;
  try {
    const r = await api('media_check', { items });
    for (const it of r.items) {
      const m = media(it.id);
      if (!m) continue;
      m.missing = !it.exists;
      if (it.proxy_job) {
        m.proxy_job = it.proxy_job;
        m.proxy = '';
        watchProxy(m);
      }
    }
    emit('change', { source: 'media' });
    emit('media');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// The preview could not play this file as it is: ask the engine for a preview copy (once per file).
// The preview switches over by itself when the copy is ready.
export async function repairPreview(m) {
  if (!m || m.proxy_job || repaired.has(m.id) || m.missing || m.kind === 'text') return false;
  repaired.add(m.id);
  try {
    const r = await api('media_proxy', { id: m.id, path: m.path });
    m.proxy = '';
    m.proxy_job = r.job;
  } catch (e) {
    toast(`${m.name || 'A clip'} cannot be previewed: ${e.message}`, 'error');
    return false;
  }
  watchProxy(m);
  emit('media');
  return true;
}
