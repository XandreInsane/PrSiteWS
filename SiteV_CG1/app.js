/* CampusLogis V1.1 — annonces CROUS en direct, autocomplétion et interactions UI. */
'use strict';

const CONFIG = Object.freeze({
  crousToolId: 47, // Offre complémentaire CROUS 2026-2027 au 12/10/2026
  crousApi: 'https://trouverunlogement.lescrous.fr/api/fr/search/47',
  crousSearchPage: 'https://trouverunlogement.lescrous.fr/tools/47/search',
  crousBase: 'https://trouverunlogement.lescrous.fr',
  citiesApi: 'https://geo.api.gouv.fr/communes',
  schoolsApi: 'https://data.enseignementsup-recherche.gouv.fr/api/explore/v2.1/catalog/datasets/fr-esr-principaux-etablissements-enseignement-superieur/records',
  schoolDataset: 'fr-esr-principaux-etablissements-enseignement-superieur',
  pageSize: 100
});

const STORAGE_KEYS = {
  notes: 'campuslogis.v1.notes',
  favorites: 'campuslogis.v1.favorites'
};

const SOURCE_CONFIG = {
  leboncoin: { domain: 'leboncoin.fr', title: 'Leboncoin' },
  seloger: { domain: 'seloger.com', title: 'SeLoger' },
  crous: { domain: 'trouverunlogement.lescrous.fr', title: 'Logement CROUS' },
  pap: { domain: 'pap.fr', title: 'PAP' },
  lokaviz: { domain: 'lokaviz.fr', title: 'Lokaviz' },
  studapart: { domain: 'studapart.com', title: 'Studapart' }
};

const elements = {
  form: document.querySelector('#search-form'),
  city: document.querySelector('#city'),
  school: document.querySelector('#school'),
  citySuggestions: document.querySelector('#city-suggestions'),
  schoolSuggestions: document.querySelector('#school-suggestions'),
  rent: document.querySelector('#rent'),
  rentValue: document.querySelector('#rent-value'),
  transport: document.querySelector('#transport'),
  sort: document.querySelector('#sort'),
  listingGrid: document.querySelector('#listing-grid'),
  resultCount: document.querySelector('#result-count'),
  resultsSubtitle: document.querySelector('#results-subtitle'),
  emptyState: document.querySelector('#empty-state'),
  emptyTitle: document.querySelector('#empty-title'),
  emptyMessage: document.querySelector('#empty-message'),
  resetButton: document.querySelector('#reset-filters'),
  searchButton: document.querySelector('.search-button'),
  liveStatus: document.querySelector('#live-status'),
  toast: document.querySelector('#toast')
};

let allListings = [];
let hasSearched = false;
let lastLoadError = '';
let toastTimeout = null;
let citySuggestTimer = null;
let schoolSuggestTimer = null;
const cityInfo = new Map();
let savedNotes = readStorage(STORAGE_KEYS.notes, {});
let favorites = new Set(readStorage(STORAGE_KEYS.favorites, []));

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.warn(`Stockage local indisponible (${key}).`, error);
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`Impossible d'enregistrer ${key}.`, error);
    showToast('Le navigateur ne permet pas cet enregistrement.');
    return false;
  }
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr-FR')
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function safeExternalUrl(value, fallback = CONFIG.crousSearchPage) {
  try {
    const url = new URL(value, window.location.href);
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function euro(amount) {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(Number(amount) || 0);
}

function showToast(message) {
  if (!elements.toast) return;
  window.clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  toastTimeout = window.setTimeout(() => elements.toast.classList.remove('is-visible'), 2600);
}

function setLiveStatus(message, kind = 'info') {
  if (!elements.liveStatus) return;
  elements.liveStatus.classList.remove('is-error', 'is-loading', 'is-success');
  if (kind === 'error') elements.liveStatus.classList.add('is-error');
  if (kind === 'loading') elements.liveStatus.classList.add('is-loading');
  if (kind === 'success') elements.liveStatus.classList.add('is-success');
  const paragraph = elements.liveStatus.querySelector('p');
  if (paragraph) paragraph.textContent = message;
}

function setLoading(isLoading) {
  elements.searchButton.disabled = isLoading;
  elements.searchButton.classList.toggle('is-loading', isLoading);
  elements.searchButton.setAttribute('aria-busy', String(isLoading));
  elements.searchButton.innerHTML = isLoading
    ? '<span class="button-spinner" aria-hidden="true"></span> Recherche…'
    : '<span aria-hidden="true">⌕</span> Rechercher';
}

function selectedHousingTypes() {
  return Array.from(document.querySelectorAll('input[name="housing"]:checked')).map((input) => input.value);
}

function getFilters() {
  return {
    city: elements.city.value.trim(),
    school: elements.school.value.trim(),
    rent: Number(elements.rent.value),
    types: selectedHousingTypes(),
    transport: elements.transport.value,
    sort: elements.sort.value
  };
}

function extractCity(address = '') {
  const text = String(address).replace(/\s+/g, ' ').trim();
  // Une adresse CROUS contient généralement le code postal puis la commune.
  const match = text.match(/\b\d{5}\s+(.+)$/);
  if (!match) return text;
  return match[1]
    .replace(/\s+(?:CEDEX|Cedex)\b.*$/i, '')
    .replace(/\s+\d{1,2}(?:er|e|ème)?\s*(?:arrondissement)?$/i, '')
    .trim();
}

function getOccupationModes(item) {
  const modes = Array.isArray(item?.occupationModes) ? item.occupationModes : [];
  return modes.map((mode) => ({
    type: String(mode?.type || ''),
    label: mode?.label || mode?.name || '',
    rent: Number(mode?.rent?.min ?? mode?.rent?.max ?? 0) / 100,
    rentMax: Number(mode?.rent?.max ?? mode?.rent?.min ?? 0) / 100
  })).filter((mode) => mode.rent > 0);
}

function inferHousingType(item, modes, area) {
  const label = normalize(`${item?.label || ''} ${item?.residence?.label || ''} ${item?.description || ''} ${item?.short_desc || ''}`);
  const modeNames = modes.map((mode) => normalize(mode.type)).join(' ');
  if (label.includes('colocation') || label.includes('partager') || (modeNames.includes('house sharing') && !modeNames.includes('alone'))) return 'Colocation';
  if (label.includes('studio') || label.includes('kitchenette')) return 'Studio';
  if (/(^|\s)(t|f)\s?[12](\s|$)/.test(label) || label.includes('t1 bis') || label.includes('t2') || (area.min >= 18 && area.max > 0)) return 'T1 / T2';
  if (label.includes('chambre') || (area.max > 0 && area.max <= 14)) return 'Chambre';
  return 'Résidence étudiante';
}

function parseCrousItem(item) {
  const address = item?.residence?.address || item?.address || '';
  const city = extractCity(address);
  const modes = getOccupationModes(item);
  const areaData = item?.area || {};
  const area = {
    min: Number(areaData.min ?? item?.areaMin ?? 0),
    max: Number(areaData.max ?? item?.areaMax ?? areaData.min ?? 0)
  };
  const id = item?.id ?? item?.accommodationId;
  const amenitiesRaw = item?.equipments ?? item?.equipment ?? item?.services ?? [];
  const amenities = Array.isArray(amenitiesRaw)
    ? amenitiesRaw.map((entry) => typeof entry === 'string' ? entry : (entry?.label || entry?.name || '')).filter(Boolean)
    : typeof amenitiesRaw === 'string' ? amenitiesRaw.split(/[,;·]/).map((part) => part.trim()).filter(Boolean)
      : Object.values(amenitiesRaw || {}).flat().filter((value) => typeof value === 'string');
  const rent = modes.length ? Math.min(...modes.map((mode) => mode.rent)) : 0;
  const link = id != null ? `${CONFIG.crousBase}/tools/${CONFIG.crousToolId}/accommodations/${encodeURIComponent(id)}` : CONFIG.crousSearchPage;
  return {
    id: `crous-${id ?? normalize(`${address}-${item?.label || ''}`)}`,
    sourceId: id,
    source: 'CROUS',
    title: item?.label || item?.title || 'Logement étudiant CROUS',
    residence: item?.residence?.label || item?.residenceLabel || '',
    city,
    address,
    rent,
    modes,
    area,
    type: inferHousingType(item, modes, area),
    description: item?.description || item?.short_desc || item?.descriptionShort || '',
    amenities: amenities.slice(0, 5),
    link,
    updatedAt: new Date().toISOString()
  };
}

function buildCrousPayload() {
  return {
    idTool: CONFIG.crousToolId,
    need_aggregation: false,
    page: 1,
    pageSize: CONFIG.pageSize,
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
}

async function parseJsonResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) throw new Error(`La source a répondu HTTP ${response.status}.`);
  if (!contentType.includes('json')) throw new Error('La route API n’a pas renvoyé de données JSON.');
  const data = await response.json();
  if (data?.errors) throw new Error('Le portail CROUS a refusé la recherche.');
  return data;
}

async function fetchViaPagesFunction(payload) {
  // En ligne, Cloudflare Pages Functions sert de relais same-origin pour éviter le blocage CORS.
  const response = await fetch('/api/logements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/ld+json, application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store'
  });
  return parseJsonResponse(response);
}

async function fetchDirectFromCrous(payload) {
  const response = await fetch(CONFIG.crousApi, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/ld+json, application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    mode: 'cors'
  });
  return parseJsonResponse(response);
}

function extractApiItems(data) {
  const items = data?.results?.items || data?.results?.results || data?.items || data?.results;
  return Array.isArray(items) ? items : [];
}

async function fetchRealListings() {
  const payload = buildCrousPayload();
  let lastError = null;

  // Hosted build: try the free serverless proxy first. When opening index.html directly,
  // skip the relative route and try the source API itself.
  if (window.location.protocol !== 'file:') {
    try {
      const proxiedData = await fetchViaPagesFunction(payload);
      return extractApiItems(proxiedData).map(parseCrousItem).filter((item) => item.sourceId != null && item.rent > 0);
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const directData = await fetchDirectFromCrous(payload);
    return extractApiItems(directData).map(parseCrousItem).filter((item) => item.sourceId != null && item.rent > 0);
  } catch (error) {
    lastError = error;
  }

  const err = new Error(lastError?.message || 'Impossible de joindre le portail CROUS.');
  err.cause = lastError;
  throw err;
}

function bestModeForFilters(listing, filters) {
  const modes = listing.modes;
  if (!modes.length) return null;
  const hasColocationMode = filters.types.includes('Colocation') && listing.type === 'Colocation';
  if (hasColocationMode) {
    const shared = modes.find((mode) => normalize(mode.type).includes('house sharing'));
    if (shared) return shared;
  }
  const alone = modes.find((mode) => normalize(mode.type) === 'alone');
  if (alone) return alone;
  return modes.slice().sort((a, b) => a.rent - b.rent)[0];
}

function getVisibleListings() {
  const filters = getFilters();
  if (!filters.city) return [];
  const cityQuery = normalize(filters.city);
  const selectedTypes = filters.types;
  const visible = allListings.map((listing) => ({
    ...listing,
    displayMode: bestModeForFilters(listing, filters),
    displayPrice: (bestModeForFilters(listing, filters)?.rent || listing.rent)
  })).filter((listing) => {
    const listingCity = normalize(listing.city);
    const cityMatches = listingCity === cityQuery || listingCity.startsWith(`${cityQuery} `);
    if (!cityMatches || !selectedTypes.length) return false;
    if (!selectedTypes.includes(listing.type)) return false;
    return listing.displayPrice > 0 && listing.displayPrice <= filters.rent;
  });

  return visible.sort((a, b) => {
    switch (filters.sort) {
      case 'price-asc': return a.displayPrice - b.displayPrice;
      case 'price-desc': return b.displayPrice - a.displayPrice;
      case 'surface-desc': return (b.area.max || b.area.min) - (a.area.max || a.area.min);
      default: return a.displayPrice - b.displayPrice;
    }
  });
}

function buildSearchUrl(sourceKey, filters, listing = null) {
  if (sourceKey === 'crous') {
    return listing ? safeExternalUrl(listing.link) : buildCrousSearchUrl(filters.city);
  }
  const source = SOURCE_CONFIG[sourceKey];
  if (!source) return '#';
  const type = listing?.type || (filters.types.length === 1 ? filters.types[0] : 'logement étudiant');
  const query = `site:${source.domain} ${filters.city || ''} ${type} location étudiant`.trim();
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  return url.toString();
}

function buildCrousSearchUrl(city) {
  const url = new URL(CONFIG.crousSearchPage);
  const info = cityInfo.get(normalize(city));
  const coords = info?.coordinates;
  if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
    // Le portail officiel emploie bounds=ouest_nord_est_sud ; le lien reste une recherche officielle.
    const latDelta = 0.045;
    const lonDelta = 0.065;
    url.searchParams.set('bounds', `${coords.lon - lonDelta}_${coords.lat + latDelta}_${coords.lon + lonDelta}_${coords.lat - latDelta}`);
    url.searchParams.set('locationName', city);
  }
  return url.toString();
}

function buildDirectionsUrl(listing, filters) {
  const origin = listing.address || `${listing.city}, France`;
  const destination = filters.school ? `${filters.school}, ${filters.city}, France` : `${filters.city}, France`;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  url.searchParams.set('travelmode', filters.transport);
  return url.toString();
}

function transportLabel(mode) {
  return ({ transit: 'transports en commun', walking: 'à pied', bicycling: 'à vélo', driving: 'en voiture' })[mode] || 'trajet';
}

function surfaceLabel(area) {
  if (!area || (!area.min && !area.max)) return 'Surface non précisée';
  if (area.min && area.max && area.min !== area.max) return `De ${euro(area.min)} à ${euro(area.max)} m²`;
  return `${euro(area.max || area.min)} m²`;
}

function renderCard(listing, filters) {
  const isFavorite = favorites.has(listing.id);
  const note = savedNotes[listing.id] || '';
  const officialUrl = safeExternalUrl(listing.link);
  const directionsUrl = buildDirectionsUrl(listing, filters);
  const area = surfaceLabel(listing.area);
  const occupancy = listing.displayMode?.type === 'house_sharing' ? 'Tarif colocation' : 'Tarif individuel';
  const amenities = listing.amenities.length ? `<div class="listing-amenities">${listing.amenities.slice(0, 4).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : '';
  const description = listing.description
    ? escapeHtml(listing.description.length > 220 ? `${listing.description.slice(0, 220)}…` : listing.description)
    : 'Offre de logement étudiant publiée par le CROUS. Consulte la fiche officielle pour les conditions d’attribution, les équipements et les disponibilités exactes.';
  const residence = listing.residence && normalize(listing.residence) !== normalize(listing.title) ? `<p class="listing-residence">${escapeHtml(listing.residence)}</p>` : '';

  return `
    <article class="listing-card real-listing" data-listing-id="${escapeHtml(listing.id)}">
      <div class="listing-visual real-listing-visual">
        <span class="visual-label live-label"><span class="available-dot"></span> Offre CROUS</span>
        <span class="real-visual-house" aria-hidden="true">⌂</span>
        <button class="favorite-button ${isFavorite ? 'is-favorite' : ''}" type="button" data-action="favorite" data-id="${escapeHtml(listing.id)}" aria-label="${isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}" aria-pressed="${isFavorite}">${isFavorite ? '♥' : '♡'}</button>
      </div>
      <div class="listing-body">
        <div class="listing-meta-top"><span class="housing-tag">${escapeHtml(listing.type)}</span><span class="listing-price">${euro(listing.displayPrice)} € <small>/ mois</small></span></div>
        <h3>${escapeHtml(listing.title)}</h3>
        ${residence}
        <div class="listing-location"><span class="pin" aria-hidden="true">⌖</span>${escapeHtml(listing.address || listing.city)}</div>
        <p class="listing-description">${description}</p>
        <div class="listing-specs"><span><b>↔</b> ${escapeHtml(area)}</span><span><b>⌂</b> ${escapeHtml(occupancy)}</span><span><b>●</b> Offre listée par le CROUS</span></div>
        ${amenities}
        <div class="listing-actions">
          <a class="listing-link" href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer">Fiche officielle CROUS <span aria-hidden="true">↗</span></a>
          <button class="notes-toggle" type="button" data-action="toggle-note" data-id="${escapeHtml(listing.id)}" aria-expanded="false">${note ? 'Modifier ma note' : '＋ Note'}</button>
        </div>
        <div class="notes-panel" data-notes-panel="${escapeHtml(listing.id)}" hidden>
          <label for="note-${escapeHtml(listing.id)}">Tes notes personnelles</label>
          <textarea id="note-${escapeHtml(listing.id)}" data-note-input="${escapeHtml(listing.id)}" maxlength="1200" placeholder="Ex. : vérifier les charges, appeler la résidence…">${escapeHtml(note)}</textarea>
          <div class="notes-bottom"><span class="note-local">Privé · enregistré sur cet appareil</span><button class="save-note" type="button" data-action="save-note" data-id="${escapeHtml(listing.id)}">Enregistrer</button></div>
        </div>
        ${note ? `<p class="saved-note-preview"><strong>Ta note :</strong> ${escapeHtml(note.length > 145 ? `${note.slice(0, 145)}…` : note)}</p>` : ''}
        <div class="route-link-row"><a href="${escapeHtml(directionsUrl)}" target="_blank" rel="noopener noreferrer">Voir l’itinéraire ${escapeHtml(transportLabel(filters.transport))} <span aria-hidden="true">↗</span></a></div>
      </div>
    </article>`;
}

function renderListings() {
  const filters = getFilters();
  const listings = getVisibleListings();
  elements.rentValue.innerHTML = `${euro(filters.rent)} € <small>/ mois</small>`;
  updateRangeFill();
  elements.resultCount.textContent = String(listings.length);
  if (!hasSearched && !filters.city) {
    elements.resultsSubtitle.textContent = 'Renseigne une ville pour rechercher les offres CROUS disponibles.';
  } else {
    elements.resultsSubtitle.textContent = `${listings.length} offre${listings.length > 1 ? 's' : ''} CROUS correspondant à ${filters.city}${filters.school ? ` · destination : ${filters.school}` : ''}.`;
  }
  elements.listingGrid.innerHTML = listings.map((listing) => renderCard(listing, filters)).join('');
  elements.emptyState.hidden = listings.length > 0;
  elements.listingGrid.hidden = listings.length === 0;
  if (listings.length > 0) {
    elements.emptyTitle.textContent = 'Aucune autre offre ?';
    elements.emptyMessage.textContent = 'Les cartes affichées proviennent du portail CROUS et ne sont pas fictives. Élargis les critères ou explore les autres sites ci-dessous pour plus de choix.';
  } else if (lastLoadError && hasSearched) {
    elements.emptyTitle.textContent = 'Le portail de logements est inaccessible depuis cette ouverture';
    elements.emptyMessage.innerHTML = 'Aucune annonce de remplacement n’est affichée. Essaie le lien officiel du CROUS ou déploie le projet avec la fonction API fournie dans le dossier <code>functions/</code> pour contourner les restrictions CORS.';
  } else if (!filters.city) {
    elements.emptyTitle.textContent = 'Commence par ta ville d’études';
    elements.emptyMessage.textContent = 'Saisis au moins une ville puis clique sur Rechercher. Le site affiche uniquement des offres réelles chargées à la demande.';
  } else {
    elements.emptyTitle.textContent = 'Aucune offre CROUS avec ces critères';
    elements.emptyMessage.textContent = 'Le portail ne renvoie pas d’offre disponible dans cette ville pour le budget et les types sélectionnés. Essaie d’augmenter le budget, de cocher d’autres types, ou de consulter les sites complémentaires.';
  }
  updateSourceLinks();
}

function updateRangeFill() {
  const min = Number(elements.rent.min);
  const max = Number(elements.rent.max);
  const value = Number(elements.rent.value);
  const percent = ((value - min) / (max - min)) * 100;
  elements.rent.style.background = `linear-gradient(to right, #4b8266 ${percent}%, #e0e8df ${percent}%)`;
}

function updateSourceLinks() {
  const filters = getFilters();
  document.querySelectorAll('[data-source]').forEach((link) => {
    link.href = buildSearchUrl(link.dataset.source, filters);
  });
}

function toggleFavorite(id) {
  if (favorites.has(id)) {
    favorites.delete(id);
    showToast('Retiré des favoris sur cet appareil.');
  } else {
    favorites.add(id);
    showToast('Ajouté aux favoris sur cet appareil.');
  }
  writeStorage(STORAGE_KEYS.favorites, Array.from(favorites));
  renderListings();
}

function toggleNote(id, button) {
  const panel = document.querySelector(`[data-notes-panel="${CSS.escape(id)}"]`);
  if (!panel) return;
  const willOpen = panel.hidden;
  panel.hidden = !willOpen;
  button.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) panel.querySelector('textarea')?.focus();
}

function saveNote(id) {
  const textarea = document.querySelector(`[data-note-input="${CSS.escape(id)}"]`);
  if (!textarea) return;
  const value = textarea.value.trim();
  if (value) savedNotes[id] = value;
  else delete savedNotes[id];
  if (!writeStorage(STORAGE_KEYS.notes, savedNotes)) return;
  showToast(value ? 'Note enregistrée sur cet appareil.' : 'Note supprimée.');
  renderListings();
  const panel = document.querySelector(`[data-notes-panel="${CSS.escape(id)}"]`);
  const button = document.querySelector(`[data-action="toggle-note"][data-id="${CSS.escape(id)}"]`);
  if (panel && button) {
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    panel.querySelector('textarea')?.focus();
  }
}

function resetFilters() {
  elements.rent.value = '650';
  document.querySelectorAll('input[name="housing"]').forEach((input) => { input.checked = true; });
  elements.sort.value = 'recommended';
  renderListings();
  showToast('Filtres réinitialisés.');
}

function getCityCoordinates(record) {
  const centre = record?.centre;
  if (centre?.coordinates && centre.coordinates.length >= 2) {
    return { lon: Number(centre.coordinates[0]), lat: Number(centre.coordinates[1]) };
  }
  if (Array.isArray(centre) && centre.length >= 2) {
    // Format possible [latitude, longitude] sur certains endpoints géographiques.
    return { lat: Number(centre[0]), lon: Number(centre[1]) };
  }
  return null;
}

async function fetchCitySuggestions(term) {
  if (term.length < 2) { elements.citySuggestions.replaceChildren(); return; }
  const url = new URL(CONFIG.citiesApi);
  url.searchParams.set('nom', term);
  url.searchParams.set('fields', 'nom,code,centre,population');
  url.searchParams.set('boost', 'population');
  url.searchParams.set('limit', '10');
  try {
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const records = await response.json();
    elements.citySuggestions.replaceChildren();
    records.forEach((record) => {
      const option = document.createElement('option');
      option.value = record.nom;
      elements.citySuggestions.append(option);
      cityInfo.set(normalize(record.nom), { name: record.nom, coordinates: getCityCoordinates(record), code: record.code });
    });
    updateSourceLinks();
  } catch (error) {
    console.warn('Suggestions de villes non disponibles.', error);
  }
}

async function fetchSchoolSuggestions(term) {
  if (term.length < 2) { elements.schoolSuggestions.replaceChildren(); return; }
  const url = new URL(CONFIG.schoolsApi);
  url.searchParams.set('where', `search(uo_lib, ${JSON.stringify(term)})`);
  url.searchParams.set('limit', '12');
  url.searchParams.set('select', 'uo_lib,nom_court,commune,adresse,site_internet');
  try {
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const records = (data.results || []).map((entry) => entry.fields || entry).filter((entry) => entry.uo_lib);
    const cityTerm = normalize(elements.city.value);
    records.sort((a, b) => {
      const aLocal = cityTerm && normalize(a.commune || '').includes(cityTerm) ? 0 : 1;
      const bLocal = cityTerm && normalize(b.commune || '').includes(cityTerm) ? 0 : 1;
      return aLocal - bLocal;
    });
    elements.schoolSuggestions.replaceChildren();
    records.forEach((record) => {
      const option = document.createElement('option');
      option.value = record.commune ? `${record.uo_lib} — ${record.commune}` : record.uo_lib;
      elements.schoolSuggestions.append(option);
    });
  } catch (error) {
    console.warn('Suggestions d’établissements non disponibles.', error);
  }
}

async function resolveCityCoordinates(city) {
  const known = cityInfo.get(normalize(city));
  if (known?.coordinates) return known.coordinates;
  const url = new URL(CONFIG.citiesApi);
  url.searchParams.set('nom', city);
  url.searchParams.set('fields', 'nom,code,centre,population');
  url.searchParams.set('boost', 'population');
  url.searchParams.set('limit', '5');
  try {
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const records = await response.json();
    const exact = records.find((record) => normalize(record.nom) === normalize(city)) || records[0];
    if (!exact) return null;
    const info = { name: exact.nom, coordinates: getCityCoordinates(exact), code: exact.code };
    cityInfo.set(normalize(exact.nom), info);
    return info.coordinates;
  } catch {
    return null;
  }
}

// Le bouton Rechercher recharge toujours les offres officielles, sans mélanger de données de démonstration.
elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const filters = getFilters();
  if (!filters.city) {
    elements.city.focus();
    showToast('Renseigne d’abord la ville d’études.');
    return;
  }

  hasSearched = true;
  lastLoadError = '';
  renderListings();
  setLoading(true);
  setLiveStatus('Connexion au portail officiel du CROUS…', 'loading');

  // Résoudre les coordonnées en parallèle améliore aussi le lien de recherche officiel.
  const [, listingsResult] = await Promise.allSettled([resolveCityCoordinates(filters.city), fetchRealListings()]);
  setLoading(false);
  if (listingsResult.status === 'fulfilled') {
    allListings = listingsResult.value;
    lastLoadError = '';
    const matchingCount = getVisibleListings().length;
    setLiveStatus(`${matchingCount} offre(s) correspondent à ${filters.city}. Données reçues du portail officiel à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} ; vérifie la disponibilité finale sur chaque fiche.`, 'success');
  } else {
    lastLoadError = listingsResult.reason?.message || 'Erreur réseau';
    allListings = [];
    setLiveStatus('Impossible de charger les offres depuis cette ouverture du navigateur. Aucune annonce fictive ne sera affichée. Le lien officiel reste accessible ci-dessous.', 'error');
  }
  renderListings();
  document.querySelector('#results-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

elements.city.addEventListener('input', () => {
  window.clearTimeout(citySuggestTimer);
  const term = elements.city.value.trim();
  citySuggestTimer = window.setTimeout(() => fetchCitySuggestions(term), 180);
  updateSourceLinks();
});

elements.school.addEventListener('input', () => {
  window.clearTimeout(schoolSuggestTimer);
  const term = elements.school.value.trim();
  schoolSuggestTimer = window.setTimeout(() => fetchSchoolSuggestions(term), 220);
  updateSourceLinks();
});

elements.rent.addEventListener('input', renderListings);
elements.sort.addEventListener('change', renderListings);
elements.transport.addEventListener('change', renderListings);
document.querySelectorAll('input[name="housing"]').forEach((input) => input.addEventListener('change', renderListings));
elements.resetButton.addEventListener('click', resetFilters);

elements.listingGrid.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'favorite') toggleFavorite(id);
  if (action === 'toggle-note') toggleNote(id, button);
  if (action === 'save-note') saveNote(id);
});

// Affiche immédiatement les bons liens externes et le loyer du curseur ; aucune donnée fictive n'est initialisée.
updateRangeFill();
updateSourceLinks();
renderListings();
