/* ==========================================================================
   srs.js — repetición espaciada (Leitner de 5 cajas).

   Sencillo a propósito. SM-2 y compañía calculan intervalos más finos, pero
   para un banco de ~300 palabras y unas semanas de estudio la diferencia es
   ruido, y Leitner se puede explicar en una línea: si aciertas subes de caja
   y tardas más en volver a verla; si fallas regresas a la caja 1.
   ========================================================================== */

import { get, save, today, addDays } from './store.js';

// Días de espera por caja. La caja 1 vuelve hoy mismo.
const INTERVALS = [0, 1, 3, 7, 16];
const NEW_PER_DAY = 15;

export const cardId = (unitId, en) => `${unitId}::${en}`;

/**
 * Construye el mazo del día a partir del vocabulario disponible.
 * `allVocab` = [{ unitId, unitTitle, level, en, es, ipa, example }]
 */
export function buildQueue(allVocab) {
  const srs = get().srs;
  const t = today();

  const due = [];
  const fresh = [];

  for (const v of allVocab) {
    const id = cardId(v.unitId, v.en);
    const card = srs[id];
    if (!card) {
      fresh.push({ ...v, id, box: 0, isNew: true });
    } else if (card.due <= t) {
      due.push({ ...v, id, box: card.box, isNew: false });
    }
  }

  // Lo pendiente va primero: repasar sostiene el vocabulario que ya costó
  // trabajo; las palabras nuevas pueden esperar a mañana.
  due.sort((a, b) => a.box - b.box);
  return [...due, ...fresh.slice(0, NEW_PER_DAY)];
}

/** Cuántas tarjetas tocan hoy, sin construir el mazo completo. */
export function dueCount(allVocab) {
  return buildQueue(allVocab).length;
}

/** Registra la respuesta y reprograma la tarjeta. */
export function answer(card, ok) {
  const srs = get().srs;
  const prev = srs[card.id] || { box: 0, seen: 0, ok: 0 };

  // Un acierto nunca deja la tarjeta en la caja 1: el mínimo es la caja 2, que
  // espera un día. Si no, una tarjeta nueva contestada bien volvería a salir en
  // la misma sesión y el repaso del día nunca se vaciaría.
  // La caja 1 (mismo día) queda reservada para lo que fallaste, que es
  // exactamente lo que sí conviene volver a ver hoy.
  const box = ok ? Math.min(Math.max(prev.box + 1, 2), INTERVALS.length) : 1;
  const wait = INTERVALS[box - 1];

  srs[card.id] = {
    box,
    due: addDays(today(), wait),
    seen: prev.seen + 1,
    ok: prev.ok + (ok ? 1 : 0),
    en: card.en,
    es: card.es,
    ipa: card.ipa || '',
    example: card.example || '',
    unit: card.unitId,
    level: card.level || ''
  };
  save();
  return srs[card.id];
}

/** Resumen para la pantalla de progreso. */
export function stats() {
  const srs = get().srs;
  const ids = Object.keys(srs);
  const boxes = [0, 0, 0, 0, 0];
  let seen = 0;
  let ok = 0;

  for (const id of ids) {
    const c = srs[id];
    const i = Math.min(Math.max(c.box, 1), 5) - 1;
    boxes[i]++;
    seen += c.seen || 0;
    ok += c.ok || 0;
  }

  return {
    total: ids.length,
    boxes,
    mastered: boxes[4],
    accuracy: seen ? ok / seen : 0,
    reviews: seen
  };
}

/** Palabras que más se te resisten — las que más veces has fallado. */
export function hardest(limit = 8) {
  const srs = get().srs;
  return Object.values(srs)
    .filter((c) => (c.seen || 0) >= 2)
    .map((c) => ({ ...c, fails: (c.seen || 0) - (c.ok || 0) }))
    .filter((c) => c.fails > 0)
    .sort((a, b) => b.fails - a.fails || a.box - b.box)
    .slice(0, limit);
}
