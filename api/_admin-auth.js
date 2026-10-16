/* Prüft, ob ein Firebase-ID-Token zu einem freigegebenen Admin gehört.
 *
 * Ein gültiges Firebase-Konto allein reicht nicht: Mit dem öffentlichen API-Key
 * kann sich – je nach Einstellung in Firebase – jeder selbst ein Konto anlegen.
 * Deshalb zusätzlich die Liste ADMIN_EMAILS (Vercel-Umgebungsvariable, mehrere
 * Adressen durch Komma getrennt). Ist sie leer, wird niemand durchgelassen.
 */

const FIREBASE_API_KEY = 'AIzaSyDzxxj-kK4eo2RgW-ZQt26cJzHGRs75WbQ';

function adminListe() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/* Gibt die E-Mail des Admins zurück oder wirft einen Fehler mit lesbarer Meldung. */
export async function verifyAdmin(idToken) {
  if (!idToken || typeof idToken !== 'string') throw new Error('Nicht angemeldet.');

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

  const admins = adminListe();
  if (!admins.length) {
    throw new Error('Keine Admins eingerichtet (ADMIN_EMAILS in Vercel fehlt).');
  }
  const email = String(user.email || '').toLowerCase();
  if (!email || !admins.includes(email)) {
    throw new Error('Dieses Konto ist nicht für die Verwaltung freigegeben.');
  }
  return email;
}
