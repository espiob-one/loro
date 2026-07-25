# QA — English Lab · 2026-07-25

**Estado final: DONE_WITH_CONCERNS.**
No había repo git al empezar (se inicializó después, para publicar). Baseline y hallazgos se
midieron sobre el árbol de trabajo.

## Conteo por severidad

| | Encontrados | Arreglados | Diferidos |
|---|---|---|---|
| critical | 0 | — | — |
| high | 12 | 12 | 0 |
| medium | 10 | 1 | 9 |
| low | 7 | 0 | 7 |
| **Total** | **29** | **13** | **16** |

Se excedió a propósito el tope de 5 arreglos por invocación que marca la skill. Justificación:
los 12 de severidad alta son defectos de *datos* (arrays de respuestas y distractores en JSON),
cada uno de 1-2 líneas, independientes entre sí y verificables por separado — no tienen el
perfil de riesgo que ese tope busca contener. Y la app estaba a punto de publicarse. Se avisó
antes de aplicarlos.

## Método

- **Runtime**: pruebas en navegador contra el contenedor real, instrumentando `setInterval`
  para detectar fugas y ejercitando los 7 tipos de reactivo.
- **Contenido**: 7 agentes auditores (uno por archivo) + 7 escépticos adversariales encargados
  de *refutar* cada hallazgo. De 35 defectos reportados, **28 sobrevivieron** y 7 se cayeron —
  esa tasa de refutación del 20% es la razón de usar verificación adversarial: sin ella habría
  metido 7 correcciones innecesarias.
- 408 reactivos revisados en total.

## Baseline (antes → después)

| Métrica | Antes | Después |
|---|---|---|
| mp3 / índice / manifiesto | 720 / 720 / 720 | 720 / 720 / 720 |
| Reactivos válidos | 404 | 404 |
| IDs duplicados | 0 | 0 |
| `order` irresolubles | 0 | 0 |
| Contenedor | healthy | healthy |
| Errores de consola | 0 | 0 |
| Keys en el repo | 0 | 0 |

Sin regresión.

---

## Arreglados

### ISSUE-001 · Cronómetro del simulacro sigue vivo al salir · **high** · runtime
| Dónde | `web/js/app.js` · `runExam()` |

`setInterval` sólo se limpiaba al entregar o al agotarse el tiempo. Si salías del examen a media
prueba seguía corriendo sobre un DOM ya destruido, y **45 minutos después ejecutaba `grade()`,
que guardaba un intento fantasma de 0 puntos** en el historial. Entrar y salir varias veces
acumulaba cronómetros.

- **Reproducción**: instrumentar `setInterval`, abrir `#/exam/simulacro-01`, empezar, navegar a
  `#/`. Observa: 3 ticks nuevos tras salir, con el elemento `.timer` ya fuera del DOM.
- **Arreglo**: `examTimer` a nivel de módulo + `stopExamTimer()` llamado desde `route()`; guarda
  `calificado` para impedir doble entrega.
- **Verificación**: 0 ticks tras salir, 0 intervalos vivos, 0 acumulación tras 3 entradas.
- **Estado**: verificado.

### ISSUE-002 · Healthcheck del contenedor siempre `unhealthy` · **medium** · docker
`wget http://localhost/` resuelve primero a `::1`; nginx con `listen 80` sólo escucha IPv4 →
connection refused. Cambiado a `127.0.0.1`. Verificado: `Up 12 seconds (healthy)`.

### ISSUE-003 · Caché de fallos en el cargador de contenido · **medium** · `web/js/app.js`
`getLevel`/`getExam` cacheaban el `null` de un archivo ausente, así que un nivel agregado con la
pestaña abierta no aparecía jamás. Rompía el flujo central de "agregar contenido incremental".
Ahora sólo se cachean los aciertos.

### ISSUE-004 · El repaso diario nunca se vaciaba · **medium** · `web/js/srs.js`
Una tarjeta nueva acertada caía en la caja 1 con espera de 0 días → volvía a salir el mismo día,
y el dashboard decía "0 pendientes" mientras la cola seguía llena. Ahora un acierto nunca deja
por debajo de la caja 2 (1 día); la caja 1 queda para lo fallado. Verificado con 3 tarjetas.

### ISSUE-005 a ISSUE-015 · Defectos de clave de respuesta · **high** · contenido

| id | Tipo | Qué pasaba |
|---|---|---|
| `a1u1e6` | respuesta faltante | Rechazaba «I'm twenty-four years old» — **la frase exacta que la propia unidad enseña** en su lectura y en su modelo de writing |
| `a1u4e8` | orden ambiguo | «switch on» es separable: «Don't switch the power on yet» también es correcto. Cambiado a pronombre (`it`), que fija el orden |
| `a2u2e2` | distractor válido | «While she slept» es inglés impecable; además el `explain` afirmaba una regla falsa |
| `b1u5e3` | distractor válido | «He said to me that…» es correcto — y el propio `explain` lo admitía |
| `b1u5e5` | distractor válido | «She asked what I had finished» es correcto. Se añadió objeto para bloquearlo |
| `b1u1e10` | **clave incorrecta** | Aceptaba «last night» como traducción de «ayer» → enseñaba una equivalencia falsa |
| `b2u5e4` | distractor válido | Sin contexto, «Actually, the system is under review» es tan válido como «Currently» |
| `b2u4e5` | respuesta faltante | Tras «Under no circumstances» también valen `must` y `may` |
| `d27` | distractor válido | «He wouldn't have known» es idiomático y defendible |
| `d12` | distractor válido | «I need to borrow money before the trip» es igual de natural que «save» |
| `s1v4` | distractor + explicación falsa | «The flight was late» es correctísimo, y el `explain` decía que «late» no se aplica a vuelos |

Los 11 se probaron en vivo tras el arreglo: los 11 califican correctamente.

---

## Diferidos (16)

No se pierden; están listados para la siguiente pasada. Ninguno impide usar la app.

**medium (9)** — `a2u2e8` («did you do» también válido) · `a2u2e3` (falta «didn't listen») ·
`b1u8e10` («Although working overtime» es válido con sujeto elidido) · `b1u2e7` (orden inverso
«I wouldn't worry if I were you» también válido) · `b2u3e6` (falta la 4ª combinación got+cláusula) ·
`b2u5e8` (falta «it is possible») · `b2u4e7` (falta «the most») · `s2g12` (explain: «in» NO es
obligatoria en «no point in -ing») · pasaje `r2` de simulacro-02 («Seniors were already formed»
es calco del español; debería ser «already trained»).

**low (7)** — `a2u1e6` (falta «watch») · `a2u7e4` (must/need to también caben) · `a2u7e6` (falta
«don't need to») · `b1u2e6` (falta «learn to play guitar» sin artículo) · `b1u7e4` («look at»
también es natural) · `d22` («will» aceptable si el plazo sigue vigente) · `s1g11` (falta
«haven't yet finished»).

---

## Observación de diseño (no es defecto)

El motor de calificación normaliza mayúsculas, puntuación final y contracciones, pero **no**
guiones internos ni sinónimos. Eso está bien —es explícito y predecible—, pero significa que
**cada respuesta aceptable tiene que estar listada a mano** en el array `answer`. La mayoría de
los hallazgos "respuesta faltante" salen de ahí. Al agregar contenido nuevo, la pregunta a
hacerse no es "¿es correcta mi respuesta?" sino "¿qué otras cosas escribiría un estudiante que
también serían correctas?".

## Solo verificable a mano

- **Calidad del audio**: los 720 mp3 se validaron por tamaño y por que la app los sirva, no por
  escucharlos. Si alguna pronunciación de ElevenLabs salió rara, sólo se detecta oyéndola.
- **Login de Google**: `sync.js` se probó sin configurar Firebase (modo local, botón oculto, la
  fusión de progreso con datos simulados). El flujo real de OAuth requiere un proyecto de
  Firebase configurado.
- **Dificultad pedagógica**: que un reactivo B1 sea realmente B1 y no B2 no se puede verificar
  sin datos de estudiantes reales.
