/* POST /api/auswahl
 *
 * Angehörige stellen auf /auswahl.html eine Merkliste zusammen (Blumen, Urnen …)
 * und schicken sie ab. Diese Funktion macht daraus eine Mail an das Bestattungshaus.
 *
 * Die Seite schickt nur Produkt-IDs, keine Namen oder Bild-Adressen. Name und Bild
 * holen wir hier selbst aus Firestore – sonst könnte jeder beliebigen Text und
 * fremde Bilder in eine Mail an post@ schreiben, die nach Kallwaß aussieht.
 *
 * Versand über SMTP. Einstellungen als Umgebungsvariablen in Vercel:
 *   AUSWAHL_SMTP_USER   - Absender-Konto, z. B. ein Gmail-Konto
 *   AUSWAHL_SMTP_PASS   - App-Passwort dieses Kontos
 *   AUSWAHL_SMTP_HOST   - optional, Standard smtp.gmail.com
 *   AUSWAHL_SMTP_PORT   - optional, Standard 465
 *   AUSWAHL_EMPFAENGER  - optional, Standard post@bestattungshaus-kallwass.de
 *
 * Fehlen die Zugangsdaten, antwortet die Funktion mit 503 und die Seite bietet
 * stattdessen an, die Auswahl über das eigene Mail-Programm zu schicken.
 *
 * Body (JSON): { ids: string[], name, kontakt, fuer, anmerkung, schleifen, website }
 *   schleifen: { produktId: [{ links, rechts }] } – Schleifentexte, höchstens 4 je Artikel
 *   website ist ein unsichtbares Lockfeld: Menschen lassen es leer, Spam-Bots nicht.
 */

import nodemailer from 'nodemailer';

const FIREBASE_API_KEY = 'AIzaSyDzxxj-kK4eo2RgW-ZQt26cJzHGRs75WbQ';
const PROJEKT = 'beratungsapp-bh-kallwass';
const MAX_ARTIKEL = 40;

function text(wert, max) {
  return String(wert == null ? '' : wert).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function html(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function produkt(id) {
  const res = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + PROJEKT +
    '/databases/(default)/documents/products/' + encodeURIComponent(id) + '?key=' + FIREBASE_API_KEY
  );
  if (!res.ok) return null;
  const f = (await res.json()).fields || {};
  const wert = k => (f[k] && f[k].stringValue) || '';
  return { name: wert('name'), gruppe: wert('subcategory'), bild: wert('imageUrl'), preis: wert('price') };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Nur POST erlaubt.' });
  }

  const body = req.body || {};
  if (body.website) return res.status(200).json({ ok: true });   // Bot – still verwerfen

  const name = text(body.name, 120);
  const kontakt = text(body.kontakt, 160);
  const fuer = text(body.fuer, 160);
  const anmerkung = String(body.anmerkung || '').slice(0, 2000).trim();
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [])
    .filter(id => typeof id === 'string' && /^[A-Za-z0-9]{10,40}$/.test(id)))].slice(0, MAX_ARTIKEL);

  // Schleifentexte je Artikel: { produktId: [{ links, rechts }] }. Zeilenumbrüche bleiben,
  // die Schreibweise ist genau das, was die Familie eingetippt hat.
  const band = s => String(s == null ? '' : s).replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, 300);
  const schleifen = {};
  const roh = body.schleifen && typeof body.schleifen === 'object' ? body.schleifen : {};
  for (const id of ids) {
    const liste = (Array.isArray(roh[id]) ? roh[id] : []).slice(0, 4)
      .map(s => ({ links: band(s && s.links), rechts: band(s && s.rechts) }))
      .filter(s => s.links || s.rechts);
    if (liste.length) schleifen[id] = liste;
  }

  if (!name || !kontakt) return res.status(400).json({ error: 'Bitte Name und Telefon oder E-Mail angeben.' });
  if (!ids.length) return res.status(400).json({ error: 'Die Merkliste ist leer.' });

  const user = process.env.AUSWAHL_SMTP_USER;
  const pass = (process.env.AUSWAHL_SMTP_PASS || '').replace(/\s/g, '');
  if (!user || !pass) return res.status(503).json({ error: 'Mailversand ist noch nicht eingerichtet.' });

  const artikel = (await Promise.all(ids.map(async id => {
    const p = await produkt(id);
    return p && { ...p, schleifen: schleifen[id] || [] };
  }))).filter(p => p && p.name);
  if (!artikel.length) return res.status(400).json({ error: 'Die gemerkten Artikel gibt es nicht mehr.' });

  const empfaenger = process.env.AUSWAHL_EMPFAENGER || 'post@bestattungshaus-kallwass.de';
  const mailAntwort = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(kontakt) ? kontakt : undefined;
  const betreff = 'Auswahl ' + (fuer ? 'für ' + fuer : 'von ' + name) + ' (' + artikel.length + ')';

  const zeilen = artikel.map((p, i) =>
    (i + 1) + '. ' + p.name + (p.gruppe ? ' – ' + p.gruppe : '') + (p.preis ? ' – ' + p.preis : '') +
    p.schleifen.map((s, j) =>
      '\n   Schleife ' + (j + 1) + ' links:  ' + (s.links || '–') +
      '\n   Schleife ' + (j + 1) + ' rechts: ' + (s.rechts || '–')).join(''));
  const klartext = [
    'Neue Auswahl über die Beratungsapp',
    '',
    'Von: ' + name,
    'Kontakt: ' + kontakt,
    fuer ? 'Für: ' + fuer : '',
    anmerkung ? '\nAnmerkung:\n' + anmerkung : '',
    '',
    'Gemerkt:',
    ...zeilen
  ].filter(z => z !== '').join('\n');

  const kacheln = artikel.map(p =>
    '<td style="width:180px;padding:8px;vertical-align:top;font-family:Georgia,serif">' +
    (p.bild ? '<img src="' + html(p.bild) + '" width="170" style="width:170px;height:170px;object-fit:cover;border-radius:8px;display:block" alt="">' : '') +
    '<div style="font-size:14px;color:#2A1A1D;margin-top:6px">' + html(p.name) + '</div>' +
    '<div style="font-size:12px;color:#6B5A5E">' + html([p.gruppe, p.preis].filter(Boolean).join(' · ')) + '</div></td>');
  const reihen = [];
  for (let i = 0; i < kacheln.length; i += 3) reihen.push('<tr>' + kacheln.slice(i, i + 3).join('') + '</tr>');

  const mitSchleife = artikel.filter(p => p.schleifen.length);
  const bandZelle = t => '<td style="width:50%;vertical-align:top;padding:8px 10px;background:#FAF7F2;border:1px solid #E8E2DA;' +
    'font-family:Georgia,serif;font-size:15px;white-space:pre-wrap">' + (t ? html(t) : '<span style="color:#9A8A8E">–</span>') + '</td>';
  const schleifenHtml = mitSchleife.length
    ? '<h3 style="font-family:Georgia,serif;color:#5A1A22;font-weight:normal;margin-top:24px">Schleifentexte</h3>' +
      mitSchleife.map(p =>
        '<p style="margin:14px 0 4px"><b>' + html(p.name) + '</b></p>' +
        p.schleifen.map((s, j) =>
          '<table cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;border-collapse:collapse;margin-bottom:6px">' +
          '<tr><td colspan="2" style="font-size:12px;color:#6B5A5E;padding:2px 0">Schleife ' + (j + 1) + ' · links Spruch, rechts von wem</td></tr>' +
          '<tr>' + bandZelle(s.links) + bandZelle(s.rechts) + '</tr></table>').join('')).join('')
    : '';

  const inhalt =
    '<div style="font-family:Arial,sans-serif;color:#2A1A1D;max-width:600px">' +
    '<h2 style="font-family:Georgia,serif;color:#5A1A22;font-weight:normal">Neue Auswahl über die Beratungsapp</h2>' +
    '<p style="line-height:1.6"><b>Von:</b> ' + html(name) + '<br><b>Kontakt:</b> ' + html(kontakt) +
    (fuer ? '<br><b>Für:</b> ' + html(fuer) : '') + '</p>' +
    (anmerkung ? '<p style="background:#FAF7F2;padding:10px 14px;border-left:3px solid #C5A55A;white-space:pre-wrap">' + html(anmerkung) + '</p>' : '') +
    '<table cellspacing="0" cellpadding="0">' + reihen.join('') + '</table>' + schleifenHtml + '</div>';

  try {
    const transport = nodemailer.createTransport({
      host: process.env.AUSWAHL_SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.AUSWAHL_SMTP_PORT || 465),
      secure: Number(process.env.AUSWAHL_SMTP_PORT || 465) === 465,
      auth: { user, pass }
    });
    await transport.sendMail({
      from: '"Beratungsapp Kallwaß" <' + user + '>',
      to: empfaenger,
      replyTo: mailAntwort,
      subject: betreff,
      text: klartext,
      html: inhalt
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Auswahl-Mail fehlgeschlagen:', err && err.message);
    return res.status(502).json({ error: 'Die Mail konnte gerade nicht verschickt werden.' });
  }
}
