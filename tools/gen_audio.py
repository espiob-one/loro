#!/usr/bin/env python3
"""
gen_audio.py — genera los audios de English Lab con ElevenLabs.

Diseñado alrededor de un hecho incómodo: la única key guardada es la de una
cuenta de TRABAJO, y el banco completo ronda las decenas de miles de
caracteres. Por eso el script:

  · nunca genera nada sin que se lo pidas explícitamente (--dry-run es el default)
  · calcula un hash por frase y sólo genera lo que falta (re-correrlo no gasta)
  · va por prioridad, así que si la cuota se acaba, se acaba en lo menos importante
  · es reanudable: guarda el manifiesto después de CADA archivo
  · acepta --limit para poner un techo duro de caracteres

Sin dependencias: sólo stdlib. Python 3.8+.

Uso típico:
    python tools/gen_audio.py                      # dry-run: qué se generaría y cuánto cuesta
    python tools/gen_audio.py --quota              # consulta cuánta cuota te queda
    python tools/gen_audio.py --list-voices        # ver voces disponibles
    python tools/gen_audio.py --go --priority 1    # generar SOLO lo más importante
    python tools/gen_audio.py --go --limit 20000   # generar con techo de 20k caracteres
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = WEB / "data"
AUDIO_DIR = WEB / "audio"
MANIFEST = Path(__file__).resolve().parent / "audio-manifest.json"
INDEX = AUDIO_DIR / "index.json"

API = "https://api.elevenlabs.io/v1"
DEFAULT_MODEL = "eleven_multilingual_v2"

# Carpeta de keys del vault de Obsidian. Se escanea entera: puede haber varias
# cuentas de ElevenLabs (trabajo / personal) y conviene poder elegir.
KEY_DIR = Path.home() / "Documents" / "Claude-Brain" / "APIs"
KEY_NOTE = KEY_DIR / "Eleven Labs trabajo.md"  # sólo para el mensaje de ayuda

PRIORITIES = {
    1: "Simulacros EXCI + diagnóstico (listening)",
    2: "Listening de las unidades",
    3: "Vocabulario (palabra + ejemplo)",
    4: "Lecturas completas",
}


# --------------------------------------------------------------------------
# Recolección de textos
# --------------------------------------------------------------------------

def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as e:
        print(f"  !! {path.name} tiene JSON inválido: {e}", file=sys.stderr)
        return None


def collect():
    """Devuelve [(prioridad, texto, origen)] sin repetir textos."""
    seen = set()
    out = []

    def add(prio, text, source):
        text = (text or "").strip()
        if not text or text in seen:
            return
        seen.add(text)
        out.append((prio, text, source))

    # --- P1: simulacros y diagnóstico ---
    diag = load(DATA / "diagnostico.json")
    if diag:
        for item in diag.get("items", []):
            if item.get("type") == "listen":
                add(1, item.get("audio"), f"diagnostico/{item.get('id')}")

    exci_dir = DATA / "exci"
    if exci_dir.is_dir():
        for f in sorted(exci_dir.glob("*.json")):
            exam = load(f)
            if not exam:
                continue
            for section in exam.get("sections", []):
                for item in section.get("items", []):
                    if item.get("type") == "listen":
                        add(1, item.get("audio"), f"{f.stem}/{item.get('id')}")

    # --- P2, P3, P4: niveles ---
    manifest = load(DATA / "manifest.json") or {}
    for meta in manifest.get("levels", []):
        level = load(WEB / meta["file"])
        if not level:
            continue
        for unit in level.get("units", []):
            uid = unit.get("id")

            for ex in unit.get("exercises", []):
                if ex.get("type") == "listen":
                    add(2, ex.get("audio"), f"{uid}/{ex.get('id')}")

            for v in unit.get("vocab", []):
                add(3, v.get("en"), f"{uid}/vocab")
                add(3, v.get("example"), f"{uid}/vocab-ex")

            for ex in unit.get("grammar", {}).get("examples", []):
                add(3, ex.get("en"), f"{uid}/grammar")

            reading = unit.get("reading") or {}
            add(4, reading.get("text"), f"{uid}/reading")

    return out


def digest(text, voice_id, model):
    raw = f"{voice_id}|{model}|{text}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

def key_notes():
    """Notas del vault que parezcan contener una key de ElevenLabs."""
    if not KEY_DIR.is_dir():
        return []
    out = []
    for f in sorted(KEY_DIR.glob("*.md")):
        if not re.search(r"(?i)eleven\s*labs?|11labs", f.name + " " + f.read_text(encoding="utf-8", errors="ignore")[:400]):
            continue
        out.append(f)
    return out


def key_from_note(path):
    """Extrae la key de una nota. Formatos: sk_<hex largo> o 32 hex a secas."""
    note = path.read_text(encoding="utf-8", errors="ignore")
    m = re.search(r"\bsk_[A-Za-z0-9]{20,}\b", note) or re.search(r"\b[a-f0-9]{32}\b", note)
    return m.group(0) if m else None


def find_key(explicit=None, note_name=None):
    """
    Orden de búsqueda: --api-key > --key-note > ELEVENLABS_API_KEY > vault.

    En el vault se prefiere una nota que NO diga «trabajo»: si hay una cuenta
    personal, es la que debe gastarse en material de estudio personal.
    """
    if explicit:
        return explicit, "--api-key"

    if note_name:
        for f in key_notes():
            if note_name.lower() in f.stem.lower():
                k = key_from_note(f)
                if k:
                    return k, f.name
        raise SystemExit(f"No encontré ninguna nota que coincida con «{note_name}» en {KEY_DIR}")

    env = os.environ.get("ELEVENLABS_API_KEY")
    if env:
        return env.strip(), "ELEVENLABS_API_KEY"

    notes = key_notes()
    personales = [f for f in notes if "trabajo" not in f.stem.lower()]
    for f in (personales + notes):
        k = key_from_note(f)
        if k:
            return k, f.name
    return None, None


def api(path, key, method="GET", body=None, raw=False):
    req = urllib.request.Request(f"{API}{path}", method=method)
    req.add_header("xi-api-key", key)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data, timeout=120) as res:
        return res.read() if raw else json.loads(res.read())


def show_quota(key):
    try:
        sub = api("/user/subscription", key)
    except urllib.error.HTTPError as e:
        print(f"No se pudo consultar la cuota (HTTP {e.code}). ¿La key es válida?")
        return None
    used = sub.get("character_count", 0)
    limit = sub.get("character_limit", 0)
    left = max(0, limit - used)
    print(f"  Plan:       {sub.get('tier', '?')}")
    print(f"  Usado:      {used:,} / {limit:,} caracteres")
    print(f"  Disponible: {left:,} caracteres")
    return left


def pick_voice(key, accent, explicit):
    if explicit:
        return explicit, "(especificada a mano)"
    voices = api("/voices", key).get("voices", [])
    want = "british" if accent == "uk" else "american"
    for v in voices:
        labels = " ".join(str(x).lower() for x in (v.get("labels") or {}).values())
        if want in labels:
            return v["voice_id"], v.get("name", "?")
    if voices:
        return voices[0]["voice_id"], voices[0].get("name", "?") + " (sin acento coincidente)"
    raise SystemExit("La cuenta no tiene voces disponibles.")


class QuotaExhausted(Exception):
    pass


def synthesize(key, voice_id, model, text, retries=4):
    """
    Sintetiza con reintentos. Distingue tres cosas que la API mete en el mismo
    429: rate limit (se reintenta), cuota agotada (se aborta) y sistema
    ocupado (se reintenta). Sin esto, una corrida de 677 clips se cae a la
    mitad por un límite de ritmo transitorio.
    """
    delay = 2
    for intento in range(retries + 1):
        try:
            return api(
                f"/text-to-speech/{voice_id}",
                key,
                method="POST",
                raw=True,
                body={
                    "text": text,
                    "model_id": model,
                    "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "speed": 0.95},
                },
            )
        except urllib.error.HTTPError as e:
            cuerpo = ""
            try:
                cuerpo = e.read().decode("utf-8", "ignore")
            except Exception:
                pass

            if e.code == 401:
                raise
            if e.code == 429 and "quota_exceeded" in cuerpo:
                raise QuotaExhausted(cuerpo[:200])
            if e.code in (429, 500, 502, 503, 504) and intento < retries:
                time.sleep(delay)
                delay *= 2
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            if intento < retries:
                time.sleep(delay)
                delay *= 2
                continue
            raise


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="Genera los audios de English Lab con ElevenLabs.")
    p.add_argument("--go", action="store_true",
                   help="Genera de verdad. Sin esto sólo hace dry-run (no toca la API).")
    p.add_argument("--priority", type=int, default=3, choices=[1, 2, 3, 4],
                   help="Genera hasta esta prioridad inclusive (default 3: todo menos las lecturas).")
    p.add_argument("--limit", type=int, default=0,
                   help="Techo duro de caracteres a consumir en esta corrida. 0 = sin techo.")
    p.add_argument("--accent", choices=["uk", "us"], default="uk",
                   help="UK por defecto: el EXCI lo desarrolló el British Council.")
    p.add_argument("--voice-id", help="Forzar una voz concreta.")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--api-key", help="Key explícita (si no, ELEVENLABS_API_KEY o una nota del vault).")
    p.add_argument("--key-note", metavar="TEXTO",
                   help="Usa la nota del vault cuyo nombre contenga TEXTO (ej. --key-note personal).")
    p.add_argument("--quota", action="store_true", help="Sólo consulta la cuota y sale.")
    p.add_argument("--keys", action="store_true",
                   help="Lista las notas de key del vault con la cuota de cada cuenta, y sale.")
    p.add_argument("--list-voices", action="store_true", help="Lista las voces de la cuenta y sale.")
    p.add_argument("--base-url", metavar="URL",
                   help="Sirve los mp3 desde otro lado (Firebase Storage, R2, un CDN) en vez de "
                        "desde web/audio/. Sólo reescribe el índice; no sube nada ni genera audio.")
    p.add_argument("--base-suffix", metavar="SUF", default=None,
                   help="Se añade al final de cada URL. Firebase Storage necesita '?alt=media'.")
    args = p.parse_args()

    if args.base_url is not None or args.base_suffix is not None:
        manifest = load(MANIFEST) or {}
        write_index(manifest, base=args.base_url, suffix=args.base_suffix)
        idx = json.loads(INDEX.read_text(encoding="utf-8"))
        n = len(idx["files"])
        ejemplo = next(iter(idx["files"].values()), "archivo.mp3")
        print(f"\nÍndice reapuntado. {n} clips.")
        print(f"  URL de ejemplo: {idx['base'] or 'audio/'}{ejemplo}{idx['suffix']}")
        if idx["base"]:
            print("\n  Falta subir el contenido de web/audio/ a ese destino.")
            print("  Firebase Storage: consola -> Storage -> subir la carpeta 'audio'.")
            print("  Y en Reglas, permitir lectura pública de esa carpeta.")
        print()
        return

    if args.keys:
        notes = key_notes()
        print(f"\nNOTAS DE KEY EN {KEY_DIR}\n" + "-" * 66)
        if not notes:
            print("  (ninguna)")
            print(f"\n  Guarda tu key como una nota .md en esa carpeta y este script la toma solo.")
            return
        for f in notes:
            k = key_from_note(f)
            if not k:
                print(f"  {f.name:<34} sin key reconocible dentro")
                continue
            try:
                sub = api("/user/subscription", k)
                used, limit = sub.get("character_count", 0), sub.get("character_limit", 0)
                print(f"  {f.name:<34} ...{k[-4:]}  plan={sub.get('tier','?'):<9} "
                      f"disponible={max(0, limit - used):>7,}")
            except urllib.error.HTTPError as e:
                print(f"  {f.name:<34} ...{k[-4:]}  INVÁLIDA (HTTP {e.code})")
        print("\n  Se prefiere automáticamente una nota que NO diga «trabajo».")
        print("  Para forzar una:  --key-note <parte del nombre>\n")
        return

    key, key_src = find_key(args.api_key, args.key_note)

    if args.quota or args.list_voices:
        if not key:
            raise SystemExit("No encontré la API key. Usa --api-key, --key-note o exporta ELEVENLABS_API_KEY.")
        if args.quota:
            print("\nCUOTA DE ELEVENLABS\n" + "-" * 50)
            print(f"  Key desde: {key_src}  (...{key[-4:]})")
            show_quota(key)
        if args.list_voices:
            print("\nVOCES DISPONIBLES\n" + "-" * 50)
            for v in api("/voices", key).get("voices", []):
                labels = (v.get("labels") or {})
                print(f"  {v['voice_id']}  {v.get('name','?'):<20} {labels.get('accent','')} {labels.get('gender','')}")
        return

    items = collect()
    manifest = load(MANIFEST) or {}

    # La voz forma parte del hash, así que en dry-run sin key usamos un
    # marcador: sirve para contar caracteres, no para identificar archivos.
    voice_id, voice_name = (args.voice_id or "PENDING", "(sin resolver)")
    if args.go:
        if not key:
            raise SystemExit(
                "No encontré la API key.\n"
                "  Opciones: exporta ELEVENLABS_API_KEY, pasa --api-key, o guarda la key\n"
                f"  como una nota .md en {KEY_DIR}\n"
                "  Para ver qué notas hay y cuánta cuota tiene cada una:  --keys"
            )
        voice_id, voice_name = pick_voice(key, args.accent, args.voice_id)

    # Índice por texto: en dry-run no conocemos la voz (no la preguntamos a la
    # API), así que el hash exacto no se puede calcular. Comparar por texto es
    # exacto mientras no cambies de voz, y es lo que pasa el 99% de las veces.
    done_texts = {v["text"] for v in manifest.values()
                  if (AUDIO_DIR / v["file"]).is_file()}

    wanted = [(prio, text, src) for prio, text, src in items if prio <= args.priority]
    pending, already = [], 0
    for prio, text, src in wanted:
        if args.go:
            h = digest(text, voice_id, args.model)
            hecho = h in manifest and (AUDIO_DIR / manifest[h]["file"]).is_file()
        else:
            h = None
            hecho = text in done_texts
        if hecho:
            already += 1
        else:
            pending.append((prio, text, src, h))

    # ---- Reporte ----
    print("\nENGLISH LAB — GENERACIÓN DE AUDIO")
    print("=" * 62)
    print(f"  Modo:      {'GENERAR' if args.go else 'DRY-RUN (no se llama a la API)'}")
    print(f"  Acento:    {args.accent.upper()}   Voz: {voice_name}")
    print(f"  Modelo:    {args.model}")
    print(f"  Prioridad: hasta {args.priority} — {PRIORITIES[args.priority]}")
    print("-" * 62)

    by_prio = {}
    for prio, text, _src, _h in pending:
        e = by_prio.setdefault(prio, [0, 0])
        e[0] += 1
        e[1] += len(text)

    total_chars = 0
    for prio in sorted(PRIORITIES):
        n, chars = by_prio.get(prio, (0, 0))
        total_chars += chars
        mark = " " if prio <= args.priority else "·"
        print(f"  {mark} P{prio} {PRIORITIES[prio]:<42} {n:>4} clips  {chars:>7,} car.")

    print("-" * 62)
    print(f"  Ya generados (no se vuelven a cobrar):        {already:>4} clips")
    print(f"  POR GENERAR AHORA:                            {len(pending):>4} clips  {total_chars:>7,} car.")

    skipped = [(prio, text) for prio, text, _s in items if prio > args.priority]
    if skipped:
        print(f"  Omitidos por prioridad:                       {len(skipped):>4} clips  "
              f"{sum(len(t) for _p, t in skipped):>7,} car.")

    if args.limit:
        print(f"  Techo de esta corrida (--limit):              {args.limit:>12,} car.")

    if not args.go:
        print("=" * 62)
        print("\n  Esto fue un DRY-RUN: NO se llamó a la API y no se gastó nada.")
        print(f"  Key: {f'{key_src} (...{key[-4:]})' if key else 'NO ENCONTRADA — corre --keys para ver las notas del vault'}")
        print("\n  La app funciona al 100% sin un solo mp3: el reproductor cae solo a la")
        print("  voz del navegador. Generar audio es una mejora, no un requisito.")
        print("\n  Siguientes pasos:")
        print("    python tools/gen_audio.py --quota            # cuánta cuota te queda")
        print("    python tools/gen_audio.py --go --priority 1  # sólo simulacros y diagnóstico")
        print("    python tools/gen_audio.py --go --limit 20000 # con techo de gasto\n")
        return

    if not pending:
        print("\n  Nada que generar. Todo está al día.\n")
        write_index(manifest)
        return

    # ---- Generación ----
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    print("=" * 62)
    spent = 0
    made = 0

    total = len(pending)
    fallidos = []
    # Con cientos de clips, una línea por clip es ilegible: reportamos por lotes.
    paso = 1 if total <= 30 else 25
    t0 = time.time()

    for prio, text, src, h in sorted(pending, key=lambda x: x[0]):
        if args.limit and spent + len(text) > args.limit:
            print(f"\n  Techo de {args.limit:,} caracteres alcanzado. Me detengo aquí.")
            break
        try:
            audio = synthesize(key, voice_id, args.model, text)
        except QuotaExhausted as e:
            print(f"\n  !! CUOTA AGOTADA tras {made} clips. Lo generado queda guardado.")
            print(f"     {e}")
            break
        except urllib.error.HTTPError as e:
            if e.code == 401:
                print("\n  !! Key inválida (401). Me detengo.")
                break
            fallidos.append((src, f"HTTP {e.code}"))
            continue
        except Exception as e:
            fallidos.append((src, str(e)[:60]))
            continue

        fname = f"{h}.mp3"
        (AUDIO_DIR / fname).write_bytes(audio)
        manifest[h] = {"file": fname, "text": text, "chars": len(text),
                       "voice": voice_id, "model": args.model, "source": src, "priority": prio}

        # Se guarda en cada iteración: si esto se cae a la mitad, no se
        # re-cobra nada al reanudar.
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        spent += len(text)
        made += 1

        if made % paso == 0 or made == total:
            transcurrido = time.time() - t0
            ritmo = made / transcurrido if transcurrido else 0
            faltan = (total - made) / ritmo if ritmo else 0
            print(f"  [{made:>4}/{total}] P{prio}  {spent:>6,} car.  "
                  f"{ritmo:.1f} clips/s  ~{faltan/60:.0f} min restantes", flush=True)
            write_index(manifest)  # el índice se refresca en caliente

    write_index(manifest)
    print("\n" + "=" * 62)
    print(f"  Generados: {made} clips · {spent:,} caracteres enviados")
    if fallidos:
        print(f"  Fallaron {len(fallidos)} (se reintentan solos al re-correr el script):")
        for src, err in fallidos[:10]:
            print(f"    - {src}: {err}")
        if len(fallidos) > 10:
            print(f"    ... y {len(fallidos) - 10} más")
    print(f"  Índice actualizado: {INDEX.relative_to(ROOT)}")
    print("  Recarga la página y el audio nuevo se usa solo.\n")


def write_index(manifest, base=None, suffix=None):
    """
    Índice que lee web/js/audio.js:
        { base, suffix, files: {texto exacto -> archivo} }

    La URL final es  base + archivo + suffix.

    `base` permite servir los mp3 desde fuera del repo (Firebase Storage, R2,
    cualquier CDN); `suffix` existe porque Firebase Storage exige `?alt=media`
    al final de cada URL. Sin base, se sirven desde web/audio/ como siempre.
    """
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    files = {v["text"]: v["file"] for v in manifest.values()
             if (AUDIO_DIR / v["file"]).is_file()}

    # Conserva lo ya configurado si no se pasa explícitamente.
    previo = {}
    if INDEX.is_file():
        try:
            previo = json.loads(INDEX.read_text(encoding="utf-8")) or {}
        except Exception:
            previo = {}
    if base is None:
        base = previo.get("base")
    if suffix is None:
        suffix = previo.get("suffix")

    INDEX.write_text(
        json.dumps({"base": base or "", "suffix": suffix or "", "files": files},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
