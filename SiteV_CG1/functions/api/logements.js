/**
 * Cloudflare Pages Function — relais same-origin pour l'API publique du CROUS.
 * Aucun paquet à installer et aucune clé API nécessaire.
 * Si la campagne CROUS change, modifier CROUS_TOOL_ID en haut de app.js et ici.
 */
const CROUS_API_URL = 'https://trouverunlogement.lescrous.fr/api/fr/search/47';
const MAX_BODY_BYTES = 4096;

export async function onRequestPost({ request }) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: 'Requête trop volumineuse.' }, 413);
  }

  let incoming;
  try {
    incoming = await request.json();
  } catch {
    return json({ error: 'Corps JSON invalide.' }, 400);
  }

  // Paramètres volontairement imposés côté serveur pour éviter des requêtes arbitraires.
  const payload = {
    idTool: 47,
    need_aggregation: false,
    page: 1,
    pageSize: 100,
    sector: null,
    occupationModes: ['alone', 'couple', 'house_sharing'],
    location: null,
    residence: null,
    precision: null,
    equipment: [],
    price: { min: 0, max: 1000000 },
    area: { min: 0 },
    adaptedPmr: false
  };

  try {
    const upstream = await fetch(CROUS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/ld+json, application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });

    if (!upstream.ok) {
      return json({ error: `Le portail CROUS a répondu HTTP ${upstream.status}.` }, 502);
    }

    const data = await upstream.json();
    if (data?.errors) {
      return json({ error: 'Le portail CROUS a refusé la recherche.' }, 502);
    }

    // Ne réécrire ni les textes ni les informations sources : elles sont affichées avec attribution.
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    return json({ error: 'Impossible de joindre le portail officiel du CROUS.' }, 502);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
