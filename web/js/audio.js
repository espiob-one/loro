/* ==========================================================================
   audio.js — reproducción con degradación elegante.

   Orden de intento:
     1. .mp3 pregenerado con ElevenLabs (si tools/gen_audio.py ya lo generó)
     2. Web Speech API del navegador (siempre disponible en Chrome/Edge)
     3. Nada, pero sin romper nada — el texto siempre se puede mostrar

   El índice es un mapa explícito {texto exacto -> archivo}, no un hash
   calculado en los dos lados. Menos elegante, imposible de desincronizar.
   ========================================================================== */

import { settings } from './store.js';

let index = {};       // { "texto exacto": "abc123.mp3" }
let base = 'audio/';  // de dónde se sirven los mp3; puede ser un CDN externo
let suffix = '';      // Firebase Storage exige ?alt=media al final
let indexLoaded = false;
let voices = [];
let current = null;   // Audio o utterance en curso

/* ---------- arranque ---------- */

export async function init() {
  // Índice de audio. Si no existe (aún no se ha generado nada), seguimos.
  try {
    const res = await fetch('audio/index.json', { cache: 'no-cache' });
    if (res.ok) {
      const raw = await res.json();
      // Formato nuevo: { base, files }. Formato viejo: el mapa a secas.
      if (raw && raw.files) {
        index = raw.files;
        // `base` permite servir los mp3 desde fuera del repo (Firebase Storage,
        // R2, cualquier CDN). Así el repo se queda en cientos de KB en vez de
        // arrastrar 32 MB de audio en el historial de git para siempre.
        if (raw.base) base = raw.base.endsWith('/') ? raw.base : raw.base + '/';
        if (raw.suffix) suffix = raw.suffix;
      } else {
        index = raw || {};
      }
    }
  } catch { /* sin índice: todo va por TTS */ }
  indexLoaded = true;

  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }
}

function loadVoices() {
  try {
    voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  } catch { voices = []; }
}

function pickVoice() {
  if (!voices.length) return null;
  const want = settings().voice === 'us' ? 'en-US' : 'en-GB';
  return (
    voices.find((v) => v.lang === want && /natural|premium|enhanced/i.test(v.name)) ||
    voices.find((v) => v.lang === want) ||
    voices.find((v) => v.lang.startsWith(want.slice(0, 2))) ||
    voices[0]
  );
}

/* ---------- reproducción ---------- */

export function stop() {
  if (current instanceof HTMLAudioElement) {
    current.pause();
    current.currentTime = 0;
  }
  try { speechSynthesis.cancel(); } catch { /* no soportado */ }
  current = null;
}

/**
 * Reproduce `text`. Devuelve la fuente usada: 'mp3' | 'tts' | 'none'.
 * Nunca lanza: si no hay forma de reproducir, devuelve 'none' y ya.
 */
export async function play(text, { rate } = {}) {
  stop();
  const clean = String(text || '').trim();
  if (!clean) return 'none';

  const file = index[clean];
  if (file) {
    const ok = await playFile(base + file + suffix);
    if (ok) return 'mp3';
    // El mp3 está en el índice pero no en disco (borrado, generación a
    // medias). No es motivo para dejar al usuario sin audio.
  }

  return speak(clean, rate) ? 'tts' : 'none';
}

function playFile(src) {
  return new Promise((resolve) => {
    const a = new Audio(src);
    a.playbackRate = 1;
    current = a;
    a.onended = () => { current = null; };
    a.onerror = () => resolve(false);
    a.play().then(() => resolve(true)).catch(() => resolve(false));
  });
}

function speak(text, rate) {
  if (!('speechSynthesis' in window)) return false;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v?.lang || (settings().voice === 'us' ? 'en-US' : 'en-GB');
    u.rate = rate ?? settings().rate ?? 0.95;
    u.onend = () => { current = null; };
    current = u;
    speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

/** ¿Este texto tiene mp3 real, o va a sonar sintético? */
export function hasRealAudio(text) {
  return Boolean(index[String(text || '').trim()]);
}

export function indexSize() {
  return indexLoaded ? Object.keys(index).length : 0;
}

/* ---------- componentes de UI ---------- */

/** Botón grande de "escuchar", para reactivos de listening. */
export function audioButton(text, label = 'Escuchar') {
  const wrap = document.createElement('div');
  wrap.className = 'row';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'audio-btn';
  btn.innerHTML = `<span>🔊</span><span>${label}</span>`;

  const src = document.createElement('span');
  src.className = 'audio-src';

  btn.onclick = async () => {
    btn.classList.add('playing');
    const used = await play(text);
    btn.classList.remove('playing');
    src.textContent = used === 'mp3' ? '' : used === 'tts' ? 'voz sintética' : 'sin audio disponible';
  };

  const slow = document.createElement('button');
  slow.type = 'button';
  slow.className = 'btn btn-sm btn-ghost';
  slow.textContent = '0.7×';
  slow.title = 'Más despacio';
  slow.onclick = () => play(text, { rate: 0.7 });

  wrap.append(btn, slow, src);
  return wrap;
}

/** Bocina chiquita, para pronunciar una palabra suelta del vocabulario. */
export function speakerIcon(text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'speak-word';
  b.textContent = '🔊';
  b.title = `Pronunciar "${text}"`;
  b.setAttribute('aria-label', `Pronunciar ${text}`);
  b.onclick = (e) => { e.stopPropagation(); play(text); };
  return b;
}

/* ---------- speaking (T9) ---------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

/** ¿El navegador soporta reconocimiento de voz? Si no, el botón no se dibuja. */
export function canRecognize() {
  return Boolean(SR);
}

/**
 * Escucha una frase y la compara con `target`.
 * Ojo: en Chrome esto manda el audio a un servicio en la nube — es la única
 * parte de la app que necesita red. Por eso nunca se asume disponible.
 */
export function recognize(target, onResult) {
  if (!SR) return null;
  let rec;
  try {
    rec = new SR();
  } catch {
    return null;
  }
  rec.lang = settings().voice === 'us' ? 'en-US' : 'en-GB';
  rec.interimResults = false;
  rec.maxAlternatives = 3;

  rec.onresult = (e) => {
    const heard = Array.from(e.results[0]).map((alt) => alt.transcript);
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const want = norm(target);
    const hit = heard.some((h) => norm(h) === want);
    const score = Math.max(...heard.map((h) => similarity(norm(h), want)));
    onResult({ ok: hit || score >= 0.8, heard: heard[0] || '', score });
  };
  rec.onerror = (e) => onResult({ ok: false, heard: '', score: 0, error: e.error });

  try { rec.start(); } catch { return null; }
  return rec;
}

/** Similitud por palabras compartidas — suficiente para dar retroalimentación. */
function similarity(a, b) {
  if (!a || !b) return 0;
  const wa = a.split(' ');
  const wb = b.split(' ');
  let hits = 0;
  const pool = [...wb];
  for (const w of wa) {
    const i = pool.indexOf(w);
    if (i !== -1) { hits++; pool.splice(i, 1); }
  }
  return hits / Math.max(wa.length, wb.length);
}
