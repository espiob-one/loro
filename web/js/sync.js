/* ==========================================================================
   sync.js — cuenta de Google y sincronización del progreso (opcional).

   Tres reglas que mandan sobre todo lo demás:

   1. LOCAL PRIMERO. La app funciona completa sin cuenta, sin red y sin
      Firebase. Esto es una capa encima, nunca un requisito. Si algo aquí
      falla, la app ni se entera.
   2. CARGA PEREZOSA. El SDK de Firebase se descarga de un CDN, o sea que
      necesita internet. Sólo se toca cuando el usuario pide iniciar sesión
      o cuando ya había una sesión guardada.
   3. NUNCA SE PIERDE PROGRESO. Al sincronizar se FUSIONA (ver
      store.mergeRemote), no se sobreescribe. Practicar en el teléfono y
      luego abrir la laptop no debe borrar nada.

   La config de Firebase para web NO es un secreto: son identificadores
   públicos, van en el repo a propósito. Lo que protege los datos son las
   reglas de Firestore (ver firestore.rules), que sólo dejan a cada usuario
   leer y escribir su propio documento.
   ========================================================================== */

import * as store from './store.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

let config = null;
let fb = null;          // { auth, db, api }
let user = null;
let estado = 'sin-configurar';  // sin-configurar | listo | conectando | dentro | error
let ultimoError = '';
let desuscribir = null;
const oyentes = new Set();

export const getEstado = () => estado;
export const getUser = () => user;
export const getError = () => ultimoError;
export const disponible = () => estado !== 'sin-configurar';

export function onEstado(fn) {
  oyentes.add(fn);
  return () => oyentes.delete(fn);
}

function avisar() {
  for (const fn of oyentes) {
    try { fn({ estado, user, error: ultimoError }); } catch { /* ignorado */ }
  }
}

function setEstado(e, err = '') {
  estado = e;
  ultimoError = err;
  avisar();
}

/* ---------- arranque ---------- */

/**
 * Lee la configuración. NO carga Firebase todavía: sólo decide si la opción
 * de iniciar sesión debe existir en la interfaz.
 */
export async function init() {
  try {
    const res = await fetch('firebase-config.json', { cache: 'no-cache' });
    if (!res.ok) return setEstado('sin-configurar');
    const c = await res.json();
    if (!c || !c.apiKey || c.apiKey.startsWith('PEGA_')) return setEstado('sin-configurar');
    config = c;
    setEstado('listo');
  } catch {
    setEstado('sin-configurar');
  }

  // Si ya había sesión, la reanudamos sola. Si no hay red, esto falla en
  // silencio y la app se queda en modo local, que es lo correcto.
  if (estado === 'listo' && store.get().uid) {
    cargarSDK().catch(() => setEstado('listo'));
  }
}

async function cargarSDK() {
  if (fb) return fb;
  setEstado('conectando');

  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`)
  ]);

  const app = initializeApp(config);
  fb = {
    auth: auth.getAuth(app),
    db: fs.getFirestore(app),
    api: { ...auth, ...fs }
  };

  // A partir de aquí el estado de sesión lo manda Firebase.
  fb.api.onAuthStateChanged(fb.auth, async (u) => {
    user = u ? { uid: u.uid, nombre: u.displayName, correo: u.email, foto: u.photoURL } : null;
    if (u) {
      store.setUid(u.uid);
      setEstado('dentro');
      await sincronizar();
      escucharCambiosLocales();
    } else {
      store.setUid(null);
      pararEscucha();
      setEstado('listo');
    }
  });

  return fb;
}

/* ---------- sesión ---------- */

export async function entrar() {
  try {
    await cargarSDK();
    const provider = new fb.api.GoogleAuthProvider();
    await fb.api.signInWithPopup(fb.auth, provider);
    return true;
  } catch (e) {
    const code = e?.code || '';
    setEstado(config ? 'listo' : 'sin-configurar', mensajeError(code, e));
    return false;
  }
}

export async function salir() {
  try {
    pararEscucha();
    if (fb) await fb.api.signOut(fb.auth);
  } catch { /* da igual: localmente ya salimos */ }
  store.setUid(null);
  user = null;
  setEstado(config ? 'listo' : 'sin-configurar');
}

function mensajeError(code, e) {
  if (code === 'auth/popup-blocked') return 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes para este sitio.';
  if (code === 'auth/popup-closed-by-user') return 'Cerraste la ventana antes de terminar.';
  if (code === 'auth/unauthorized-domain') return 'Este dominio no está autorizado en Firebase. Agrégalo en Authentication → Settings → Authorized domains.';
  if (code === 'auth/network-request-failed') return 'Sin conexión. Tu progreso se sigue guardando en este navegador.';
  if (String(e).includes('Failed to fetch') || String(e).includes('import')) {
    return 'No se pudo cargar Firebase (¿sin internet?). La app funciona igual sin cuenta.';
  }
  return code || String(e?.message || e || 'Error desconocido');
}

/* ---------- sincronización ---------- */

const docRef = () => fb.api.doc(fb.db, 'progreso', user.uid);

/**
 * Baja el remoto, lo fusiona con el local y vuelve a subir el resultado.
 * Ese orden importa: garantiza que ninguno de los dos dispositivos pierda
 * lo que el otro no tenía.
 */
export async function sincronizar() {
  if (!fb || !user) return null;
  try {
    const snap = await fb.api.getDoc(docRef());
    let resumen = null;
    if (snap.exists()) {
      const remoto = snap.data()?.estado;
      if (remoto) resumen = store.mergeRemote(typeof remoto === 'string' ? JSON.parse(remoto) : remoto);
    }
    await subir();
    return resumen;
  } catch (e) {
    setEstado('dentro', 'No se pudo sincronizar: ' + mensajeError(e?.code, e));
    return null;
  }
}

async function subir() {
  if (!fb || !user) return;
  const estadoLocal = store.snapshot();
  // Se guarda como cadena: el estado tiene claves con puntos y caracteres que
  // a Firestore no le gustan como nombres de campo (ids de tarjetas, textos).
  await fb.api.setDoc(docRef(), {
    estado: JSON.stringify(estadoLocal),
    actualizado: estadoLocal.updatedAt,
    correo: user.correo || null
  });
}

/* ---------- subida automática con rebote ---------- */

let temporizador = null;
let quitarOyente = null;

function escucharCambiosLocales() {
  if (quitarOyente) return;
  quitarOyente = store.onChange(() => {
    clearTimeout(temporizador);
    // 4 s: suficiente para no escribir en cada tecla de un ejercicio, y poco
    // para no perder nada si cierras la pestaña de golpe.
    temporizador = setTimeout(() => { subir().catch(() => {}); }, 4000);
  });
}

function pararEscucha() {
  clearTimeout(temporizador);
  if (quitarOyente) { quitarOyente(); quitarOyente = null; }
}

// Último intento al cerrar la pestaña, por si quedó algo sin subir.
window.addEventListener('beforeunload', () => {
  if (fb && user) { clearTimeout(temporizador); subir().catch(() => {}); }
});
