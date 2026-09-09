/* POST /api/upload
 *
 * Nimmt ein bereits im Browser auf WebP komprimiertes Bild entgegen und legt es
 * im Vercel-Blob-Store ab. Antwortet mit dem Pfad, unter dem das Bild danach auf
 * der eigenen Domain erreichbar ist (/img/...).
 *
 * Warum der Upload durch diese Funktion läuft statt direkt zum Blob-Store:
 * Die App komprimiert vorher auf WebP (~100–300 KB). Damit bleiben wir weit unter
 * dem 4,5-MB-Limit für Request-Bodies, und wir sparen uns die deutlich fehler-
 * anfälligere Token-Choreografie des Direkt-Uploads.
 *
 * Absicherung: Firebase-ID-Token des angemeldeten Admins, serverseitig bei Google
 * geprüft. Das BLOB_READ_WRITE_TOKEN verlässt niemals den Server.
 *
 * Erwarteter Body (JSON):
 *   idToken     - Firebase-ID-Token des angemeldeten Admins
 *   filename    - ursprünglicher Dateiname (nur für die Lesbarkeit im Store)
 *   contentType - image/webp, image/jpeg oder image/png
 *   data        - die Bilddatei als base64-String
 */

import { put } from '@vercel/blob';
import { blobAuth } from './_blob-auth.js';

const FIREBASE_API_KEY = 'AIzaSyDzxxj-kK4eo2RgW-ZQt26cJzHGRs75WbQ';
const MAX_BYTES = 4 * 1024 * 1024;
const ERLAUBTE_TYPEN = ['image/webp', 'image/jpeg', 'image/png'];

async function verifyFirebaseToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Nicht angemeldet.');
  }
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) throw new Error('Anmeldung abgelaufen – bitte neu anmelden.');
  const data = await res.json();
  const user = data.users && data.users[0];
  if (!user || !user.localId) throw new Error('Anmeldung ungültig.');
  return user.email || user.localId;
}

/* Dateinamen entschärfen: nur Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich. */
function sauberer_name(name) {
  const basis = String(name || 'bild')
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return basis || 'bild';
}

/* Bild von einer fremden Adresse holen (Lieferantenkatalog).
 *
 * Erspart den Umweg "herunterladen, ablegen, wieder hochladen". Nur fuer
 * angemeldete Admins erreichbar; zusaetzlich hier abgesichert, damit der Server
 * nicht als Sprungbrett ins interne Netz missbraucht werden kann:
 * nur http/https, keine privaten Adressbereiche, nur Bilder, begrenzte Groesse.
 */
const PRIVATE_ZIELE = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^\[?::1\]?$/, /\.local$/i, /^metadata\./i
];

async function vonAdresseHolen(quelle) {
  let u;
  try { u = new URL(quelle); } catch (e) { throw new Error('Ungültige Adresse.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Nur http und https erlaubt.');
  }
  if (PRIVATE_ZIELE.some(r => r.test(u.hostname))) {
    throw new Error('Adresse zeigt ins lokale Netz – abgelehnt.');
  }

  const abbruch = new AbortController();
  const uhr = setTimeout(() => abbruch.abort(), 30000);
  let res;
  try {
    res = await fetch(u.href, {
      redirect: 'follow',
      signal: abbruch.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Beratungsapp Bildimport)' }
    });
  } finally {
    clearTimeout(uhr);
  }
  if (!res.ok) throw new Error('Quelle antwortete mit HTTP ' + res.status);

  const typ = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!typ.startsWith('image/')) throw new Error('Kein Bild an dieser Adresse (' + (typ || 'unbekannt') + ').');

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) {
    throw new Error('Bild zu groß (' + Math.round(buffer.length / 1024) + ' KB).');
  }
  if (buffer.length < 1000) throw new Error('Antwort zu klein für ein Bild.');
  return { buffer, typ: ERLAUBTE_TYPEN.includes(typ) ? typ : 'image/jpeg' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Nur POST erlaubt.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { idToken, filename, contentType, data, quelle } = body;

    const email = await verifyFirebaseToken(idToken);

    // Variante 1: Bild liegt an einer Adresse und wird vom Server geholt.
    if (quelle) {
      const geholt = await vonAdresseHolen(quelle);
      const pfad = 'produkte/' + Date.now() + '-' +
        sauberer_name(filename || quelle.split('/').pop()).replace(/\.[^.]*$/, '') +
        (geholt.typ === 'image/png' ? '.png' : '.jpg');
      const blob = await put(pfad, geholt.buffer, {
        access: 'public', contentType: geholt.typ, addRandomSuffix: true, ...blobAuth()
      });
      console.log('[import] ' + blob.pathname + ' von ' + quelle + ' durch ' + email);
      return res.status(200).json({ url: blob.url, pathname: blob.pathname, bytes: geholt.buffer.length });
    }

    // Variante 2: Der Browser schickt die Datei mit.
    if (!ERLAUBTE_TYPEN.includes(contentType)) {
      throw new Error('Dateityp nicht erlaubt: ' + contentType);
    }
    if (!data || typeof data !== 'string') {
      throw new Error('Keine Bilddaten empfangen.');
    }

    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) throw new Error('Bilddaten sind leer.');
    if (buffer.length > MAX_BYTES) {
      throw new Error('Bild zu groß (' + Math.round(buffer.length / 1024) + ' KB, max 4096 KB).');
    }

    const endung = contentType === 'image/webp' ? 'webp'
                 : contentType === 'image/png'  ? 'png'
                 : 'jpg';
    const pfad = 'produkte/' + Date.now() + '-' + sauberer_name(filename).replace(/\.[^.]*$/, '') + '.' + endung;

    const blob = await put(pfad, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: true,
      ...blobAuth()
    });

    // put() liefert die fertige öffentliche URL zurück. Die wird direkt in
    // Firestore gespeichert – dadurch muss nirgends eine Store-ID gepflegt werden.
    console.log('[upload] ' + blob.pathname + ' (' + buffer.length + ' B) von ' + email);

    return res.status(200).json({
      url: blob.url,
      pathname: blob.pathname,
      bytes: buffer.length
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Upload fehlgeschlagen.' });
  }
}
