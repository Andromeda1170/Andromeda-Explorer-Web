/* ============================================================
 * Navigator — Konstanten und Schwellwerte
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

const { $, $$, escapeHtml, escapeXml, fmtDistance, haversineM, bearing } = AndromedaUtils;
const {
  extractLineCoords, isRoundtripGeometry, computeStats, migrateRoute, fmtDurationHM,
  fmtRegionList, fmtPlaceSequence, renderMarkdown,
} = AndromedaTour;
const ACTIVITY_LABELS = { hiking: "Wanderung", cycling: "Radtour", running: "Lauf" };
const { IS_FIREFOX } = AndromedaUtils;

const UNLOCK_DISTANCE_M = 150;
const CACHE_WARN_THRESHOLD = 20000;
const WP_NOTIFIED_KEY_PREFIX = "tourpack_nav_wp_notified_";
const OVERPASS_RADIUS_M = 5;
const OVERPASS_ENDPOINT = Andromeda.OVERPASS_URL;
const DEDUP_QUERY_WINDOW_MS = 1200;
const DEDUP_QUERY_DISTANCE_M = 20;
const ARROW_SIZE = 26;

const POI_RADIUS_M = 10000;
const POI_MAX_RESULTS = 100;

/* Kategorien für die Umgebungssuche.
 * `query` ist ein OSM-Tag-Filter (key=value), der in der Overpass-Abfrage
 * verwendet wird. */
/* Kategorien für die Umgebungssuche.
 *
 * `query`        OSM-Tag-Filter (key=value).
 * `useRelation`  Ob relation() in die Abfrage aufgenommen wird.
 *                Relationen sind bei Overpass teuer, deshalb nur für
 *                Kategorien, bei denen sie tatsächlich vorkommen:
 *                Campingplätze, große Hotels, Kliniken, Hütten-Komplexe.
 *                Für Node-only-Typen (Trinkwasser, Toiletten, Shops,
 *                Haltestellen) bleiben sie draußen — das spart Zeit
 *                ohne echte Treffer zu verlieren.
 */
const POI_CATEGORIES = [
  { id: "drinking_water",  emoji: "🚰", label: "Trinkwasser",   query: "amenity=drinking_water", useRelation: false },
  { id: "water_point",     emoji: "💧", label: "Wasserstelle",  query: "amenity=water_point",    useRelation: false },
  { id: "supermarket",     emoji: "🛒", label: "Supermarkt",    query: "shop=supermarket",       useRelation: true },
  { id: "bakery",          emoji: "🥖", label: "Bäckerei",      query: "shop=bakery",            useRelation: true },
  { id: "restaurant",      emoji: "🍽️", label: "Restaurant",    query: "amenity=restaurant",     useRelation: true },
  { id: "hotel",           emoji: "🏨", label: "Hotel",         query: "tourism=hotel",          useRelation: true  },
  { id: "apartment",       emoji: "🏢", label: "Apartment",     query: "tourism=apartment",      useRelation: true  },
  { id: "guest_house",     emoji: "🛏️", label: "Pension",       query: "tourism=guest_house",    useRelation: true  },
  { id: "camp_site",       emoji: "🏕️", label: "Campingplatz",  query: "tourism=camp_site",      useRelation: true  },
  { id: "doctors",         emoji: "👨‍⚕️", label: "Arzt",          query: "amenity=doctors",        useRelation: true },
  { id: "hospital",        emoji: "🏥", label: "Krankenhaus",   query: "amenity=hospital",       useRelation: true  },
  { id: "pharmacy",        emoji: "💊", label: "Apotheke",      query: "amenity=pharmacy",       useRelation: true },
  { id: "chemist",         emoji: "🧴", label: "Drogerie",      query: "shop=chemist",           useRelation: true },
  { id: "shelter",         emoji: "⛺", label: "Unterstand",    query: "amenity=shelter",        useRelation: true },
  { id: "wilderness_hut",  emoji: "🏚️", label: "Schutzhütte",   query: "tourism=wilderness_hut", useRelation: true  },
  { id: "alpine_hut",      emoji: "🏔️", label: "Berghütte",     query: "tourism=alpine_hut",     useRelation: true  },
  { id: "toilets",         emoji: "🚻", label: "Toiletten",     query: "amenity=toilets",        useRelation: true },
  { id: "parking",         emoji: "🅿️", label: "Parkplatz",     query: "amenity=parking",        useRelation: true },
  { id: "bus_station",     emoji: "🚌", label: "Bushaltestelle", query: "amenity=bus_station",   useRelation: true },
  { id: "railway_station", emoji: "🚉", label: "Bahnhof",       query: "railway=station",        useRelation: true },
];

/* Liefert das Emoji für die POI-Kategorie, die zu den OSM-Tags passt.
 * Gibt null zurück, wenn kein Match. */
function findPoiEmojiForTags(tags) {
  if (!tags) return null;
  for (const cat of POI_CATEGORIES) {
    const eq = cat.query.indexOf("=");
    const key = cat.query.slice(0, eq);
    const val = cat.query.slice(eq + 1);
    if (tags[key] === val) return cat.emoji;
  }
  return null;
}

const OFF_ROUTE_THRESHOLD_M = 30;
const ROUTE_INTERPOLATION_INTERVAL_M = 10;

const APPROACH_THRESHOLD_M = 50;
const APPROACH_ARRIVAL_M = 50;
const APPROACH_ARRIVAL_START_M = 20;
const APPROACH_ARRIVAL_POINT_M = 25;
const APPROACH_COLOR = "#e67e22";

const TURN_WINDOW_M = 20;
const TURN_MIN_ANGLE_DEG = 25;
const TURN_MIN_SPACING_M = 12;
const TURN_MAX_ANGLE_DEG = 160;
const TURN_LOCAL_MAX_IDX = 2;

// Nachlaufdistanz: Ein Turn bleibt so lange sichtbar, nachdem man ihn
// passiert hat. Kurz halten (5 m), damit zügig auf den nächsten
// umgeschaltet wird.
const TURN_HOLD_M = 5;

// Ab welcher Entfernung (Meter entlang der Route) ein Abbiegehinweis
// erscheint. Danach wird die echte Restdistanz bei jedem GPS-Fix
// metergenau angezeigt.
const TURN_SHOW_DISTANCE_M = { hiking: 200, running: 200, cycling: 1000 };
const TURN_SHOW_DISTANCE_DEFAULT_M = 200;

// Unterhalb dieser Restdistanz (und nach dem Abbiegepunkt) steht nur
// noch die Anweisung, ohne Distanz.
const TURN_NOW_M = 5;

// GPS-Rauschen: Beim Annähern springt die angezeigte Distanz nicht um
// weniger als diesen Wert nach oben. Wer wirklich zurückgeht (mehr
// als das), sieht die größere Zahl sofort.
const TURN_JITTER_M = 8;

// Umdrehen auf der Route: Knick ≥ UTURN_MIN_ANGLE_DEG, und die Route
// läuft danach auf dem Hinweg zurück (Punkte UTURN_CHECK_M vor und
// nach dem Knick liegen höchstens UTURN_RETRACE_M auseinander).
// Serpentinen (zwei getrennte Wege) gelten damit nicht als Umdrehen.
const UTURN_MIN_ANGLE_DEG = 150;
const UTURN_CHECK_M = [20, 40];
const UTURN_RETRACE_M = 4;

// Projektion der GPS-Position auf die Route:
// Segmente bis PROJECTION_TOLERANCE_M weiter weg als das nächste zählen
// als Kandidaten (z. B. Hin- und Rückweg auf derselben Straße).
const PROJECTION_TOLERANCE_M = 20;

// Falsche Richtung: so viele Meter netto entgegen der Route, dann
// erscheint „Umdrehen“.
const WRONG_WAY_M = 25;
