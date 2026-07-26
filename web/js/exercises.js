/* ==========================================================================
   exercises.js — render y calificación de los 7 tipos de reactivo.

   Tipos: choice · gap · order · translate · listen · readingQ · writing
   Todos se autocalifican salvo `writing`, que usa rúbrica + autoevaluación
   (no hay modelo dentro del contenedor y un puntaje inventado sería peor
   que ninguno).
   ========================================================================== */

import { audioButton, canRecognize, recognize } from './audio.js';

/* ---------- normalización de respuestas de texto ---------- */

const CONTRACTIONS = {
  "i'm": 'i am', "you're": 'you are', "we're": 'we are', "they're": 'they are',
  "i've": 'i have', "you've": 'you have', "we've": 'we have', "they've": 'they have',
  "i'll": 'i will', "you'll": 'you will', "he'll": 'he will', "she'll": 'she will',
  "we'll": 'we will', "they'll": 'they will', "it'll": 'it will',
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not',
  "haven't": 'have not', "hasn't": 'has not', "hadn't": 'had not',
  "won't": 'will not', "wouldn't": 'would not', "can't": 'can not', cannot: 'can not',
  "couldn't": 'could not', "shouldn't": 'should not', "mustn't": 'must not',
  "should've": 'should have', "would've": 'would have', "could've": 'could have',
  "might've": 'might have', "must've": 'must have', "let's": 'let us'
};

/** Limpieza básica: minúsculas, comillas rectas, sin puntuación final, un espacio. */
function clean(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,!?;:]+$/g, '')
    .trim();
}

/**
 * Devuelve TODAS las formas canónicas de una frase.
 * Es un conjunto y no una cadena porque "'s" y "'d" son ambiguos:
 * "he's finished" puede ser "he is" o "he has", y las dos son inglés válido.
 * Comparamos conjunto contra conjunto en vez de adivinar.
 */
function canonSet(s) {
  let base = clean(s);

  for (const [k, v] of Object.entries(CONTRACTIONS)) {
    base = base.replace(new RegExp(`\\b${k.replace(/'/g, "'")}\\b`, 'g'), v);
  }

  let variants = [base];

  // 's  ->  is | has        'd  ->  would | had
  for (const [re, opts] of [[/\b(\w+)'s\b/g, ['is', 'has']], [/\b(\w+)'d\b/g, ['would', 'had']]]) {
    const next = [];
    for (const v of variants) {
      if (!re.test(v)) { next.push(v); re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      for (const word of opts) next.push(v.replace(re, `$1 ${word}`));
    }
    variants = next;
    if (variants.length > 8) break; // tope de seguridad
  }

  return new Set(variants.map((v) => v.replace(/\s+/g, ' ').trim()));
}

/** ¿La respuesta del usuario coincide con alguna de las aceptadas? */
export function matches(userInput, accepted) {
  const list = Array.isArray(accepted) ? accepted : [accepted];
  const mine = canonSet(userInput);
  if (!clean(userInput)) return false;
  return list.some((a) => {
    const theirs = canonSet(a);
    for (const m of mine) if (theirs.has(m)) return true;
    return false;
  });
}

/* ---------- helpers de DOM ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

const TYPE_LABEL = {
  choice: 'Opción múltiple',
  gap: 'Completa',
  order: 'Ordena',
  translate: 'Traduce',
  listen: 'Listening',
  readingQ: 'Comprensión',
  writing: 'Writing'
};

function feedback(ok, item, solution) {
  const box = el('div', `fb ${ok ? 'fb-ok' : 'fb-bad'}`);
  box.append(el('b', null, ok ? '✓ Correcto' : '✗ Incorrecto'));
  if (!ok && solution) {
    const s = el('div', 'sol');
    s.textContent = `Respuesta: ${solution}`;
    box.append(s);
  }
  if (item.explain) box.append(el('div', null, item.explain));
  return box;
}

/* ---------- render principal ---------- */

/**
 * Dibuja un reactivo. `onGraded(item, correct)` se llama UNA vez, cuando el
 * usuario contesta por primera vez (los reintentos no vuelven a puntuar).
 *
 * `defer: true` = modo examen: se registra la respuesta pero no se revela
 * nada hasta llamar a `box.exCtl.reveal()`. Sin esto un simulacro no serviría
 * de nada: verías la respuesta correcta del reactivo 3 antes de contestar el 4.
 */
export function renderExercise(item, { index = null, onGraded = () => {}, passage = null, defer = false } = {}) {
  const box = el('div', 'ex');
  box.dataset.id = item.id || '';

  // Control del reactivo: lo usa la vista de examen para calificar al final.
  const ctl = { item, answered: false, ok: false, reveal: () => {} };
  box.exCtl = ctl;

  const head = el('div', 'ex-head');
  head.append(el('span', null, index != null ? `${index}. ${TYPE_LABEL[item.type] || item.type}` : TYPE_LABEL[item.type] || item.type));
  if (item.level) head.append(el('span', 'pill', item.level));
  box.append(head);

  if (passage) {
    const p = el('div', 'passage');
    if (passage.title) p.append(el('strong', null, passage.title + '\n\n'));
    p.append(document.createTextNode(passage.text));
    box.append(p);
  }

  /**
   * Cierra el reactivo. `paint` pinta los colores de acierto/error y
   * `solution` es lo que se muestra si falló. En modo diferido las dos cosas
   * se guardan para más tarde en vez de ejecutarse.
   */
  const finish = (ok, solution, paint, silent = false) => {
    // En modo examen se puede cambiar de respuesta hasta entregar, igual que en
    // un examen de papel. Gana la última. El contador de "contestados" sólo
    // suma la primera vez, para que no se infle al corregir.
    if (ctl.answered && !defer) return;
    const primeraVez = !ctl.answered;
    ctl.answered = true;
    ctl.ok = ok;
    if (primeraVez) onGraded(item, ok);

    const show = () => {
      paint();
      // `silent` es para writing, que ya dibuja su propio veredicto de rúbrica:
      // otra caja diciendo "✓ Correcto" encima sería ruido.
      if (!silent) box.append(feedback(ok, item, solution));
    };
    if (defer) ctl.reveal = show;
    else show();
  };

  // Si el usuario deja el reactivo en blanco, al final igual hay que
  // enseñarle cuál era la respuesta.
  if (defer) {
    ctl.reveal = () => {
      ctl.answered = true;
      box.append(feedback(false, item, solutionOf(item)));
    };
  }

  switch (item.type) {
    case 'listen':   renderListen(box, item, finish, defer); break;
    case 'gap':      renderText(box, item, finish, defer); break;
    case 'translate':renderText(box, item, finish, defer); break;
    case 'order':    renderOrder(box, item, finish, defer); break;
    case 'writing':  renderWriting(box, item, finish, defer); break;
    default:         renderChoice(box, item, finish, defer); break; // choice, readingQ
  }

  return box;
}

/** Texto de la respuesta correcta, para cuando el reactivo quedó en blanco. */
function solutionOf(item) {
  if (Array.isArray(item.options) && typeof item.answer === 'number') return item.options[item.answer];
  if (Array.isArray(item.answer)) return item.answer[0];
  return item.answer ?? '';
}

/* ---------- opción múltiple (choice / readingQ) ---------- */

function renderChoice(box, item, finish, defer = false) {
  box.append(elQuestion(item));

  const opts = el('div', 'opts');
  const buttons = [];

  (item.options || []).forEach((text, i) => {
    const b = el('button', 'opt');
    b.type = 'button';
    b.append(el('span', 'opt-key', LETTERS[i] || String(i + 1)));
    b.append(el('span', null, text));
    b.onclick = () => {
      const ok = i === item.answer;
      if (defer) {
        // Modo examen: se marca la elegida y se puede cambiar hasta entregar.
        buttons.forEach((btn) => btn.classList.remove('is-sel'));
        b.classList.add('is-sel');
      } else {
        buttons.forEach((btn) => { btn.disabled = true; });
      }
      finish(ok, item.options[item.answer], () => {
        buttons.forEach((btn, j) => {
          btn.disabled = true;
          btn.classList.remove('is-sel');
          if (j === item.answer) btn.classList.add('is-ok');
          else if (j === i) btn.classList.add('is-bad');
        });
      });
    };
    buttons.push(b);
    opts.append(b);
  });

  box.append(opts);
}

function elQuestion(item) {
  const q = el('div', 'ex-q');
  // Los huecos se escriben con ___ en el JSON; los mostramos monoespaciados.
  const parts = String(item.q || '').split(/(_{2,})/g);
  parts.forEach((p) => {
    if (/^_{2,}$/.test(p)) q.append(el('code', null, '_____'));
    else q.append(document.createTextNode(p));
  });
  return q;
}

/* ---------- listening ---------- */

function renderListen(box, item, finish, defer) {
  box.append(audioButton(item.audio, 'Escuchar'));
  box.append(el('div', 'faint', defer
    ? 'En el examen real la cantidad de repeticiones puede estar limitada.'
    : 'Puedes repetirlo las veces que quieras.'));
  const gap = el('div');
  gap.style.height = '.8rem';
  box.append(gap);

  if (Array.isArray(item.options)) renderChoice(box, item, finish);
  else renderText(box, item, finish);
}

/* ---------- texto libre (gap / translate / dictado) ---------- */

function renderText(box, item, finish, defer = false) {
  box.append(elQuestion(item));

  const input = el('input', 'input');
  input.type = 'text';
  input.placeholder = item.type === 'translate' ? 'Escribe la traducción en inglés…' : 'Tu respuesta…';
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;

  const row = el('div', 'row');
  row.style.marginTop = '.6rem';
  const btn = el('button', 'btn btn-primary', defer ? 'Guardar respuesta' : 'Revisar');
  btn.type = 'button';
  const estado = el('span', 'faint');

  const check = () => {
    if (!input.value.trim()) { estado.textContent = 'Escribe algo primero.'; return; }
    const ok = matches(input.value, item.answer);
    const accepted = Array.isArray(item.answer) ? item.answer[0] : item.answer;

    if (defer) {
      // Se guarda pero NO se revela nada, y sigue editable hasta entregar.
      // Sin este aviso la pantalla parecía congelada: bloqueaba todo y no
      // mostraba nada, que era justo lo que hacía antes.
      estado.textContent = '✓ Guardada — puedes cambiarla';
      estado.style.color = 'var(--ok)';
      input.classList.add('is-saved');
    } else {
      input.disabled = true;
      btn.disabled = true;
    }

    finish(ok, accepted, () => {
      input.disabled = true;
      btn.disabled = true;
      input.classList.remove('is-saved');
      input.classList.add(ok ? 'is-ok' : 'is-bad');
      estado.textContent = '';
    });
  };

  btn.onclick = check;
  input.onkeydown = (e) => { if (e.key === 'Enter') check(); };
  // Si vuelve a escribir, el "guardada" deja de aplicar hasta que guarde otra vez.
  input.oninput = () => {
    if (!defer) return;
    estado.textContent = 'Sin guardar — dale a «Guardar respuesta»';
    estado.style.color = '';
    input.classList.remove('is-saved');
  };

  row.append(btn, estado);
  box.append(input, row);

  // Práctica de pronunciación: sólo si el navegador la soporta (T9).
  if (item.type === 'translate' && canRecognize()) {
    box.append(speakingWidget(Array.isArray(item.answer) ? item.answer[0] : item.answer));
  }
}

/* ---------- ordenar palabras ---------- */

function renderOrder(box, item, finish, defer = false) {
  box.append(elQuestion(item));

  const slot = el('div', 'order-slot');
  const tray = el('div', 'order-tray');
  const chosen = [];

  // Barajado determinista por índice: sin Math.random, para que el ejercicio
  // se vea igual si recargas a media unidad.
  const words = [...(item.words || [])];
  const shuffled = words
    .map((w, i) => ({ w, k: ((i * 7 + w.length * 13) % words.length) }))
    .sort((a, b) => a.k - b.k)
    .map((o) => o.w);

  const paint = () => {
    slot.textContent = '';
    tray.textContent = '';
    chosen.forEach((w, i) => {
      const b = el('button', 'word', w);
      b.type = 'button';
      b.onclick = () => { chosen.splice(i, 1); paint(); };
      slot.append(b);
    });
    shuffled.forEach((w, i) => {
      if (chosen.filter((c) => c === w).length > shuffled.slice(0, i + 1).filter((c) => c === w).length - 1) return;
      const b = el('button', 'word', w);
      b.type = 'button';
      b.onclick = () => { chosen.push(w); paint(); };
      tray.append(b);
    });
    btn.disabled = chosen.length !== words.length;
    // Si reordena después de guardar, el aviso deja de aplicar.
    if (estado && estado.textContent.startsWith('✓')) {
      estado.textContent = 'Sin guardar — dale a «Guardar respuesta»';
      estado.style.color = '';
    }
  };

  const btn = el('button', 'btn btn-primary', defer ? 'Guardar respuesta' : 'Revisar');
  btn.type = 'button';
  btn.disabled = true;
  const estado = el('span', 'faint');

  btn.onclick = () => {
    const ok = matches(chosen.join(' '), item.answer);

    if (defer) {
      // Sigue reordenable hasta entregar; paint() vuelve a habilitar las fichas.
      estado.textContent = '✓ Guardada — puedes reordenar';
      estado.style.color = 'var(--ok)';
      btn.disabled = true;
    } else {
      slot.querySelectorAll('.word').forEach((w) => { w.disabled = true; });
      tray.querySelectorAll('.word').forEach((w) => { w.disabled = true; });
      btn.disabled = true;
    }

    finish(ok, item.answer, () => {
      slot.querySelectorAll('.word').forEach((w) => { w.disabled = true; });
      tray.querySelectorAll('.word').forEach((w) => { w.disabled = true; });
      btn.disabled = true;
      estado.textContent = '';
      slot.classList.add(ok ? 'is-ok' : 'is-bad');
    });
  };

  const row = el('div', 'row');
  row.style.marginTop = '.6rem';
  row.append(btn, estado);

  box.append(slot, tray, row);
  paint();
}

/* ---------- writing (rúbrica + autoevaluación) ---------- */

function renderWriting(box, item, finish, defer = false) {
  box.append(elQuestion(item));

  if (item.mustUse?.length) {
    const m = el('div', 'note');
    m.innerHTML = `<strong>Tienes que usar:</strong> ${item.mustUse.map((w) => `<code>${w}</code>`).join(', ')}`;
    box.append(m);
  }

  const ta = el('textarea', 'input');
  ta.placeholder = `Escribe aquí… (mínimo ${item.minWords || 40} palabras)`;
  box.append(ta);

  const counter = el('div', 'faint');
  counter.style.marginTop = '.35rem';
  box.append(counter);

  const wordCount = () => ta.value.trim().split(/\s+/).filter(Boolean).length;

  const updateCounter = () => {
    const n = wordCount();
    const min = item.minWords || 40;
    const missing = (item.mustUse || []).filter(
      (w) => !new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(ta.value)
    );
    counter.textContent =
      `${n} palabra${n === 1 ? '' : 's'}` +
      (n < min ? ` · te faltan ${min - n}` : ' · longitud ok') +
      (missing.length ? ` · falta usar: ${missing.join(', ')}` : '');
    counter.style.color = n >= min && !missing.length ? 'var(--ok)' : '';
  };
  ta.oninput = updateCounter;
  updateCounter();

  const btn = el('button', 'btn btn-primary',
    defer ? 'Terminar redacción' : 'Ver respuesta modelo y rúbrica');
  btn.type = 'button';
  btn.style.marginTop = '.7rem';

  // En modo examen la respuesta modelo se guarda para el final: verla mientras
  // escribes convierte la sección de writing en un ejercicio de copiar.
  const showModel = () => {
    if (!item.model) return;
    const m = el('div', 'card');
    m.style.marginTop = '.8rem';
    m.append(el('h3', null, 'Respuesta modelo'));
    m.append(el('div', 'passage', item.model));
    box.append(m);
  };

  btn.onclick = () => {
    btn.disabled = true;
    ta.disabled = true;

    if (!defer) showModel();

    const r = el('div', 'card');
    r.append(el('h3', null, 'Califícate con honestidad'));
    r.append(el('p', 'faint', 'Nadie más va a leer esto. Marcar de más sólo te engaña a ti.'));
    const list = el('div', 'rubric');
    const boxes = [];

    const criteria = item.rubric?.length ? item.rubric : [
      'Contesté todo lo que pedía la consigna',
      'Usé el tiempo verbal correcto en todas las oraciones',
      'No repetí la misma estructura una y otra vez',
      'La ortografía y la puntuación están bien',
      'Alcancé la longitud mínima'
    ];

    criteria.forEach((c) => {
      const lbl = el('label', 'rubric-item');
      const cb = el('input');
      cb.type = 'checkbox';
      boxes.push(cb);
      lbl.append(cb, el('span', null, c));
      list.append(lbl);
    });
    r.append(list);

    const done = el('button', 'btn', 'Guardar autoevaluación');
    done.type = 'button';
    done.onclick = () => {
      const hits = boxes.filter((b) => b.checked).length;
      const ratio = hits / boxes.length;
      done.disabled = true;
      boxes.forEach((b) => { b.disabled = true; });
      const verdict = el('div', `fb ${ratio >= 0.6 ? 'fb-ok' : 'fb-bad'}`);
      verdict.append(el('b', null, `${hits} de ${boxes.length} criterios`));
      verdict.append(el('div', null,
        ratio >= 0.8 ? 'Sólido. Escribe otro con una consigna distinta.'
          : ratio >= 0.6 ? 'Va bien. Fíjate en los criterios que dejaste sin marcar.'
            : 'Reescríbelo mirando la respuesta modelo, frase por frase.'));
      r.append(verdict);
      item._writingText = ta.value;
      item._writingScore = ratio;
      finish(ratio >= 0.6, null, () => { if (defer) showModel(); }, true);
    };
    r.append(done);
    box.append(r);
  };

  box.append(btn);
}

/* ---------- widget de pronunciación (T9) ---------- */

function speakingWidget(target) {
  const wrap = el('div', 'row');
  wrap.style.marginTop = '.7rem';

  const btn = el('button', 'btn btn-sm btn-ghost', '🎤 Practicar en voz alta');
  btn.type = 'button';
  const out = el('span', 'faint');

  btn.onclick = () => {
    out.textContent = 'Escuchando…';
    btn.disabled = true;
    const rec = recognize(target, ({ ok, heard, score, error }) => {
      btn.disabled = false;
      if (error) {
        out.textContent = error === 'not-allowed'
          ? 'Falta permiso de micrófono.'
          : 'No se pudo escuchar (esta función necesita internet).';
        return;
      }
      out.textContent = ok
        ? `✓ Se entendió: "${heard}"`
        : `Escuché: "${heard}" (${Math.round(score * 100)}% de coincidencia)`;
      out.style.color = ok ? 'var(--ok)' : '';
    });
    if (!rec) { btn.disabled = false; out.textContent = 'No disponible en este navegador.'; }
  };

  wrap.append(btn, out);
  return wrap;
}
