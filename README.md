# 🦜 Loro · Inglés A1 → B2 con modo EXCI

Curso interactivo de inglés, estático y sin backend. Pensado alrededor de un objetivo concreto:
**pasar los 50 puntos del EXCI que pide FIME para la titulación**, y de paso servir como
herramienta de estudio después.

Se llama Loro porque así se aprende un idioma: imitando lo que oyes.

**Funciona sin cuenta, sin red y sin instalar nada.** La cuenta de Google es opcional y sólo
sirve para sincronizar entre dispositivos.

---

## Arrancar

```bash
cd /c/Users/Erick/english-app && docker compose up -d --build
```

Luego abre **http://localhost:8080**

Se eligió el puerto 8080 porque `fabric-lab` ya ocupa el 4040 y el 8888.

Para apagarlo:

```bash
docker compose down
```

---

## Por dónde empezar

1. **Diagnóstico** (`#/test`) — 30 reactivos, ~15 min. Te dice en qué nivel entrar y una
   estimación cruda de tu puntaje EXCI. Hazlo antes que nada.
2. **El nivel que te marque** — A2 y B1 son donde se juega el umbral de 50 puntos.
3. **Simulacro EXCI** — cronometrado, 5 secciones, reporte por sección para saber dónde
   estás perdiendo puntos.
4. **Repaso** (`#/cards`) — 10 minutos diarios de flashcards valen más que dos horas el sábado.

---

## Qué contiene

| | |
|---|---|
| Unidades | 24 (A1: 4 · A2: 7 · B1: 8 · B2: 5) |
| Reactivos | 324 en las unidades + 30 del diagnóstico + 74 de simulacros |
| Vocabulario | 288 palabras con IPA y ejemplo |
| Simulacros | 2, de 37 reactivos y 5 secciones cada uno |
| Tipos de reactivo | opción múltiple, huecos, ordenar, traducir, listening, comprensión, writing |

El reparto **no es parejo a propósito**: A2 y B1 concentran 15 de las 24 unidades porque ahí es
donde está el umbral de FIME. A1 es repaso rápido y B2 es margen.

---

## Honestidad sobre los simulacros

La UANL **no publica** la estructura del EXCI: ni el número de reactivos ni la duración. Su
página remite a la "Guía para el examen EXCI". Lo que sí está documentado es que son **5 secciones**
(listening, reading, gramática, vocabulario y writing) y que **FIME pide ≥50 puntos**.

Los simulacros de esta app imitan esas secciones y el estilo de los reactivos. **No son una
réplica y el puntaje no predice tu resultado real** — es simplemente tu porcentaje de aciertos.
La app lo dice en pantalla cada vez.

---

## Audio

El reproductor intenta tres cosas, en orden:

1. Un `.mp3` pregenerado con ElevenLabs (si existe)
2. La voz del navegador (Web Speech API)
3. Nada — pero sin romperse

**La app funciona al 100% sin un solo mp3.** Generar audio es una mejora, no un requisito.

### Generar el audio

```bash
python tools/gen_audio.py
```

Ese comando es un **dry-run**: te dice cuántos caracteres consumiría, desglosados por prioridad,
y **no llama a la API**. Sólo genera si le pasas `--go`.

| Prioridad | Qué es | Costo real |
|---|---|---|
| 1 | Listening de simulacros y diagnóstico | ~1,300 caracteres |
| 2 | Listening de las unidades | ~1,600 caracteres |
| 3 | Vocabulario (palabra + ejemplo) | ~13,200 caracteres |
| 4 | Lecturas completas | ~15,800 caracteres |

```bash
python tools/gen_audio.py --quota                 # cuánta cuota te queda
python tools/gen_audio.py --go --priority 1       # sólo lo crítico (~1.3k caracteres)
python tools/gen_audio.py --go --limit 20000      # con techo duro de gasto
```

El script es incremental por hash: correrlo dos veces no regenera nada, así que no re-gastas
créditos al editar contenido. Y es reanudable — guarda el manifiesto después de cada archivo,
así que si se corta a la mitad, lo generado queda.

### Qué cuenta usa

```bash
python tools/gen_audio.py --keys        # qué notas de key hay y cuánta cuota tiene cada una
```

Busca la key en este orden: `--api-key` → `--key-note <texto>` → variable `ELEVENLABS_API_KEY`
→ notas `.md` en `Documents\Claude-Brain\APIs\`. **Entre las notas del vault prefiere la que NO
diga «trabajo»**, para que el material de estudio personal no se coma la cuota de la chamba.
Nunca imprime la key completa, sólo los últimos 4 caracteres.

Si tienes varias cuentas, fuerza una con `--key-note trabajo`.

### Dónde viven los mp3

**No están en el repo.** Son 32 MB y meterlos en git los dejaría en el historial para siempre.
Se sirven desde **Firebase Storage**, el mismo proyecto que usa el login.

```bash
# 1. Consola de Firebase -> Storage -> subir la carpeta web/audio/
# 2. Storage -> Reglas -> pegar storage.rules -> Publicar (lectura pública)
# 3. Reapuntar el índice al bucket:
python tools/gen_audio.py \
  --base-url "https://firebasestorage.googleapis.com/v0/b/TU-BUCKET.appspot.com/o/audio%2F" \
  --base-suffix "?alt=media"
```

La URL final que arma la app es `base + archivo + suffix`. Para volver a servirlos en local,
`--base-url=` (vacío) y listo.

**Si el bucket no responde, o no lo has configurado, no pasa nada**: el reproductor cae solo a
la voz del navegador. Por eso la app se puede publicar antes de tener el audio arriba.

### Estado actual del audio

**Todo generado.** 720 clips, 32 MB, voz *George* británica. Cobertura **738/738 (100%)**:
no queda un solo texto sonando con voz sintética.

| | |
|---|---|
| Listening de simulacros y diagnóstico | 19/19 |
| Listening de las unidades | 24/24 |
| Vocabulario (palabra + ejemplo) | 576/576 |
| Ejemplos de gramática | 95/95 |
| Lecturas completas | 24/24 |

El fallback a Web Speech sigue activo por si agregas contenido nuevo: lo que no tenga mp3 suena
con la voz del navegador hasta que vuelvas a correr el generador.

---

## Tu progreso

Vive en **IndexedDB de este navegador**, no en el contenedor. Eso significa:

- `docker compose down` **no** borra tu avance.
- **"Limpiar datos de navegación" SÍ lo borra**, sin preguntar y sin vuelta atrás.

Por eso hay un botón de **Exportar** en Progreso → Respaldo. Úsalo de vez en cuando; son tres
segundos y ahí viven semanas de estudio.

---

## Cuenta de Google (opcional)

La app funciona **completa sin cuenta**. Iniciar sesión sirve para una sola cosa: seguir donde
te quedaste desde otro dispositivo. Sin `firebase-config.json` válido, el botón ni siquiera
aparece.

### Configurarlo

1. Crea un proyecto en [console.firebase.google.com](https://console.firebase.google.com).
2. **Authentication → Sign-in method → Google → Habilitar.**
3. **Firestore Database → Crear base de datos** (modo producción).
4. **Reglas → pega el contenido de [`firestore.rules`](firestore.rules) → Publicar.**
   Esto no es opcional: es lo único que impide que un usuario lea el progreso de otro.
5. **Configuración del proyecto → Tus apps → Web (`</>`)** → copia el objeto `firebaseConfig`
   y pégalo en [`web/firebase-config.json`](web/firebase-config.json).
6. **Authentication → Settings → Authorized domains** → agrega tu dominio de Pages
   (`TU-USUARIO.github.io`). `localhost` ya viene autorizado.

### Cómo sincroniza

Al entrar, baja el progreso remoto, lo **fusiona** con el local y vuelve a subir el resultado.
No es "el último gana": se queda con lo más avanzado de cada lado — mejor porcentaje por unidad,
caja más alta por flashcard, todos los intentos de examen, XP máximo. Practicar en el teléfono y
luego abrir la laptop no borra nada. Después, sube solo con 4 s de rebote tras cada cambio.

La `apiKey` de Firebase **no es un secreto**: es un identificador público y por eso va en el
repo. Lo que protege los datos son las reglas de Firestore.

---

## Publicar en GitHub Pages

La app es 100% estática y **no usa una sola ruta absoluta**, así que funciona tal cual bajo un
subpath tipo `usuario.github.io/english-lab/`. No hace falta build, ni Docker, ni cambiar código.

```bash
git init && git add -A && git commit -m "English Lab"
gh repo create english-lab --public --source=. --push
```

Luego: **Settings → Pages → Source: Deploy from a branch → `main` / `/docs` o la raíz**, según
dónde dejes los archivos. El contenido servible es todo lo que está en `web/`.

### Antes de publicar, decide dos cosas

1. **Los ~32 MB de audio de ElevenLabs.** Redistribuirlos públicamente es una cuestión de
   licencia. Revisa los términos de tu plan antes de subirlos. Si no procede, borra
   `web/audio/` y la app cae sola a la voz del navegador sin romperse.
2. **Si activas cuentas, manejas datos de otras personas.** Firestore guardará el correo y el
   progreso de quien entre. Para compartirla con compañeros es manejable, pero ya no es
   "una app en mi Docker".

---

## Agregar contenido

No hace falta tocar código. La app lee `web/data/manifest.json` para saber qué existe, y si un
archivo listado no está en disco, simplemente lo omite.

1. Crea el JSON del nivel en `web/data/`.
2. Añade su entrada en `manifest.json`.
3. Refresca el navegador.

Como `docker-compose.yml` monta `./web` dentro del contenedor, **no hay que reconstruir la imagen**
para cambiar contenido: editas y recargas.

### Estructura de una unidad

```jsonc
{
  "id": "b1u9",
  "title": "...",            // en inglés
  "titleEs": "...",          // en español
  "goal": "...",             // qué vas a poder hacer al terminar
  "grammar": {
    "title": "...",
    "explanation": "...",    // en español; los párrafos se separan con \n\n
    "table": [["encabezado","..."], ["fila","..."]],
    "examples": [{ "en": "...", "es": "..." }],
    "warning": "..."         // el error típico que hay que evitar
  },
  "vocab":   [{ "en": "...", "es": "...", "ipa": "...", "example": "..." }],
  "reading": { "title": "...", "text": "...", "questions": [ /* reactivos */ ] },
  "exercises": [ /* reactivos */ ],
  "writing": { "q": "...", "minWords": 90, "mustUse": [], "rubric": [], "model": "..." }
}
```

### Los 7 tipos de reactivo

```jsonc
{ "type": "choice",    "q": "She ___ a nurse.", "options": ["is","are"], "answer": 0, "explain": "..." }
{ "type": "gap",       "q": "___ you finish?",  "answer": ["did"], "explain": "..." }
{ "type": "order",     "words": ["are","How","you"], "answer": "How are you", "explain": "..." }
{ "type": "translate", "q": "Soy de México.",   "answer": ["I am from Mexico","I'm from Mexico"], "explain": "..." }
{ "type": "listen",    "audio": "texto a leer", "options": [...], "answer": 0, "explain": "..." }
{ "type": "readingQ",  "passageRef": "p1",      "options": [...], "answer": 0, "explain": "..." }
{ "type": "writing",   "rubric": [...], "model": "..." }
```

Notas que ahorran dolores de cabeza:

- **`order`**: las palabras de `answer` tienen que ser exactamente las mismas de `words`, o el
  ejercicio queda irresoluble. Hay un validador al final de este README.
- **`translate`** y **`gap`**: `answer` es una **lista** de respuestas aceptadas. La calificación
  ya normaliza mayúsculas, puntuación y contracciones (`I'm` = `I am`, `he's` = `he is` o
  `he has`), así que no hace falta listar esas variantes — sólo las que cambian de palabra.
- **`explain`** aparece después de contestar, acierte o no. Es donde de verdad se aprende:
  vale la pena explicar *por qué* las otras opciones están mal.

---

## Verificar que todo sigue bien

Pega esto en la consola del navegador (F12) para validar el banco completo:

```js
(async () => {
  const errs = [], ids = new Set();
  for (const f of ['a1','a2','b1','b2']) {
    const j = await (await fetch(`/data/${f}.json`)).json();
    for (const u of j.units) for (const it of [...(u.reading?.questions||[]), ...(u.exercises||[])]) {
      if (ids.has(it.id)) errs.push(`id duplicado: ${it.id}`); else ids.add(it.id);
      if (Array.isArray(it.options) && (it.answer < 0 || it.answer >= it.options.length))
        errs.push(`${it.id}: answer fuera de rango`);
      if (it.type === 'order' && [...it.words].sort().join('|') !== it.answer.split(' ').sort().join('|'))
        errs.push(`${it.id}: order irresoluble`);
    }
  }
  return errs.length ? errs : `OK — ${ids.size} reactivos validados`;
})()
```

---

## Estructura del proyecto

```
english-app/
├── docker-compose.yml     puerto 8080, monta ./web para editar en caliente
├── Dockerfile             nginx:1.27-alpine + healthcheck
├── nginx.conf             gzip, sin caché para json/js
├── tools/
│   ├── gen_audio.py       generador ElevenLabs (incremental, reanudable)
│   └── audio-manifest.json
└── web/
    ├── index.html
    ├── css/styles.css
    ├── js/
    │   ├── app.js         router y vistas
    │   ├── store.js       IndexedDB, XP, racha, exportar/importar
    │   ├── exercises.js   render y calificación de los 7 tipos
    │   ├── audio.js       mp3 → fallback Web Speech
    │   └── srs.js         Leitner de 5 cajas
    ├── data/              manifest, diagnóstico, niveles, simulacros
    └── audio/             generado, nunca a mano
```

Sin build step, sin `node_modules`, sin framework. Se abre y se lee.
