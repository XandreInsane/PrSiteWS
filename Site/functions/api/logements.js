/**
 * CampusLogis — agrégateur serveur (Cloudflare Pages Functions).
 * Sources : CROUS (API JSON officielle du portail), ImmoJeune et Adele (pages publiques).
 * Aucun proxy générique : les URL sont fixées ici, les requêtes sont limitées et les fiches
 * d'origine sont toujours présentées à l'utilisateur. Les mises en page des sites peuvent évoluer.
 */
const CROUS_TOOL_ID = 47;
const CROUS_API_URL = `https://trouverunlogement.lescrous.fr/api/fr/search/${CROUS_TOOL_ID}`;
const GEO_API = 'https://geo.api.gouv.fr/communes';
const MAX_BODY_BYTES = 4096;
const MAX_HTML_BYTES = 5_000_000;
const REQUEST_TIMEOUT_MS = 9_000;
const ADELE_DETAIL_LIMIT = 8;
const ROBOTS_TIMEOUT_MS = 2_500;
const robotsCache = new Map();

export async function onRequestPost({ request }) {
  if (request.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) return json({ error: 'Requête trop volumineuse.' }, 413);

  let input;
  try { input = await request.json(); } catch { return json({ error: 'Corps JSON invalide.' }, 400); }
  const city = String(input?.city || '').trim().slice(0, 100);
  if (city.length < 2) return json({ error: 'Indique une ville valide.' }, 400);

  const [crousResult, geoResult, adeleResult] = await Promise.allSettled([
    fetchCrous(),
    resolveCommune(city),
    scrapeAdele(city)
  ]);

  const crous = crousResult.status === 'fulfilled' ? crousResult.value : null;
  const commune = geoResult.status === 'fulfilled' ? geoResult.value : null;
  let immojeune = [];
  let immoError = null;
  if (commune?.departmentCode) {
    try { immojeune = await scrapeImmoJeune(city, commune); }
    catch (error) { immoError = publicError(error, 'ImmoJeune'); }
  } else {
    immoError = 'La commune n’a pas pu être identifiée pour construire la recherche ImmoJeune.';
  }

  const adele = adeleResult.status === 'fulfilled' ? adeleResult.value : [];
  const errors = {
    crous: crousResult.status === 'rejected' ? publicError(crousResult.reason, 'CROUS') : null,
    immojeune: immoError,
    adele: adeleResult.status === 'rejected' ? publicError(adeleResult.reason, 'Adele') : null
  };

  // Le frontend applique budget/type/ville. Aucun résultat artificiel n'est ajouté.
  const payload = {
    crous,
    immojeune,
    adele,
    errors,
    counts: {
      crous: extractCrousItems(crous).length,
      immojeune: immojeune.length,
      adele: adele.length
    },
    fetchedAt: new Date().toISOString()
  };
  return json(payload, 200, { 'Cache-Control': 'no-store' });
}

async function fetchCrous() {
  const payload = {
    idTool: CROUS_TOOL_ID,
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
  const response = await fetch(CROUS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/ld+json, application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Réponse HTTP ${response.status}`);
  const data = await response.json();
  if (data?.errors) throw new Error('Le portail CROUS a refusé la recherche.');
  return data;
}

function extractCrousItems(data) {
  const items = data?.results?.items || data?.results?.results || data?.items || data?.results;
  return Array.isArray(items) ? items : [];
}

async function resolveCommune(city) {
  const url = new URL(GEO_API);
  url.searchParams.set('nom', city);
  url.searchParams.set('fields', 'nom,code,departement,population');
  url.searchParams.set('boost', 'population');
  url.searchParams.set('limit', '10');
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Géocodage HTTP ${response.status}`);
  const rows = await response.json();
  const key = normalize(city);
  const row = rows.find((item) => normalize(item.nom) === key) || rows[0];
  if (!row) throw new Error('Ville non trouvée');
  return {
    name: row.nom,
    code: row.code,
    departmentCode: String(row.departement?.code || row.code?.slice(0, 2) || ''),
    departmentName: row.departement?.nom || ''
  };
}

async function scrapeImmoJeune(city, commune) {
  // L'URL publique de ville est construite depuis les données de communes ouvertes.
  // Pour les arrondissements parisiens, on utilise la page de Paris.
  let cityName = commune.name;
  if (/^paris\s+\d/i.test(cityName)) cityName = 'Paris';
  const route = `/logement-etudiant/${slugify(cityName)}-${commune.departmentCode}.html`;
  const html = await fetchHtml(`https://www.immojeune.com${route}`, 'ImmoJeune');
  const pageUrl = `https://www.immojeune.com${route}`;
  const groups = collectPropertyCards(html, pageUrl, /\/residence-etudiante\/[^"'?#]+?_\d+\.html(?:\?[^"']*)?/i);
  const results = [];
  for (const card of groups.slice(0, 60)) {
    const text = cleanText(card.segment);
    const priceArea = parseAreaPrice(text);
    if (!priceArea || priceArea.price <= 0) continue;
    if (/\b(?:complet|aucune disponibilit[eé])\b/i.test(text) && !/disponibilit[eé].{0,30}(?:imm[eé]diate|octobre|novembre|d[eé]cembre|janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre)/i.test(text)) continue;
    const title = card.title || inferTitle(text) || 'Logement étudiant';
    const type = inferHousingType(`${title} ${text}`);
    const address = extractAddress(text);
    const actualCity = address?.city || commune.name;
    results.push({
      id: stableId('immojeune', card.url, type, priceArea.price),
      source: 'ImmoJeune', sourceKey: 'immojeune', title,
      city: actualCity, searchCity: cityName, address: address?.full || actualCity,
      rent: priceArea.price, area: { min: priceArea.areaMin, max: priceArea.areaMax },
      type, description: 'Consulte la fiche d’origine pour le descriptif complet, les charges et les disponibilités.', amenities: [], modes: [],
      link: card.url, availability: /\bcomplet\b|aucune disponibilit[eé]/i.test(text) ? 'À vérifier' : 'À confirmer sur la fiche',
      residence: '', updatedAt: new Date().toISOString()
    });
  }
  return dedupeListings(results);
}

async function scrapeAdele(city) {
  // Adele propose des pages publiques par agglomération et des fiches avec loyer/type/disponibilité.
  let citySlug = slugify(city);
  if (/^paris-\d/.test(citySlug)) citySlug = 'paris';
  const cityUrl = `https://www.adele.org/residence/agglomeration/${citySlug}/logement-etudiant`;
  const listingHtml = await fetchHtml(cityUrl, 'Adele');
  const cards = collectPropertyCards(listingHtml, cityUrl, /\/residence\/\d+\/[^"'?#]+(?:\?[^"']*)?/i);
  const detailUrls = cards.map((card) => card.url).filter((url) => {
    try { return new URL(url).hostname === 'www.adele.org' && /\/residence\/\d+\//.test(new URL(url).pathname); } catch { return false; }
  }).slice(0, ADELE_DETAIL_LIMIT);

  // Les fiches sont récupérées avec une concurrence faible, pas de crawling massif.
  const detailResults = await Promise.allSettled(detailUrls.map(async (detailUrl) => {
    const html = await fetchHtml(detailUrl, 'Adele');
    return parseAdeleDetail(html, detailUrl, city);
  }));
  const listings = [];
  let failures = 0;
  for (const result of detailResults) {
    if (result.status === 'fulfilled') listings.push(...result.value);
    else failures++;
  }
  // Une page de ville valide sans résultats est un vrai résultat vide. On remonte une erreur seulement
  // si toutes les fiches demandées ont échoué et qu'aucune annonce n'a pu être lue.
  if (detailUrls.length && failures === detailUrls.length && listings.length === 0) {
    throw new Error('Les fiches détaillées Adele n’ont pas pu être lues.');
  }
  return dedupeListings(listings).slice(0, 40);
}

function parseAdeleDetail(html, link, searchCity) {
  const text = normalizeUnitText(cleanText(html));
  const title = extractTitle(html) || 'Résidence étudiante';
  const address = extractAddress(text);
  const city = address?.city || searchCity;
  const unitPattern = /\b(studio|t1\s*bis|t1|t2|t3|chambre(?:\s+en\s+colocation)?|appartement\s+colocation(?:\s+\d+p)?)\s*[-:]\s*(\d{1,3}(?:[.,]\d+)?)\s*m2\s*\/\s*(\d[\d\s.,]*)\s*€/gi;
  const listings = [];
  let match;
  while ((match = unitPattern.exec(text)) !== null) {
    const rent = parseMoney(match[3]);
    const area = parseMoney(match[2]);
    if (!rent || rent <= 0 || !area || area <= 0) continue;
    const context = text.slice(Math.max(0, match.index - 180), Math.min(text.length, match.index + 260));
    const positiveAvailability = /disponibilit[eé]\s*[:|\s]{0,18}(?:imm[eé]diate|disponible|(?:janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\s+20\d{2})/i.test(context);
    const clearlyUnavailable = /aucune disponibilit[eé]|\bcomplet\b/i.test(context) && !positiveAvailability;
    if (clearlyUnavailable) continue;
    // Loyer + surface viennent de la fiche; la disponibilité doit toujours être confirmée chez Adele.
    const type = inferHousingType(`${match[1]} ${title}`);
    listings.push({
      id: stableId('adele', link, match[1], rent, area), source: 'Adele', sourceKey: 'adele',
      title: `${title} — ${match[1].replace(/\s+/g, ' ')}`,
      city, searchCity, address: address?.full || city,
      rent, area: { min: area, max: area }, type,
      description: `Offre référencée sur Adele. ${positiveAvailability ? 'Disponibilité indiquée par la source ; à confirmer.' : 'Vérifie la disponibilité et les charges sur la fiche officielle.'}`,
      amenities: [], modes: [], link, availability: positiveAvailability ? 'Disponibilité indiquée' : 'À confirmer sur la fiche',
      residence: title, updatedAt: new Date().toISOString()
    });
  }
  return listings;
}

async function fetchHtml(url, sourceName) {
  await assertRobotsAllows(url);
  const response = await fetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      'User-Agent': 'CampusLogisStudentProject/1.2 (public listing links; source attribution enabled)'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${sourceName} a répondu HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > MAX_HTML_BYTES) throw new Error(`${sourceName} a renvoyé une page trop volumineuse`);
  if (/<title>[^<]*(?:captcha|access denied|robot check)/i.test(body)) throw new Error(`${sourceName} bloque cette requête automatique`);
  return body;
}

async function assertRobotsAllows(rawUrl) {
  const target = new URL(rawUrl);
  const origin = target.origin;
  let pending = robotsCache.get(origin);
  if (!pending) {
    pending = loadRobotsRules(origin);
    robotsCache.set(origin, pending);
  }
  let rules;
  try {
    rules = await pending;
  } catch (error) {
    robotsCache.delete(origin);
    throw error;
  }

  const targetPath = `${target.pathname}${target.search}`;
  const matches = rules.filter((rule) => robotsPathMatches(rule.path, targetPath));
  if (!matches.length) return;
  matches.sort((a, b) => robotsSpecificity(b.path) - robotsSpecificity(a.path));
  const bestSpecificity = robotsSpecificity(matches[0].path);
  const mostSpecific = matches.filter((rule) => robotsSpecificity(rule.path) === bestSpecificity);
  // À longueur identique, Allow prévaut. On n'essaie pas de contourner un refus du site.
  if (!mostSpecific.some((rule) => rule.allow)) {
    throw new Error(`${target.hostname} interdit cette page selon robots.txt ; source ignorée.`);
  }
}

async function loadRobotsRules(origin) {
  let response;
  try {
    response = await fetch(`${origin}/robots.txt`, {
      headers: { 'Accept': 'text/plain', 'User-Agent': 'CampusLogisStudentProject/1.2' },
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS)
    });
  } catch {
    throw new Error(`Impossible de vérifier robots.txt de ${new URL(origin).hostname} ; source ignorée par prudence.`);
  }
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`robots.txt de ${new URL(origin).hostname} répond HTTP ${response.status} ; source ignorée par prudence.`);
  const text = await response.text();
  if (text.length > 200_000) throw new Error(`robots.txt de ${new URL(origin).hostname} trop volumineux ; source ignorée.`);
  return parseRobotsRules(text);
}

function parseRobotsRules(text) {
  const groups = [];
  let current = { agents: [], rules: [] };
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === 'user-agent') {
      if (current.rules.length) {
        groups.push(current);
        current = { agents: [], rules: [] };
      }
      current.agents.push(value.toLowerCase());
    } else if ((directive === 'allow' || directive === 'disallow') && current.agents.length && value) {
      current.rules.push({ allow: directive === 'allow', path: value });
    }
  }
  if (current.agents.length) groups.push(current);
  const exactGroups = groups.filter((group) => group.agents.some((agent) => agent === 'campuslogisstudentproject'));
  const chosenGroups = exactGroups.length ? exactGroups : groups.filter((group) => group.agents.includes('*'));
  return chosenGroups.flatMap((group) => group.rules);
}

function robotsPathMatches(pattern, path) {
  if (!pattern) return false;
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const escaped = body.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try { return new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`).test(path); }
  catch { return false; }
}

function robotsSpecificity(pattern) {
  return pattern.replace(/[\*$]/g, '').length;
}

function collectPropertyCards(html, baseUrl, pathPattern) {
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi;
  const all = [];
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = decodeEntities(match[1]).replace(/&amp;/g, '&');
    let url;
    try { url = new URL(href, baseUrl); } catch { continue; }
    if (!pathPattern.test(url.pathname + url.search)) continue;
    // Aucun lien tiers imprévu n'est autorisé par le scraper.
    const allowed = url.hostname === 'www.immojeune.com' || url.hostname === 'immojeune.com' || url.hostname === 'www.adele.org' || url.hostname === 'adele.org';
    if (!allowed) continue;
    const canonical = `${url.origin}${url.pathname}`;
    all.push({ url: canonical, index: match.index, title: cleanText(match[2]) });
  }
  const firstIndex = new Map();
  for (const item of all) if (!firstIndex.has(item.url)) firstIndex.set(item.url, item.index);
  const urls = Array.from(firstIndex.entries()).sort((a, b) => a[1] - b[1]);
  const result = [];
  for (let i = 0; i < urls.length; i++) {
    const [url, index] = urls[i];
    const nextIndex = urls[i + 1]?.[1] ?? html.length;
    const candidates = all.filter((item) => item.url === url && item.title && !/^(?:voir les locations|voir la r[eé]sidence|image|localisation|ajouter aux favoris)$/i.test(item.title));
    const title = candidates.sort((a, b) => a.index - b.index)[0]?.title || '';
    // Ne conserver que le bloc courant : il contient surface, loyer et localisation sur les pages listées.
    result.push({ url, index, title, segment: html.slice(index, nextIndex) });
  }
  return result;
}

function parseAreaPrice(text) {
  const value = normalizeUnitText(text);
  const patterns = [
    /(\d+(?:[.,]\d+)?)(?:\s*à\s*(\d+(?:[.,]\d+)?))?\s*m2\s*[-–—|]\s*(\d[\d\s.,]*)\s*€/i,
    /(?:à partir de|loyer\s*[:|])\s*(\d[\d\s.,]*)\s*€/i
  ];
  const first = patterns[0].exec(value);
  if (first) return { areaMin: parseMoney(first[1]), areaMax: parseMoney(first[2] || first[1]), price: parseMoney(first[3]) };
  const second = patterns[1].exec(value);
  return second ? { areaMin: 0, areaMax: 0, price: parseMoney(second[1]) } : null;
}

function inferHousingType(value) {
  const text = normalize(value);
  if (/colocation|coloc|chambre partagee/.test(text)) return 'Colocation';
  if (/chambre|room/.test(text)) return 'Chambre';
  if (/\bstudio\b/.test(text)) return 'Studio';
  if (/\bt1\b|\bt2\b|\bt3\b|appartement|duplex|\bf1\b|\bf2\b/.test(text)) return 'T1 / T2';
  return 'Résidence étudiante';
}

function extractAddress(text) {
  const normalized = String(text).replace(/\s+/g, ' ');
  const match = normalized.match(/\b(\d{5})\s+([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3})/);
  if (!match) return null;
  return { postalCode: match[1], city: match[2].trim(), full: `${match[1]} ${match[2].trim()}` };
}

function extractTitle(html) {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) return cleanText(h1[1]).slice(0, 160);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return title ? cleanText(title[1]).split(/[-|–]/)[0].trim().slice(0, 160) : '';
}

function inferTitle(text) {
  const parts = cleanText(text).split(/\s{2,}|\|/).map((part) => part.trim()).filter(Boolean);
  return parts.find((part) => part.length > 5 && part.length < 130 && !/voir les locations|r[eé]sidence [eé]tudiante|ajouter aux favoris/i.test(part)) || '';
}

function normalizeUnitText(text) {
  return String(text).replace(/m\s*²/g, 'm2').replace(/m\s+2\b/gi, 'm2').replace(/\s+/g, ' ').trim();
}

function cleanText(value) {
  const source = String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(source).replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&euro;/gi, '€').replace(/&sup2;/gi, '²')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function parseMoney(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '').replace(/[\s\u00a0\u202f]/g, '').replace(/€/g, '').replace(',', '.');
  const number = Number(text.replace(/[^0-9.]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function slugify(value) {
  return String(value || '').toLocaleLowerCase('fr-FR')
    .replace(/[’']/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stableId(...values) {
  const raw = values.join('|').toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) { hash ^= raw.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `src-${(hash >>> 0).toString(36)}`;
}

function dedupeListings(listings) {
  const seen = new Set();
  return listings.filter((listing) => {
    const key = `${listing.sourceKey}|${listing.link}|${listing.type}|${listing.rent}|${listing.area?.max || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicError(error, source) {
  const message = String(error?.message || 'Erreur inconnue').slice(0, 180);
  return `${source} : ${message}`;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extraHeaders }
  });
}
