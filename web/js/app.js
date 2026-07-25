/* ==========================================================================
   app.js — router por hash y vistas.

   Sin framework a propósito: son 7 pantallas y cero build step. El contenido
   se descubre desde data/manifest.json, así que se pueden agregar niveles sin
   tocar este archivo.
   ========================================================================== */

import * as store from './store.js';
import * as audio from './audio.js';
import * as srs from './srs.js';
import * as sync from './sync.js';
import { renderExercise } from './exercises.js';

const app = document.getElementById('app');

const data = {
  manifest: null,
  levels: {},      // id -> objeto del nivel (o null si el archivo no existe)
  exams: {},
  diagnostic: null
};

/**
 * Cronómetro del simulacro en curso.
 * Vive fuera de runExam porque si te sales del examen a media prueba hay que
 * poder matarlo desde el router. Si no, sigue corriendo sobre un DOM que ya no
 * existe y al llegar a cero guarda un intento fantasma de 0 puntos.
 */
let examTimer = null;

function stopExamTimer() {
  if (examTimer !== null) {
    clearInterval(examTimer);
    examTimer = null;
  }
}

/* ---------- utilidades ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function loadJSON(path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // archivo ausente o JSON roto: la app sigue sin ese contenido
  }
}

function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function pct(n) { return `${Math.round(n * 100)}%`; }

/* ---------- carga de contenido ---------- */

/**
 * Cachea sólo los aciertos, nunca los fallos: si un archivo de contenido
 * aparece con la pestaña abierta (que es justo el flujo de "voy agregando
 * unidades"), se recoge al siguiente cambio de vista en vez de exigir F5.
 */
async function getLevel(id) {
  if (data.levels[id]) return data.levels[id];
  const meta = data.manifest.levels.find((l) => l.id === id);
  const loaded = meta ? await loadJSON(meta.file) : null;
  if (loaded) data.levels[id] = loaded;
  return loaded;
}

async function getExam(id) {
  if (data.exams[id]) return data.exams[id];
  const meta = data.manifest.exams.find((e) => e.id === id);
  const loaded = meta ? await loadJSON(meta.file) : null;
  if (loaded) data.exams[id] = loaded;
  return loaded;
}

/** Carga todos los niveles disponibles. Lo usan flashcards y progreso. */
async function getAllLevels() {
  const out = [];
  for (const meta of data.manifest.levels) {
    const lv = await getLevel(meta.id);
    if (lv) out.push({ meta, level: lv });
  }
  return out;
}

async function allVocab() {
  const levels = await getAllLevels();
  const out = [];
  for (const { meta, level } of levels) {
    for (const unit of level.units || []) {
      for (const v of unit.vocab || []) {
        out.push({ ...v, unitId: unit.id, unitTitle: unit.title, level: meta.cefr, levelId: meta.id });
      }
    }
  }
  return out;
}

/* ---------- cabecera ---------- */

function refreshChips() {
  const s = store.get();
  document.querySelector('#streakChip b').textContent = s.streak.count;
  document.querySelector('#xpChip b').textContent = s.xp;
}

function setActiveNav(name) {
  document.querySelectorAll('#topnav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
}

/** Avatar: la foto de Google, o la inicial si no cargó. */
function avatarNode(user, cls = '') {
  if (user?.foto) {
    const img = document.createElement('img');
    img.src = user.foto;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';   // Google bloquea la foto si mandas referer
    img.onerror = () => img.replaceWith(inicial(user, cls));
    return img;
  }
  return inicial(user, cls);
}

function inicial(user, cls) {
  const d = el('div', `avatar ${cls}`);
  d.textContent = (user?.nombre || user?.correo || '?').trim().charAt(0).toUpperCase();
  return d;
}

/** Pinta el botón de cuenta de la barra superior según el estado. */
function refreshAccountBtn() {
  const btn = document.getElementById('acctBtn');
  if (!sync.disponible()) { btn.hidden = true; return; }

  btn.hidden = false;
  btn.textContent = '';
  btn.className = 'acct-btn';
  const u = sync.getUser();
  const est = sync.getEstado();

  if (est === 'conectando') {
    btn.classList.add('syncing');
    btn.append(el('span', null, 'Conectando…'));
    btn.title = 'Cargando Firebase';
    btn.onclick = null;
    return;
  }

  if (u) {
    btn.append(avatarNode(u));
    btn.append(el('span', null, (u.nombre || u.correo || '').split(' ')[0]));
    btn.title = `${u.correo} · progreso sincronizado. Clic para ver detalles.`;
    btn.onclick = () => { location.hash = '#/stats'; };
  } else {
    btn.classList.add('out');
    btn.append(el('span', null, '↻ Sincronizar'));
    btn.title = 'Inicia sesión con Google para guardar tu progreso y usarlo en otro dispositivo';
    btn.onclick = async () => {
      const ok = await sync.entrar();
      if (!ok && sync.getError()) toast(sync.getError(), 5000);
    };
  }
}

/* ---------- router ---------- */

const routes = [
  [/^\/?$/,                      () => viewDashboard()],
  [/^\/test$/,                   () => viewDiagnostic()],
  [/^\/cards$/,                  () => viewCards()],
  [/^\/stats$/,                  () => viewStats()],
  [/^\/level\/([\w-]+)$/,        (m) => viewLevel(m[1])],
  [/^\/unit\/([\w-]+)\/([\w-]+)$/, (m) => viewUnit(m[1], m[2])],
  [/^\/exam\/([\w-]+)$/,         (m) => viewExam(m[1])]
];

async function route() {
  audio.stop();
  stopExamTimer();
  const path = location.hash.replace(/^#/, '') || '/';
  app.textContent = '';
  app.append(el('div', 'loading', 'Cargando…'));

  for (const [re, handler] of routes) {
    const m = path.match(re);
    if (m) {
      try {
        await handler(m);
      } catch (err) {
        app.textContent = '';
        app.append(el('h1', null, 'Algo se rompió'));
        app.append(el('p', 'muted', String(err && err.message ? err.message : err)));
        console.error(err);
      }
      window.scrollTo(0, 0);
      refreshChips();
      return;
    }
  }

  app.textContent = '';
  app.append(el('h1', null, 'Esa página no existe'));
  const a = el('a', 'btn btn-primary', 'Ir al inicio');
  a.href = '#/';
  app.append(a);
}

/* ==========================================================================
   Vista: Dashboard
   ========================================================================== */

async function viewDashboard() {
  setActiveNav('dash');
  const s = store.get();
  app.textContent = '';

  const head = el('div', 'page-head');
  head.append(el('h1', null, 'Loro'));
  head.append(el('p', null, sync.getUser()
    ? 'Ruta A1 → B2 con formato EXCI. Tu progreso se sincroniza con tu cuenta.'
    : 'Ruta A1 → B2 con formato EXCI. Sin cuenta, sin instalar nada, sin anuncios.'));
  app.append(head);

  // --- Diagnóstico: lo primero, siempre ---
  if (!s.diagnostic) {
    const c = el('div', 'card');
    c.style.borderColor = 'var(--accent)';
    c.append(el('h2', null, '1. Empieza por el diagnóstico'));
    c.append(el('p', 'muted', 'Son 30 reactivos, unos 15 minutos. Sin esto estarías estudiando a ciegas: no sabes en qué nivel entrar ni qué tan lejos estás de los 50 puntos que pide FIME.'));
    const b = el('a', 'btn btn-primary', 'Hacer el diagnóstico');
    b.href = '#/test';
    c.append(b);
    app.append(c);
  } else {
    const d = s.diagnostic;
    const c = el('div', 'card');
    const r = el('div', 'row-between');
    const left = el('div');
    left.append(el('div', 'faint', 'Tu nivel según el diagnóstico'));
    left.append(el('div', 'score-big', d.level));
    left.append(el('div', 'score-sub', `${d.correct}/${d.total} aciertos · estimación EXCI ~${d.estimate.score} pts · ${d.estimate.label}`));
    r.append(left);
    const again = el('a', 'btn btn-ghost btn-sm', 'Repetir');
    again.href = '#/test';
    r.append(again);
    c.append(r);
    c.append(el('p', 'faint', d.estimate.advice));
    app.append(c);
  }

  // --- Repaso del día ---
  const vocab = await allVocab();
  if (vocab.length) {
    const due = srs.dueCount(vocab);
    const c = el('a', 'card card-link');
    c.href = '#/cards';
    const r = el('div', 'row-between');
    const l = el('div');
    l.append(el('h2', null, 'Repaso de vocabulario'));
    l.append(el('div', 'muted', due
      ? `${due} tarjeta${due === 1 ? '' : 's'} te tocan hoy`
      : 'Nada pendiente hoy. Vuelve mañana o adelanta una unidad.'));
    r.append(l);
    r.append(el('span', due ? 'pill pill-warn' : 'pill pill-ok', due ? String(due) : '✓'));
    c.append(r);
    app.append(c);
  }

  // --- Niveles ---
  app.append(el('h2', 'section-head', 'Niveles'));
  const grid = el('div', 'grid grid-2');
  let anyLevel = false;

  for (const meta of data.manifest.levels) {
    const level = await getLevel(meta.id);
    if (!level) continue; // archivo aún no entregado: se omite en silencio
    anyLevel = true;

    const unitIds = (level.units || []).map((u) => u.id);
    const p = store.levelProgress(meta.id, unitIds);

    const c = el('a', 'card card-link');
    c.href = `#/level/${meta.id}`;
    const top = el('div', 'row-between');
    const t = el('div');
    const badge = el('span', 'pill', meta.cefr);
    badge.style.background = meta.color + '22';
    badge.style.color = meta.color;
    badge.style.borderColor = 'transparent';
    t.append(badge);
    t.append(el('h3', null, meta.title));
    top.append(t);
    top.append(el('span', 'faint', `${p.done}/${p.total}`));
    c.append(top);
    c.append(el('p', 'faint', meta.subtitle));
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = pct(p.pct);
    bar.append(fill);
    c.append(bar);
    grid.append(c);
  }

  if (anyLevel) {
    app.append(grid);
  } else {
    const n = el('div', 'note note-warn');
    n.innerHTML = '<strong>Todavía no hay unidades en disco.</strong> El diagnóstico y los simulacros ya funcionan. Los archivos de nivel se agregan en <code>web/data/</code> y aparecen aquí solos.';
    app.append(n);
  }

  // --- Simulacros ---
  app.append(el('h2', 'section-head', 'Simulacros EXCI'));
  let anyExam = false;
  for (const meta of data.manifest.exams) {
    const ex = await getExam(meta.id);
    if (!ex) continue;
    anyExam = true;
    const runs = store.get().exams[meta.id] || [];
    const best = runs.length ? Math.max(...runs.map((r) => r.score)) : null;

    const c = el('a', 'card card-link');
    c.href = `#/exam/${meta.id}`;
    const r = el('div', 'row-between');
    const l = el('div');
    l.append(el('h3', null, meta.title));
    l.append(el('div', 'faint', `${meta.subtitle} · ${ex.minutes} min`));
    r.append(l);
    r.append(el('span', best == null ? 'pill' : best >= 50 ? 'pill pill-ok' : 'pill pill-warn',
      best == null ? 'sin hacer' : `${best} pts`));
    c.append(r);
    app.append(c);
  }
  if (!anyExam) app.append(el('p', 'faint', 'Aún no hay simulacros en disco.'));

  const disc = el('div', 'note note-warn');
  disc.innerHTML = '<strong>Sobre los simulacros:</strong> la UANL no publica el número de reactivos ni la duración del EXCI (su página remite a la guía oficial). Estos simulacros imitan las 5 secciones y el estilo del examen, pero no son una réplica ni predicen tu puntaje real.';
  app.append(disc);
}

/* ==========================================================================
   Vista: Diagnóstico
   ========================================================================== */

async function viewDiagnostic() {
  setActiveNav('test');
  if (!data.diagnostic) data.diagnostic = await loadJSON(data.manifest.diagnostic);
  const d = data.diagnostic;

  app.textContent = '';
  if (!d) {
    app.append(el('h1', null, 'El diagnóstico no está disponible'));
    app.append(el('p', 'muted', 'Falta el archivo data/diagnostico.json.'));
    return;
  }

  const back = el('a', 'back-link', '← Inicio');
  back.href = '#/';
  app.append(back);

  const head = el('div', 'page-head');
  head.append(el('h1', null, d.title));
  head.append(el('p', null, d.subtitle));
  app.append(head);

  const intro = el('div', 'note');
  intro.textContent = d.intro;
  app.append(intro);

  const answers = new Map();
  const container = el('div');
  app.append(container);

  d.items.forEach((item, i) => {
    const node = renderExercise(item, {
      index: i + 1,
      passage: item.passageRef ? d.passages[item.passageRef] : null,
      defer: true,
      onGraded: (it, ok) => {
        answers.set(it.id, ok);
        counter.textContent = `${answers.size} de ${d.items.length} contestados`;
        submit.disabled = false;
      }
    });
    container.append(node);
  });

  const counter = el('div', 'faint center');
  counter.textContent = `0 de ${d.items.length} contestados`;

  const submit = el('button', 'btn btn-primary btn-block', 'Terminar y ver mi nivel');
  submit.type = 'button';
  submit.disabled = true;
  submit.onclick = () => {
    container.querySelectorAll('.ex').forEach((n) => n.exCtl?.reveal());
    submit.disabled = true;
    const result = scoreDiagnostic(d, answers);
    store.saveDiagnostic(result);
    store.touchStreak();
    store.addXP(30);
    app.insertBefore(diagnosticReport(d, result), container);
    window.scrollTo(0, 0);
  };

  app.append(counter, submit);
}

function scoreDiagnostic(d, answers) {
  const byLevel = {};
  for (const lvl of d.scoring.levelOrder) byLevel[lvl] = { ok: 0, total: 0 };

  let correct = 0;
  for (const item of d.items) {
    const lvl = item.level;
    if (!byLevel[lvl]) byLevel[lvl] = { ok: 0, total: 0 };
    byLevel[lvl].total++;
    if (answers.get(item.id)) { byLevel[lvl].ok++; correct++; }
  }

  // El piso manda: el nivel sugerido es el último que se aprueba sin romper
  // la cadena. Si truenas A2, no importa que aciertes dos de B2 por suerte.
  let level = d.scoring.levelOrder[0];
  for (const lvl of d.scoring.levelOrder) {
    const b = byLevel[lvl];
    if (b.total && b.ok / b.total >= d.scoring.passThreshold) level = lvl;
    else break;
  }

  const raw = Math.round((correct / d.items.length) * 100);
  const band = d.scoring.exciEstimate.bands.find((b) => raw <= b.max)
    || d.scoring.exciEstimate.bands.at(-1);

  return {
    level,
    correct,
    total: d.items.length,
    byLevel,
    estimate: { score: raw, label: band.label, advice: band.advice }
  };
}

function diagnosticReport(d, r) {
  const c = el('div', 'card');
  c.style.borderColor = 'var(--accent)';
  c.append(el('div', 'faint', 'Resultado'));
  c.append(el('div', 'score-big', r.level));
  c.append(el('div', 'score-sub', `${r.correct} de ${r.total} aciertos · estimación EXCI ~${r.estimate.score} pts`));

  const band = el('div', 'note');
  band.innerHTML = `<strong>${r.estimate.label}.</strong> ${r.estimate.advice}`;
  c.append(band);

  const grid = el('div', 'grid grid-3');
  for (const lvl of d.scoring.levelOrder) {
    const b = r.byLevel[lvl];
    if (!b || !b.total) continue;
    const s = el('div', 'stat');
    s.append(el('b', null, `${b.ok}/${b.total}`));
    s.append(el('span', null, lvl));
    if (b.ok / b.total < d.scoring.passThreshold) s.style.borderColor = 'var(--bad)';
    grid.append(s);
  }
  c.append(grid);

  const warn = el('p', 'faint');
  warn.textContent = d.disclaimer;
  warn.style.marginTop = '.9rem';
  c.append(warn);

  const go = el('a', 'btn btn-primary', `Empezar en ${r.level}`);
  go.href = `#/level/${r.level.toLowerCase()}`;
  c.append(go);

  c.append(el('p', 'faint', 'Abajo quedaron todas las respuestas con su explicación. Vale la pena leer las que fallaste antes de seguir.'));
  return c;
}

/* ==========================================================================
   Vista: Nivel
   ========================================================================== */

async function viewLevel(levelId) {
  setActiveNav('dash');
  const meta = data.manifest.levels.find((l) => l.id === levelId);
  const level = await getLevel(levelId);

  app.textContent = '';
  const back = el('a', 'back-link', '← Inicio');
  back.href = '#/';
  app.append(back);

  if (!level) {
    app.append(el('h1', null, 'Ese nivel todavía no está'));
    app.append(el('p', 'muted', `Falta el archivo ${meta ? meta.file : levelId}. La app funciona igual con los niveles que sí existan.`));
    return;
  }

  const head = el('div', 'page-head');
  head.append(el('h1', null, `${meta.cefr} · ${meta.title}`));
  head.append(el('p', null, meta.subtitle));
  app.append(head);

  if (level.intro) {
    const n = el('div', 'note');
    n.textContent = level.intro;
    app.append(n);
  }

  for (const [i, unit] of (level.units || []).entries()) {
    const p = store.unitProgress(unit.id);
    const c = el('a', 'card card-link');
    c.href = `#/unit/${levelId}/${unit.id}`;

    const r = el('div', 'row-between');
    const l = el('div');
    l.append(el('div', 'faint', `Unidad ${i + 1}`));
    l.append(el('h3', null, unit.title));
    l.append(el('div', 'muted', unit.titleEs));
    r.append(l);
    r.append(el('span', p?.done ? 'pill pill-ok' : 'pill',
      p?.done ? `✓ ${pct(p.best)}` : p ? `${pct(p.best)}` : 'sin hacer'));
    c.append(r);

    const tags = el('div', 'row');
    tags.style.marginTop = '.6rem';
    tags.append(el('span', 'faint', `${(unit.vocab || []).length} palabras`));
    tags.append(el('span', 'faint', `${(unit.exercises || []).length} ejercicios`));
    if (unit.grammar) tags.append(el('span', 'faint', unit.grammar.title));
    c.append(tags);

    app.append(c);
  }
}

/* ==========================================================================
   Vista: Unidad
   ========================================================================== */

async function viewUnit(levelId, unitId) {
  setActiveNav('dash');
  const meta = data.manifest.levels.find((l) => l.id === levelId);
  const level = await getLevel(levelId);
  const unit = level?.units?.find((u) => u.id === unitId);

  app.textContent = '';
  const back = el('a', 'back-link', `← ${meta ? meta.cefr : 'Volver'}`);
  back.href = `#/level/${levelId}`;
  app.append(back);

  if (!unit) {
    app.append(el('h1', null, 'Unidad no encontrada'));
    return;
  }

  const head = el('div', 'page-head');
  head.append(el('h1', null, unit.title));
  head.append(el('p', null, unit.titleEs));
  app.append(head);

  if (unit.goal) {
    const n = el('div', 'note');
    n.innerHTML = `<strong>Al terminar vas a poder:</strong> ${unit.goal}`;
    app.append(n);
  }

  // --- Gramática ---
  if (unit.grammar) {
    app.append(el('h2', 'section-head', 'Gramática'));
    const c = el('div', 'card');
    c.append(el('h3', null, unit.grammar.title));
    for (const para of String(unit.grammar.explanation || '').split('\n\n')) {
      if (para.trim()) c.append(el('p', null, para.trim()));
    }
    if (unit.grammar.table?.length) {
      const t = el('table', 'gr-table');
      unit.grammar.table.forEach((row, i) => {
        const tr = el('tr');
        row.forEach((cell) => tr.append(el(i === 0 ? 'th' : 'td', null, cell)));
        t.append(tr);
      });
      c.append(t);
    }
    for (const ex of unit.grammar.examples || []) {
      const p = el('div', 'ex-pair');
      const b = el('b', null, ex.en);
      p.append(b, audio.speakerIcon(ex.en), el('span', null, ex.es));
      c.append(p);
    }
    if (unit.grammar.warning) {
      const w = el('div', 'note note-warn');
      w.innerHTML = `<strong>Ojo:</strong> ${unit.grammar.warning}`;
      c.append(w);
    }
    app.append(c);
  }

  // --- Vocabulario ---
  if (unit.vocab?.length) {
    app.append(el('h2', 'section-head', `Vocabulario (${unit.vocab.length})`));
    const c = el('div', 'card');
    const t = el('table', 'vocab-table');
    for (const v of unit.vocab) {
      const tr = el('tr');
      const td1 = el('td');
      const w = el('div', 'vocab-en');
      w.append(document.createTextNode(v.en), audio.speakerIcon(v.en));
      td1.append(w);
      if (v.ipa) td1.append(el('div', 'vocab-ipa', v.ipa));
      const td2 = el('td');
      td2.append(el('div', null, v.es));
      if (v.example) {
        const e = el('div', 'vocab-ex');
        e.append(document.createTextNode(v.example), audio.speakerIcon(v.example));
        td2.append(e);
      }
      tr.append(td1, td2);
      t.append(tr);
    }
    c.append(t);
    app.append(c);
  }

  // --- Lectura ---
  if (unit.reading) {
    app.append(el('h2', 'section-head', 'Lectura'));
    const c = el('div', 'card');
    if (unit.reading.title) c.append(el('h3', null, unit.reading.title));
    c.append(el('div', 'passage', unit.reading.text));
    c.append(audio.audioButton(unit.reading.text, 'Escuchar la lectura'));
    app.append(c);
  }

  // --- Ejercicios ---
  const items = [
    ...(unit.reading?.questions || []),
    ...(unit.exercises || []),
    ...(unit.writing ? [{ ...unit.writing, type: 'writing', id: `${unit.id}-writing` }] : [])
  ];

  app.append(el('h2', 'section-head', `Ejercicios (${items.length})`));

  let done = 0;
  let ok = 0;
  const totalGradable = items.length;

  const progressBar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = '0%';
  progressBar.append(fill);
  const progressText = el('div', 'faint center');
  progressText.textContent = `0 de ${totalGradable}`;
  app.append(progressBar, progressText);

  const container = el('div');
  app.append(container);

  items.forEach((item, i) => {
    container.append(renderExercise(item, {
      index: i + 1,
      onGraded: (it, correct) => {
        done++;
        if (correct) ok++;
        fill.style.width = pct(done / totalGradable);
        progressText.textContent = `${done} de ${totalGradable} · ${ok} correctos`;

        if (it.type === 'writing' && it._writingText) {
          store.saveWriting(unit.id, it._writingText, it._writingScore);
        }

        if (done === totalGradable) finishUnit();
      }
    }));
  });

  function finishUnit() {
    const ratio = ok / totalGradable;
    const rec = store.completeUnit(unit.id, ratio);
    const grew = store.touchStreak();
    store.addXP(Math.round(ratio * 50) + 10);
    refreshChips();

    const c = el('div', 'card');
    c.style.borderColor = ratio >= 0.7 ? 'var(--ok)' : 'var(--warn)';
    c.append(el('h2', null, ratio >= 0.7 ? 'Unidad completada' : 'Unidad terminada'));
    c.append(el('div', 'score-big', pct(ratio)));
    c.append(el('div', 'score-sub', `${ok} de ${totalGradable} correctos${rec.attempts > 1 ? ` · intento ${rec.attempts}` : ''}`));
    c.append(el('p', 'muted', ratio >= 0.7
      ? 'Queda marcada como hecha. Las palabras de esta unidad ya entraron a tu repaso.'
      : 'Por debajo de 70% no se marca como dominada. Vale más repetirla mañana que seguirte de largo.'));
    if (grew) c.append(el('p', 'faint', `🔥 Racha: ${store.get().streak.count} día(s).`));

    const row = el('div', 'row');
    const again = el('button', 'btn', 'Repetir la unidad');
    again.onclick = () => route();
    const next = el('a', 'btn btn-primary', 'Volver al nivel');
    next.href = `#/level/${levelId}`;
    const cards = el('a', 'btn btn-ghost', 'Repasar vocabulario');
    cards.href = '#/cards';
    row.append(next, again, cards);
    c.append(row);

    app.append(c);
    c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/* ==========================================================================
   Vista: Flashcards
   ========================================================================== */

async function viewCards() {
  setActiveNav('cards');
  const vocab = await allVocab();

  app.textContent = '';
  const head = el('div', 'page-head');
  head.append(el('h1', null, 'Repaso de vocabulario'));
  head.append(el('p', null, 'Repetición espaciada: lo que fallas vuelve pronto, lo que dominas se espacia.'));
  app.append(head);

  if (!vocab.length) {
    app.append(el('div', 'note', 'Todavía no hay vocabulario en disco. En cuanto existan unidades, sus palabras aparecen aquí solas.'));
    return;
  }

  let queue = srs.buildQueue(vocab);

  if (!queue.length) {
    const c = el('div', 'card center');
    c.append(el('h2', null, '✓ Nada pendiente hoy'));
    c.append(el('p', 'muted', 'Ya repasaste todo lo que tocaba. Adelanta una unidad nueva y mañana habrá más.'));
    const b = el('a', 'btn btn-primary', 'Ir a los niveles');
    b.href = '#/';
    c.append(b);
    app.append(c);
    return;
  }

  const total = queue.length;
  let i = 0;
  let hits = 0;

  const bar = el('div', 'bar');
  const fill = el('i');
  bar.append(fill);
  const counter = el('div', 'faint center');
  app.append(bar, counter);

  const cardBox = el('div', 'card flash');
  app.append(cardBox);

  const controls = el('div', 'row');
  controls.style.justifyContent = 'center';
  app.append(controls);

  function draw() {
    if (i >= total) return finish();

    const card = queue[i];
    fill.style.width = pct(i / total);
    counter.textContent = `${i + 1} de ${total} · ${card.level} · ${card.unitTitle}${card.isNew ? ' · nueva' : ''}`;

    cardBox.textContent = '';
    controls.textContent = '';

    const front = el('div');
    front.append(el('div', 'flash-front', card.en));
    if (card.ipa) front.append(el('div', 'vocab-ipa', card.ipa));
    front.append(el('div', 'flash-hint', 'Toca la tarjeta para ver la traducción'));
    cardBox.append(front);
    cardBox.onclick = flip;

    if (store.settings().autoplay) audio.play(card.en);

    function flip() {
      cardBox.onclick = null;
      cardBox.textContent = '';
      const b = el('div');
      b.append(el('div', 'flash-front', card.en));
      b.append(el('div', 'flash-back', card.es));
      if (card.example) b.append(el('div', 'vocab-ex', card.example));
      const spk = el('button', 'btn btn-sm btn-ghost', '🔊 Escuchar');
      spk.onclick = (e) => { e.stopPropagation(); audio.play(card.example || card.en); };
      b.append(spk);
      cardBox.append(b);

      const bad = el('button', 'btn', '✗ No la sabía');
      bad.onclick = () => grade(false);
      const good = el('button', 'btn btn-primary', '✓ La sabía');
      good.onclick = () => grade(true);
      controls.append(bad, good);
    }

    function grade(ok) {
      srs.answer(card, ok);
      if (ok) hits++;
      i++;
      draw();
    }
  }

  function finish() {
    fill.style.width = '100%';
    counter.textContent = '';
    cardBox.textContent = '';
    controls.textContent = '';
    cardBox.style.cursor = 'default';

    store.touchStreak();
    store.addXP(total * 2);
    refreshChips();

    const d = el('div');
    d.append(el('div', 'score-big', `${hits}/${total}`));
    d.append(el('div', 'score-sub', 'tarjetas acertadas'));
    d.append(el('p', 'muted', hits / total >= 0.8
      ? 'Muy bien. Las que acertaste se espacian; las que no, vuelven mañana.'
      : 'Las que fallaste regresan a la caja 1 y las vuelves a ver mañana. Es normal al principio.'));
    cardBox.append(d);

    const home = el('a', 'btn btn-primary', 'Inicio');
    home.href = '#/';
    controls.append(home);
  }

  draw();
}

/* ==========================================================================
   Vista: Simulacro EXCI
   ========================================================================== */

async function viewExam(examId) {
  setActiveNav('dash');
  const exam = await getExam(examId);

  app.textContent = '';
  const back = el('a', 'back-link', '← Inicio');
  back.href = '#/';
  app.append(back);

  if (!exam) {
    app.append(el('h1', null, 'Ese simulacro no está disponible'));
    return;
  }

  const head = el('div', 'page-head');
  head.append(el('h1', null, exam.title));
  head.append(el('p', null, `${exam.minutes} minutos · ${exam.sections.reduce((n, s) => n + s.items.length, 0)} reactivos`));
  app.append(head);

  const disc = el('div', 'note note-warn');
  disc.innerHTML = `<strong>Esto es una aproximación, no el EXCI.</strong> ${exam.disclaimer || 'La UANL no publica la estructura exacta del examen. Las secciones y el estilo imitan lo que sí se sabe; el número de reactivos y la duración son una estimación.'}`;
  app.append(disc);

  const startBtn = el('button', 'btn btn-primary btn-block', `Empezar (${exam.minutes} min)`);
  startBtn.onclick = () => runExam(exam);
  app.append(startBtn);

  const runs = store.get().exams[examId] || [];
  if (runs.length) {
    app.append(el('h2', 'section-head', 'Intentos anteriores'));
    for (const r of runs.slice().reverse()) {
      const c = el('div', 'card');
      const row = el('div', 'row-between');
      row.append(el('div', null, new Date(r.ts).toLocaleString('es-MX')));
      row.append(el('span', r.score >= 50 ? 'pill pill-ok' : 'pill pill-warn', `${r.score} pts`));
      c.append(row);
      c.append(el('div', 'faint', r.sections.map((s) => `${s.title}: ${s.ok}/${s.total}`).join(' · ')));
      app.append(c);
    }
  }
}

function runExam(exam) {
  app.textContent = '';

  const bar = el('div', 'exam-bar');
  const timer = el('span', 'timer');
  const progress = el('span', 'faint');
  const submit = el('button', 'btn btn-sm btn-primary', 'Entregar');
  bar.append(el('span', null, '⏱'), timer, el('span', 'spacer'), progress, submit);
  app.append(bar);

  const nodes = [];
  let answered = 0;
  const totalItems = exam.sections.reduce((n, s) => n + s.items.length, 0);

  const updateProgress = () => { progress.textContent = `${answered}/${totalItems}`; };
  updateProgress();

  for (const section of exam.sections) {
    const h = el('h2', 'section-head', section.title);
    app.append(h);
    if (section.instructions) app.append(el('p', 'faint', section.instructions));

    section.items.forEach((item, i) => {
      const node = renderExercise(item, {
        index: i + 1,
        defer: true,
        passage: item.passageRef ? exam.passages?.[item.passageRef] : null,
        onGraded: () => { answered++; updateProgress(); }
      });
      node._section = section;
      nodes.push(node);
      app.append(node);
    });
  }

  // --- cronómetro ---
  let left = exam.minutes * 60;
  const tick = () => {
    const m = String(Math.floor(left / 60)).padStart(2, '0');
    const s = String(left % 60).padStart(2, '0');
    timer.textContent = `${m}:${s}`;
    timer.classList.toggle('low', left <= 300);
    if (left <= 0) { stopExamTimer(); grade(true); return; }
    left--;
  };
  tick();
  stopExamTimer();                       // por si quedaba uno de un intento anterior
  examTimer = setInterval(tick, 1000);

  submit.onclick = () => {
    if (answered < totalItems && !confirm(`Te faltan ${totalItems - answered} reactivos. ¿Entregar de todos modos?`)) return;
    stopExamTimer();
    grade(false);
  };

  let calificado = false;
  function grade(byTimeout) {
    if (calificado) return;              // ni doble entrega ni entrega + timeout
    calificado = true;
    stopExamTimer();
    submit.disabled = true;
    nodes.forEach((n) => n.exCtl?.reveal());

    const bySection = exam.sections.map((s) => {
      const mine = nodes.filter((n) => n._section === s);
      return { title: s.title, ok: mine.filter((n) => n.exCtl?.ok).length, total: mine.length };
    });

    const ok = bySection.reduce((n, s) => n + s.ok, 0);
    const score = Math.round((ok / totalItems) * 100);
    const seconds = exam.minutes * 60 - left;

    store.saveExam(exam.id, { score, ok, total: totalItems, sections: bySection, seconds });
    store.touchStreak();
    store.addXP(40);
    refreshChips();

    const c = el('div', 'card');
    c.style.borderColor = score >= 50 ? 'var(--ok)' : 'var(--bad)';
    if (byTimeout) c.append(el('div', 'pill pill-warn', 'Se acabó el tiempo'));
    c.append(el('div', 'faint', 'Puntaje estimado'));
    c.append(el('div', 'score-big', String(score)));
    c.append(el('div', 'score-sub', `${ok} de ${totalItems} correctos · umbral FIME: 50`));

    const grid = el('div', 'grid grid-3');
    for (const s of bySection) {
      const st = el('div', 'stat');
      st.append(el('b', null, `${s.ok}/${s.total}`));
      st.append(el('span', null, s.title));
      if (s.total && s.ok / s.total < 0.5) st.style.borderColor = 'var(--bad)';
      grid.append(st);
    }
    c.append(grid);

    const weakest = bySection.filter((s) => s.total).sort((a, b) => (a.ok / a.total) - (b.ok / b.total))[0];
    const n = el('div', 'note');
    n.innerHTML = score >= 50
      ? `<strong>Arriba del umbral.</strong> Tu sección más débil es <strong>${weakest.title}</strong> — ahí es donde puedes perder los puntos que te sobran hoy.`
      : `<strong>Por debajo de 50.</strong> Empieza por <strong>${weakest.title}</strong>: es donde más puntos hay en juego ahora mismo.`;
    c.append(n);

    c.append(el('p', 'faint', 'Recuerda que este puntaje es una aproximación propia, no una predicción del EXCI. Abajo quedaron todos los reactivos con su explicación.'));

    const home = el('a', 'btn btn-primary', 'Inicio');
    home.href = '#/';
    c.append(home);

    app.insertBefore(c, app.children[1]);
    window.scrollTo(0, 0);
  }
}

/* ==========================================================================
   Vista: Progreso
   ========================================================================== */

async function viewStats() {
  setActiveNav('stats');
  const s = store.get();
  const vocab = await allVocab();
  const st = srs.stats();

  app.textContent = '';
  app.append(el('h1', null, 'Progreso'));

  const grid = el('div', 'grid grid-3');
  const stats = [
    [s.xp, 'XP'],
    [s.streak.count, 'días de racha'],
    [Object.values(s.units).filter((u) => u.done).length, 'unidades'],
    [st.total, 'palabras vistas'],
    [st.mastered, 'dominadas'],
    [st.reviews ? pct(st.accuracy) : '—', 'acierto en repaso']
  ];
  for (const [v, l] of stats) {
    const c = el('div', 'stat');
    c.append(el('b', null, String(v)));
    c.append(el('span', null, l));
    grid.append(c);
  }
  app.append(grid);

  // --- Cajas de Leitner ---
  if (st.total) {
    app.append(el('h2', 'section-head', 'Vocabulario por caja'));
    const c = el('div', 'card');
    c.append(el('p', 'faint', 'Caja 1 = la vuelves a ver hoy. Caja 5 = dentro de 16 días. Subir de caja es la señal real de que se te quedó.'));
    st.boxes.forEach((n, i) => {
      const row = el('div', 'row');
      row.style.marginBottom = '.35rem';
      row.append(el('span', 'faint', `Caja ${i + 1}`));
      const b = el('div', 'bar');
      b.style.flex = '1';
      const f = el('i');
      f.style.width = pct(st.total ? n / st.total : 0);
      b.append(f);
      row.append(b, el('span', 'faint', String(n)));
      c.append(row);
    });
    app.append(c);
  }

  // --- Las que más se resisten ---
  const hard = srs.hardest();
  if (hard.length) {
    app.append(el('h2', 'section-head', 'Las que más se te resisten'));
    const c = el('div', 'card');
    const t = el('table', 'vocab-table');
    for (const h of hard) {
      const tr = el('tr');
      const td1 = el('td');
      const w = el('div', 'vocab-en');
      w.append(document.createTextNode(h.en), audio.speakerIcon(h.en));
      td1.append(w);
      const td2 = el('td');
      td2.append(el('div', null, h.es));
      td2.append(el('div', 'faint', `${h.fails} fallo${h.fails === 1 ? '' : 's'} de ${h.seen} · caja ${h.box}`));
      tr.append(td1, td2);
      t.append(tr);
    }
    c.append(t);
    app.append(c);
  }

  // --- Ajustes ---
  app.append(el('h2', 'section-head', 'Ajustes'));
  const set = el('div', 'card');

  const voiceRow = el('div', 'row-between');
  voiceRow.append(el('div', null, 'Acento del audio'));
  const voiceSel = el('select', 'input');
  voiceSel.style.width = 'auto';
  for (const [v, label] of [['uk', 'Británico (UK)'], ['us', 'Americano (US)']]) {
    const o = el('option', null, label);
    o.value = v;
    if (s.settings.voice === v) o.selected = true;
    voiceSel.append(o);
  }
  voiceSel.onchange = () => {
    store.setSetting('voice', voiceSel.value);
    audio.play('This is how it sounds now.');
  };
  voiceRow.append(voiceSel);
  set.append(voiceRow);
  set.append(el('p', 'faint', 'El EXCI lo desarrollaron la UANL y el British Council, así que el listening probablemente sea británico. Por eso viene en UK por defecto.'));

  const autoRow = el('div', 'row-between');
  autoRow.append(el('div', null, 'Pronunciar solo al mostrar una flashcard'));
  const autoCb = el('input');
  autoCb.type = 'checkbox';
  autoCb.checked = s.settings.autoplay;
  autoCb.onchange = () => store.setSetting('autoplay', autoCb.checked);
  autoRow.append(autoCb);
  set.append(autoRow);

  const audioNote = el('p', 'faint');
  const n = audio.indexSize();
  audioNote.textContent = n
    ? `Hay ${n} audios pregenerados con ElevenLabs. El resto usa la voz del navegador.`
    : 'No hay audios pregenerados todavía: todo suena con la voz del navegador. Para generarlos, corre tools/gen_audio.py.';
  set.append(audioNote);
  app.append(set);

  // --- Cuenta ---
  if (sync.disponible()) {
    app.append(el('h2', 'section-head', 'Cuenta'));
    const acc = el('div', 'card');
    const u = sync.getUser();

    if (u) {
      const row = el('div', 'acct-card');
      row.append(avatarNode(u));
      const info = el('div');
      info.append(el('div', null, u.nombre || u.correo));
      info.append(el('div', 'faint', u.correo));
      row.append(info);
      acc.append(row);

      const ts = store.get().updatedAt;
      acc.append(el('p', 'faint', ts
        ? `Última sincronización: ${new Date(ts).toLocaleString('es-MX')}`
        : 'Aún sin sincronizar.'));

      const row2 = el('div', 'row');
      const now = el('button', 'btn btn-primary', '↻ Sincronizar ahora');
      now.onclick = async () => {
        now.disabled = true;
        now.textContent = 'Sincronizando…';
        const r = await sync.sincronizar();
        now.disabled = false;
        now.textContent = '↻ Sincronizar ahora';
        toast(r && (r.unidades || r.tarjetas || r.examenes)
          ? `Traído de la nube: ${r.unidades} unidades, ${r.tarjetas} tarjetas, ${r.examenes} exámenes.`
          : 'Todo al día.');
        refreshChips();
        route();
      };
      const out = el('button', 'btn btn-ghost', 'Cerrar sesión');
      out.onclick = async () => {
        await sync.salir();
        toast('Sesión cerrada. Tu progreso sigue en este navegador.');
        route();
      };
      row2.append(now, out);
      acc.append(row2);
      acc.append(el('p', 'faint', 'Al sincronizar se FUSIONA, nunca se sobreescribe: si practicaste en otro dispositivo, se queda lo más avanzado de cada lado.'));
    } else {
      acc.append(el('h3', null, 'Guarda tu progreso en la nube'));
      acc.append(el('p', 'muted', 'Con una cuenta de Google puedes seguir donde te quedaste desde el teléfono, la laptop o la compu de la escuela. Es opcional: sin cuenta, todo se guarda en este navegador.'));
      const b = el('button', 'btn btn-primary', 'Entrar con Google');
      b.onclick = async () => {
        const ok = await sync.entrar();
        if (!ok && sync.getError()) toast(sync.getError(), 5000);
        else route();
      };
      acc.append(b);
      if (sync.getError()) {
        const e = el('div', 'note note-warn');
        e.textContent = sync.getError();
        acc.append(e);
      }
    }
    app.append(acc);
  }

  // --- Respaldo ---
  app.append(el('h2', 'section-head', 'Respaldo'));
  const backup = el('div', 'card');
  const warn = el('div', 'note note-warn');
  warn.innerHTML = sync.getUser()
    ? '<strong>Tu progreso está sincronizado</strong>, pero el archivo exportado sigue siendo la copia que no depende de nadie. No está de más bajarlo de vez en cuando.'
    : '<strong>Tu progreso vive en este navegador.</strong> Un "limpiar datos de navegación" lo borra sin preguntar y no hay forma de recuperarlo. Exporta de vez en cuando.';
  backup.append(warn);

  const row = el('div', 'row');
  const exp = el('button', 'btn btn-primary', '⬇ Exportar progreso');
  exp.onclick = () => { store.exportProgress(); toast('Progreso descargado.'); };

  const impLabel = el('label', 'btn');
  impLabel.textContent = '⬆ Importar';
  const imp = el('input');
  imp.type = 'file';
  imp.accept = 'application/json,.json';
  imp.style.display = 'none';
  imp.onchange = async () => {
    if (!imp.files?.[0]) return;
    try {
      await store.importProgress(imp.files[0]);
      toast('Progreso restaurado.');
      refreshChips();
      route();
    } catch (e) {
      toast(e.message || 'No se pudo importar.', 4000);
    }
  };
  impLabel.append(imp);

  const reset = el('button', 'btn btn-ghost', 'Borrar todo');
  reset.onclick = () => {
    if (!confirm('Esto borra XP, racha, unidades y flashcards. No se puede deshacer.\n\n¿Exportaste primero?')) return;
    store.resetAll();
    toast('Todo borrado.');
    refreshChips();
    route();
  };

  row.append(exp, impLabel, reset);
  backup.append(row);
  app.append(backup);
}

/* ==========================================================================
   Arranque
   ========================================================================== */

async function boot() {
  await store.init();
  await audio.init();

  data.manifest = await loadJSON('data/manifest.json');
  if (!data.manifest) {
    app.textContent = '';
    app.append(el('h1', null, 'Falta data/manifest.json'));
    app.append(el('p', 'muted', 'Sin el manifiesto la app no sabe qué contenido existe. Revisa que el archivo esté en web/data/.'));
    return;
  }
  data.manifest.levels ||= [];
  data.manifest.exams ||= [];

  document.getElementById('themeBtn').onclick = () => {
    const t = store.toggleTheme();
    toast(t === 'light' ? 'Tema claro' : 'Tema oscuro', 1200);
  };

  // La cuenta es opcional y se carga aparte: si Firebase no está configurado,
  // no hay red, o el CDN está bloqueado, esto no debe frenar el arranque.
  sync.init()
    .then(() => {
      refreshAccountBtn();
      sync.onEstado(({ estado }) => {
        refreshAccountBtn();
        refreshChips();
        // Si estás viendo Progreso, refréscalo para ver el cambio de sesión.
        if (location.hash.startsWith('#/stats')) route();
        if (estado === 'dentro') toast('Progreso sincronizado con tu cuenta.', 2200);
      });
    })
    .catch(() => { /* modo local, que es el default */ });

  refreshChips();
  window.addEventListener('hashchange', route);
  await route();
}

boot();
