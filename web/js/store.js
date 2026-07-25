/* ==========================================================================
   store.js — estado persistente.

   IndexedDB como almacén principal (sobrevive más que localStorage), con
   localStorage de respaldo si IndexedDB no está disponible (modo privado,
   permisos raros). Todo el estado vive en UN solo registro; es pequeño y
   así el export/import es trivial.
   ========================================================================== */

const DB_NAME = 'english-lab';
const DB_VER = 1;
const STORE = 'kv';
const KEY = 'state';
const LS_KEY = 'english-lab-state';

const EMPTY = {
  version: 1,
  createdAt: null,
  updatedAt: 0,     // epoch ms; lo usa la sincronización para saber qué es más reciente
  uid: null,        // cuenta de Google con la que se sincronizó por última vez
  xp: 0,
  streak: { count: 0, last: null },
  units: {},        // 'a1u1' -> { done, best, attempts, ts }
  srs: {},          // 'a1u1::hello' -> { box, due, seen, ok, en, es, ipa, example, unit }
  diagnostic: null, // { level, correct, total, byLevel, estimate, ts }
  exams: {},        // 'simulacro-01' -> [ { score, total, sections, ts, seconds } ]
  writing: {},      // 'a1u1' -> { text, selfScore, ts }
  settings: { theme: 'dark', voice: 'uk', rate: 0.95, autoplay: true }
};

let state = structuredClone(EMPTY);
let db = null;
let saveTimer = null;

/* ---------- fecha local (nunca UTC: la racha se rompe sola si usas UTC) --- */

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/* ---------- apertura ---------- */

function openDB() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VER);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // Si IndexedDB se queda colgado (pasa en algunos perfiles de Chrome),
    // no dejamos la app esperando para siempre.
    setTimeout(() => resolve(null), 2500);
  });
}

function idbGet() {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idbPut(value) {
  return new Promise((resolve) => {
    if (!db) return resolve(false);
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}

/** Carga el estado. Se llama una vez al arrancar. */
export async function init() {
  db = await openDB();
  let loaded = await idbGet();

  if (!loaded) {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) loaded = JSON.parse(raw);
    } catch { /* ignorado a propósito: un respaldo corrupto no debe tumbar la app */ }
  }

  if (loaded && typeof loaded === 'object') {
    state = migrate(loaded);
  } else {
    state = structuredClone(EMPTY);
    state.createdAt = new Date().toISOString();
  }

  applyTheme(state.settings.theme);
  return state;
}

/** Rellena claves que falten para que versiones viejas del respaldo no rompan. */
function migrate(obj) {
  const s = { ...structuredClone(EMPTY), ...obj };
  s.settings = { ...EMPTY.settings, ...(obj.settings || {}) };
  s.streak = { ...EMPTY.streak, ...(obj.streak || {}) };
  for (const k of ['units', 'srs', 'exams', 'writing']) {
    if (!s[k] || typeof s[k] !== 'object') s[k] = {};
  }
  if (typeof s.xp !== 'number' || !isFinite(s.xp)) s.xp = 0;
  return s;
}

/* ---------- guardado ---------- */

const listeners = new Set();

/** Avisa a la capa de sincronización que el estado cambió. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function persistNow() {
  state.updatedAt = Date.now();
  const snapshot = structuredClone(state);
  idbPut(snapshot);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
  } catch { /* cuota llena: IndexedDB ya guardó, seguimos */ }
  for (const fn of listeners) {
    try { fn(snapshot); } catch { /* un listener roto no debe tumbar el guardado */ }
  }
}

/** Guardado con rebote — evita escribir en cada tecla de un ejercicio. */
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 350);
}

/** Guardado inmediato, para antes de cerrar la pestaña. */
export function saveNow() {
  clearTimeout(saveTimer);
  persistNow();
}

window.addEventListener('beforeunload', saveNow);
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
});

/* ---------- lectura ---------- */

export function get() { return state; }
export function settings() { return state.settings; }

export function unitProgress(unitId) {
  return state.units[unitId] || null;
}

export function levelProgress(levelId, unitIds) {
  const done = unitIds.filter((id) => state.units[id]?.done).length;
  return { done, total: unitIds.length, pct: unitIds.length ? done / unitIds.length : 0 };
}

/* ---------- escritura ---------- */

export function addXP(n) {
  state.xp += n;
  save();
  return state.xp;
}

/**
 * Marca actividad del día y actualiza la racha.
 * Devuelve true si la racha creció (para poder felicitar sin mentir).
 */
export function touchStreak() {
  const t = today();
  const last = state.streak.last;
  if (last === t) return false;
  state.streak.count = last && addDays(last, 1) === t ? state.streak.count + 1 : 1;
  state.streak.last = t;
  save();
  return true;
}

export function completeUnit(unitId, ratio) {
  const prev = state.units[unitId] || { done: false, best: 0, attempts: 0 };
  state.units[unitId] = {
    done: prev.done || ratio >= 0.7,
    best: Math.max(prev.best || 0, ratio),
    attempts: (prev.attempts || 0) + 1,
    ts: Date.now()
  };
  save();
  return state.units[unitId];
}

export function saveDiagnostic(result) {
  state.diagnostic = { ...result, ts: Date.now() };
  save();
}

export function saveExam(examId, result) {
  if (!state.exams[examId]) state.exams[examId] = [];
  state.exams[examId].push({ ...result, ts: Date.now() });
  save();
}

export function saveWriting(unitId, text, selfScore) {
  state.writing[unitId] = { text, selfScore, ts: Date.now() };
  save();
}

export function setSetting(key, value) {
  state.settings[key] = value;
  if (key === 'theme') applyTheme(value);
  save();
}

/* ---------- tema ---------- */

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

export function toggleTheme() {
  const next = state.settings.theme === 'light' ? 'dark' : 'light';
  setSetting('theme', next);
  return next;
}

/* ---------- respaldo ---------- */

/**
 * Descarga todo el progreso como JSON.
 * Esto existe porque el estado vive en el navegador: un "limpiar datos de
 * navegación" borra semanas de estudio sin preguntar.
 */
export function exportProgress() {
  saveNow();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `english-lab-progreso-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Lee un File y reemplaza el estado. Lanza si el archivo no es válido. */
export async function importProgress(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('El archivo no es JSON válido.');
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'number') {
    throw new Error('No parece un respaldo de English Lab.');
  }
  state = migrate(parsed);
  saveNow();
  applyTheme(state.settings.theme);
  return state;
}

export function resetAll() {
  state = structuredClone(EMPTY);
  state.createdAt = new Date().toISOString();
  saveNow();
  applyTheme(state.settings.theme);
}

/* ---------- fusión para la sincronización ---------- */

/**
 * Fusiona un estado remoto con el local SIN perder nada.
 *
 * No es "el más reciente gana": eso tiraría semanas de estudio si practicaste
 * en el teléfono y luego abriste la laptop, que llevaba un estado viejo. Se
 * fusiona campo por campo quedándose siempre con lo más avanzado.
 *
 * Devuelve un resumen de qué entró, para poder decírselo al usuario.
 */
export function mergeRemote(remote) {
  if (!remote || typeof remote !== 'object') return null;
  const r = migrate(remote);
  const resumen = { unidades: 0, tarjetas: 0, examenes: 0, xpAntes: state.xp, diagnostico: false };

  // XP y racha: el máximo. Sumarlos inflaría por sincronizar dos veces.
  state.xp = Math.max(state.xp, r.xp);
  if (r.streak.count > state.streak.count) state.streak = { ...r.streak };

  // Unidades: gana el mejor porcentaje; los intentos se suman.
  for (const [id, ru] of Object.entries(r.units)) {
    const lu = state.units[id];
    if (!lu) { state.units[id] = ru; resumen.unidades++; continue; }
    state.units[id] = {
      done: lu.done || ru.done,
      best: Math.max(lu.best || 0, ru.best || 0),
      attempts: Math.max(lu.attempts || 0, ru.attempts || 0),
      ts: Math.max(lu.ts || 0, ru.ts || 0)
    };
  }

  // Flashcards: gana la que va más adelantada (caja más alta).
  for (const [id, rc] of Object.entries(r.srs)) {
    const lc = state.srs[id];
    if (!lc) { state.srs[id] = rc; resumen.tarjetas++; continue; }
    state.srs[id] = (rc.box || 0) > (lc.box || 0) ? rc : lc;
    state.srs[id].seen = Math.max(lc.seen || 0, rc.seen || 0);
    state.srs[id].ok = Math.max(lc.ok || 0, rc.ok || 0);
  }

  // Exámenes: se conservan TODOS los intentos, deduplicando por timestamp.
  for (const [id, runs] of Object.entries(r.exams)) {
    const vistos = new Set((state.exams[id] || []).map((x) => x.ts));
    for (const run of runs) {
      if (!vistos.has(run.ts)) { (state.exams[id] ||= []).push(run); resumen.examenes++; }
    }
    if (state.exams[id]) state.exams[id].sort((a, b) => a.ts - b.ts);
  }

  // Diagnóstico y writing: gana el más reciente.
  if (r.diagnostic && (!state.diagnostic || r.diagnostic.ts > state.diagnostic.ts)) {
    state.diagnostic = r.diagnostic;
    resumen.diagnostico = true;
  }
  for (const [id, rw] of Object.entries(r.writing)) {
    if (!state.writing[id] || rw.ts > state.writing[id].ts) state.writing[id] = rw;
  }

  saveNow();
  resumen.xpDespues = state.xp;
  return resumen;
}

/** Copia del estado lista para subir. */
export function snapshot() {
  return structuredClone(state);
}

export function setUid(uid) {
  state.uid = uid;
  save();
}
