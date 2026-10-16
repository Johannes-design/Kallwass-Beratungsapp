/* POST /api/images
 *
 * Listet die bereits hochgeladenen Bilder aus dem Blob-Store auf. Grundlage für
 * den Bild-Picker in der Verwaltung: einem Produkt ein vorhandenes Bild zuweisen,
 * ohne es erneut hochzuladen.
 *
 * POST (statt GET), weil der Firebase-ID-Token im Body übergeben wird und nichts
 * Sensibles in eine URL gehört – URLs landen in Logs, Verläufen und Referrern.
 *
 * Body: { idToken: string, cursor?: string }
 */

import { list } from '@vercel/blob';
import { blobAuth } from './_blob-auth.js';
import { verifyAdmin } from './_admin-auth.js';



export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Nur POST erlaubt.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    await verifyAdmin(body.idToken);

    const bilder = [];
    let cursor = undefined;
    let seiten = 0;

    // Alle Seiten einsammeln. Bei einem Katalog dieser Größe sind das ein bis zwei.
    do {
      const seite = await list({ limit: 1000, cursor, ...blobAuth() });
      for (const b of seite.blobs) {
        bilder.push({
          url: b.url,
          name: b.pathname.split('/').pop(),
          bytes: b.size,
          hochgeladen: b.uploadedAt
        });
      }
      cursor = seite.hasMore ? seite.cursor : undefined;
      seiten++;
    } while (cursor && seiten < 10);

    // Neueste zuerst – so liegt das gerade Hochgeladene ganz oben.
    bilder.sort((a, b) => String(b.hochgeladen).localeCompare(String(a.hochgeladen)));

    return res.status(200).json({ bilder, anzahl: bilder.length });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Liste konnte nicht geladen werden.' });
  }
}
