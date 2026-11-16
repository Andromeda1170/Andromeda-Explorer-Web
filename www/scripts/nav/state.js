/* ============================================================
 * Navigator — Laufzeit-Zustand
 * Teil von navigation.html. Alle Navigator-Dateien teilen sich
 * den globalen Gültigkeitsbereich und werden in fester
 * Reihenfolge geladen (siehe navigation.html).
 * ============================================================ */
"use strict";

const app = {
  map: null,
  baseLayers: {}, overlayLayers: {},
  activeBaseLayer: null, activeBaseKey: "osm",
  activeOverlays: { hiking: false, cycling: false },

  routeLayer: null, arrowLayer: null, waypointLayer: null,

  currentRouteId: null, tourpackData: null, imageURLs: [],

  userMarker: null, userAccuracy: null, userHeading: null,
  userLastPos: null, userPrevPos: null, userWatchId: null,
  geoActive: false, followActive: true,
  _gpsReady: false, _gpsHintTimer: null, _gpsFailTimer: null, _lastAccuracy: null,

  compassSupported: false, compassActive: false,
  compassOrientationHandler: null, compassAbsoluteHandler: null,
  _unwrappedHeading: null,
  _unwrappedMapBearing: null,
  _endingNavigation: false,

  routeLatLngs: [], routeCumDist: [], waypointsWithDist: [],

  elevationData: null, elevationOpen: false,
  elevationDataType: "tour",
  elevHoverMarker: null,

  tagSegments: null,
  highlightLayer: null,
  activeHighlightCat: null,

  lastDistanceToRoute: null,
  // Projektions-Zustand, getrennt für Typ 1 (Tour) und Typ 2 (Zustieg).
  // Jede Navigation hat ihren eigenen lastIndex, damit sie sich nicht
  // gegenseitig beeinflussen, wenn beide gleichzeitig aktiv sind.
  // Projektions-Zustand je Navigationstyp (siehe projectOntoRoute)
  _projStateTour:     { lastIndex: null, lastCum: null, backM: 0, wrongWay: false },
  _projStateApproach: { lastIndex: null, lastCum: null, backM: 0, wrongWay: false },

  turns: [],
  turnSource: null,   // "instructions" | "geometry"

  waypointNotified: new Set(),

  markers: [], searchMarkerLayer: null, _markerIdCounter: 0, _lastMarkerColor: null,
  poiLayer: null, _poiMarkers: [], _poiActiveCategory: null,

  placeDetailLat: null, placeDetailLon: null,
  searchAbort: null, lastOverpassAt: 0,

  _suppressContextmenuUntil: 0,
  _lastQueryAt: 0, _lastQueryLat: null, _lastQueryLon: null,

  objectQueryChoices: [], objectQueryLat: null, objectQueryLon: null,
  activeMarkerId: null,

  _restoring: false, _suppressMarkerSave: false,
  _suppressZoomRelease: false, _suppressZoomReleaseTimer: null,

  approachRoute: {
    active: false, mode: null, layer: null, arrowLayer: null,
    latlngs: [], cumDist: [], turns: [], turnSource: null, activity: null,
    targetIsStart: false, targets: [], finalTarget: null,
  },
  _promptedForApproach: false,
  _approachActivity: null,
  _pendingCustomTarget: null,
  smoothedSpeedKmh: 0,
  _speedInitialized: false,
  customStart: null, customStartMarker: null,
  lastDistanceToApproach: null,
};

/* Höhenprofil-Panel und Wege-Hervorhebung (gemeinsame Module).
 * Der Höhenprofil-Knopf ist aktiv, sobald Tour ODER Zustieg da ist;
 * welche Daten gezeigt werden, entscheidet toggleElevation(). */
const elevPanel = AndromedaElevation.createPanel({
  state: app,
  getMap: () => app.map,
  hasData: () => !!app.elevationData ||
    (app.approachRoute.active && app.approachRoute.latlngs.length > 0) ||
    app.routeLatLngs.length > 0,
  markerClass: "elev-hover-marker",
  markerSize: 18,
});
const wayHighlight = AndromedaWayStats.createHighlighter({
  getMap: () => app.map,
  getLayer: () => app.highlightLayer,
  getSegments: () => app.tagSegments,
  getColor: () => settings.routeColor || "#2a6fbf",
});
