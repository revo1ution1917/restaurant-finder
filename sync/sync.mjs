#!/usr/bin/env node
/**
 * sync.mjs — Pulls places from a shared Google Maps list and writes data.json.
 *
 * Usage:
 *   LIST_URL="https://maps.app.goo.gl/..." GOOGLE_API_KEY="..." node sync/sync.mjs
 *
 * Env vars:
 *   LIST_URL        (required) shared Google Maps list link
 *   GOOGLE_API_KEY  (optional) Places API (New) key — enables rating/price/cuisine enrichment
 *   OUT             (optional) output path, default ./data.json
 *
 * Behaviour:
 *   - Parses the shared-list page (unofficial; fails loudly if format changes).
 *   - Enriches NEW places only (cached by stable id in existing data.json).
 *   - Applies manual overrides from overlay.json if present (keyed by id).
 *   - Sanity check: refuses to write if place count collapses vs previous run.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || resolve(ROOT, "data.json");
const OVERLAY = resolve(ROOT, "overlay.json");
const LIST_URL = process.env.LIST_URL;
const API_KEY = process.env.GOOGLE_API_KEY || "";

if (!LIST_URL) {
  console.error("FATAL: LIST_URL env var not set.");
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
// Full browser-like header set: Google serves the data-bearing page to real
// browsers but a JS shell to bare fetches from datacenter IPs.
const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Sec-Ch-Ua": '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};
const CONSENT_COOKIE =
  "CONSENT=YES+cb.20240101-00-p0.en+FX+000; SOCS=CAESHAgBEhJnd3NfMjAyNDAxMDEtMF9SQzIaAmVuIAEaBgiA_LyaBg";

// ---------------------------------------------------------------- fetch page

function diagnose(label, res, html) {
  const host = (() => { try { return new URL(res.url).host; } catch { return "?"; } })();
  console.log(
    `[${label}] status=${res.status} host=${host} len=${html.length} ` +
    `marker=${html.includes("APP_INITIALIZATION_STATE")} ` +
    `consent=${host.includes("consent") || html.includes("consent.google.com")} ` +
    `sorry=${res.url.includes("/sorry/") || html.includes("unusual traffic")}`
  );
}

// The maps.app.goo.gl short link sometimes returns a 200 interstitial page
// (no HTTP redirect) for non-browser clients. The real Maps URL is embedded
// in that page — dig it out so we can follow it manually.
function extractMapsUrl(html) {
  const unescaped = html
    .replace(/\\\//g, "/")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/g, "&");
  // Prefer a meta-refresh target if present.
  const meta = unescaped.match(/http-equiv=["']refresh["'][^>]*url=([^"'>]+)/i);
  if (meta) return meta[1];
  const m = unescaped.match(/https:\/\/www\.google\.com\/maps\/[^"'<>\s\\]+/);
  return m ? m[0] : null;
}

function withParam(u, kv) {
  return u + (u.includes("?") ? "&" : "?") + kv;
}

async function fetchListPage(url) {
  const variants = [
    { label: "no-cookie", headers: BROWSER_HEADERS },
    { label: "consent-cookie", headers: { ...BROWSER_HEADERS, Cookie: CONSENT_COOKIE } },
  ];
  // ucbcb=1 tells Google to skip the consent/deep-link interstitial and serve
  // the data-bearing page to cookie-less clients.
  const candidates = [withParam(url, "ucbcb=1"), url];
  if (url.startsWith("https://www.google.com/")) {
    candidates.push(
      withParam(url.replace("https://www.google.com/", "https://google.com/"), "ucbcb=1")
    );
  }

  for (const cand of candidates) {
    for (const v of variants) {
      let res = await fetch(cand, { headers: v.headers, redirect: "follow" });
      let html = await res.text();
      diagnose(`fetch/${v.label}`, res, html);

      // Landed on a shortlink/deep-link interstitial? Follow the embedded URL.
      if (res.ok && !html.includes("APP_INITIALIZATION_STATE")) {
        const target = extractMapsUrl(html);
        if (target && target !== cand) {
          res = await fetch(withParam(target, "ucbcb=1"), { headers: v.headers, redirect: "follow" });
          html = await res.text();
          diagnose(`follow/${v.label}`, res, html);
        }
      }
      if (res.ok && html.includes("APP_INITIALIZATION_STATE")) {
        return { html, finalUrl: res.url };
      }
    }
  }
  throw new Error("Could not obtain the data-bearing list page (see diagnostics above)");
}

// ------------------------------------------------------------------- parsing
// The shared-list page embeds the list payload in a script tag
// (window.APP_INITIALIZATION_STATE = [...]). We extract that JSON and
// recursively scan it for place-like records. This is deliberately heuristic
// so minor schema shuffles don't break it; if Google changes things
// fundamentally, we exit(1) and the GitHub Action notifies you.

// Find the end of the JSON array that starts at html[start] by tracking
// bracket depth (string-aware). Robust against whatever follows the blob.
function sliceJsonArray(html, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

function extractInitState(html) {
  const marker = "window.APP_INITIALIZATION_STATE=";
  const i = html.indexOf(marker);
  if (i === -1) {
    console.log("[parse] APP_INITIALIZATION_STATE marker not found");
    return null;
  }
  const start = i + marker.length;
  const raw = sliceJsonArray(html, start);
  if (!raw) {
    console.log("[parse] could not bracket-match the init blob");
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    console.log(`[parse] init state parsed: ${raw.length} chars`);
    return parsed;
  } catch (e) {
    console.log(`[parse] init state JSON.parse failed: ${e.message} (blob ${raw.length} chars)`);
    return null;
  }
}

// Google nests stringified JSON payloads (prefixed with )]}') inside the init
// state — under both arrays AND plain objects. Unwrap them all for scanning.
// (Verified against the real page format, June 2026.)
function deepUnwrap(node, bucket) {
  if (typeof node === "string") {
    if (node.startsWith(")]}'")) {
      try {
        bucket.push(JSON.parse(node.slice(4)));
      } catch {}
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) deepUnwrap(c, bucket);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) deepUnwrap(v, bucket);
  }
}

function plausibleLatLng(a, b) {
  return (
    typeof a === "number" && typeof b === "number" &&
    a >= -90 && a <= 90 && b >= -180 && b <= 180 &&
    !(a === 0 && b === 0)
  );
}

// Convert the decimal CID pair to the canonical 0x...:0x... feature id
// (handles negative second halves via 64-bit two's complement).
function cidPairToFtid(pair) {
  try {
    const hex = (d) => "0x" + BigInt.asUintN(64, BigInt(d)).toString(16);
    return `${hex(pair[0])}:${hex(pair[1])}`;
  } catch {
    return null;
  }
}

/**
 * Scan a parsed payload for place records. Verified shape (June 2026):
 *   item[1] = location block:
 *     [2] full address string, [4] short address,
 *     [5] = [null, null, lat, lng], [6] = [cidHigh, cidLow] decimal strings
 *   item[2] = place name (string)
 *   item[3] = the user's note ("" when empty)
 */
function scanPlaces(tree) {
  const found = new Map();
  function walk(n) {
    if (!Array.isArray(n)) return;
    if (
      typeof n[2] === "string" && n[2].length >= 1 &&
      Array.isArray(n[1]) && Array.isArray(n[1][5]) &&
      plausibleLatLng(n[1][5][2], n[1][5][3])
    ) {
      const loc = n[1];
      const cid = Array.isArray(loc[6]) ? loc[6] : null;
      const id = cid ? cid.join(":") : `${n[2]}@${loc[5][2].toFixed(4)},${loc[5][3].toFixed(4)}`;
      if (!found.has(id)) {
        found.set(id, {
          id,
          ftid: cid ? cidPairToFtid(cid) : null,
          name: n[2],
          note: typeof n[3] === "string" && n[3].trim() ? n[3].trim() : null,
          lat: loc[5][2],
          lng: loc[5][3],
          address: loc[4] || loc[2] || null,
        });
      }
      return;
    }
    for (const c of n) walk(c);
  }
  walk(tree);
  return [...found.values()];
}

function parsePlaces(html) {
  const trees = [];
  const init = extractInitState(html);
  if (init) {
    deepUnwrap(init, trees);
    console.log(`[parse] unwrapped ${trees.length} nested payload(s)`);
    trees.push(init); // scan the raw init state too, as a fallback
  }
  let places = [];
  for (const t of trees) {
    const p = scanPlaces(t);
    console.log(`[parse] tree scan found ${p.length} places`);
    if (p.length > places.length) places = p;
  }
  return places;
}

// -------------------------------------------------------------- London areas

const AREAS = [
  ["Soho", 51.5136, -0.1365], ["Covent Garden", 51.5117, -0.1240],
  ["Mayfair", 51.5095, -0.1480], ["Marylebone", 51.5186, -0.1520],
  ["Fitzrovia", 51.5190, -0.1380], ["Bloomsbury", 51.5220, -0.1280],
  ["King's Cross", 51.5310, -0.1230], ["Islington", 51.5380, -0.1030],
  ["Angel", 51.5320, -0.1060], ["Clerkenwell", 51.5230, -0.1050],
  ["Farringdon", 51.5200, -0.1050], ["Shoreditch", 51.5260, -0.0780],
  ["Hoxton", 51.5320, -0.0810], ["Dalston", 51.5460, -0.0750],
  ["Hackney", 51.5450, -0.0550], ["London Fields", 51.5410, -0.0610],
  ["Hackney Wick", 51.5430, -0.0240], ["Clapton", 51.5620, -0.0560],
  ["Stoke Newington", 51.5620, -0.0740], ["Bethnal Green", 51.5270, -0.0630],
  ["Whitechapel", 51.5190, -0.0600], ["Spitalfields", 51.5190, -0.0750],
  ["Aldgate", 51.5140, -0.0750], ["City of London", 51.5130, -0.0900],
  ["Borough", 51.5040, -0.0910], ["London Bridge", 51.5050, -0.0860],
  ["Bermondsey", 51.4980, -0.0640], ["Peckham", 51.4740, -0.0690],
  ["Camberwell", 51.4740, -0.0920], ["Brixton", 51.4620, -0.1150],
  ["Clapham", 51.4620, -0.1380], ["Battersea", 51.4700, -0.1650],
  ["Vauxhall", 51.4860, -0.1240], ["Elephant & Castle", 51.4940, -0.1000],
  ["Waterloo", 51.5030, -0.1130], ["Southbank", 51.5060, -0.1160],
  ["Westminster", 51.4990, -0.1340], ["Victoria", 51.4960, -0.1440],
  ["Pimlico", 51.4890, -0.1330], ["Chelsea", 51.4870, -0.1690],
  ["South Kensington", 51.4940, -0.1740], ["Knightsbridge", 51.5010, -0.1600],
  ["Notting Hill", 51.5160, -0.2050], ["Ladbroke Grove", 51.5170, -0.2100],
  ["Bayswater", 51.5120, -0.1880], ["Paddington", 51.5170, -0.1750],
  ["Camden", 51.5390, -0.1430], ["Kentish Town", 51.5500, -0.1410],
  ["Primrose Hill", 51.5410, -0.1540], ["Hampstead", 51.5560, -0.1780],
  ["Finsbury Park", 51.5640, -0.1060], ["Highbury", 51.5520, -0.0970],
  ["Holloway", 51.5520, -0.1130], ["Tottenham", 51.5880, -0.0680],
  ["Walthamstow", 51.5830, -0.0190], ["Leyton", 51.5610, -0.0120],
  ["Stratford", 51.5410, -0.0030], ["Mile End", 51.5250, -0.0330],
  ["Bow", 51.5280, -0.0200], ["Limehouse", 51.5120, -0.0390],
  ["Canary Wharf", 51.5050, -0.0190], ["Greenwich", 51.4820, -0.0090],
  ["Deptford", 51.4790, -0.0260], ["New Cross", 51.4760, -0.0360],
  ["Dulwich", 51.4450, -0.0860], ["Herne Hill", 51.4530, -0.1020],
  ["Streatham", 51.4280, -0.1310], ["Tooting", 51.4270, -0.1680],
  ["Balham", 51.4430, -0.1530], ["Wandsworth", 51.4570, -0.1920],
  ["Putney", 51.4610, -0.2160], ["Fulham", 51.4710, -0.1950],
  ["Hammersmith", 51.4930, -0.2230], ["Shepherd's Bush", 51.5040, -0.2180],
  ["Chiswick", 51.4910, -0.2550], ["Ealing", 51.5130, -0.3050],
  ["Brent Cross", 51.5760, -0.2230], ["Kilburn", 51.5470, -0.1940],
  ["Maida Vale", 51.5260, -0.1860], ["St John's Wood", 51.5340, -0.1740],
  ["Euston", 51.5280, -0.1330], ["Holborn", 51.5170, -0.1180],
  ["Temple", 51.5110, -0.1140], ["Barbican", 51.5200, -0.0940],
  ["Old Street", 51.5260, -0.0880], ["Haggerston", 51.5380, -0.0760],
  ["Canonbury", 51.5480, -0.0920], ["De Beauvoir", 51.5430, -0.0830],
  ["Victoria Park", 51.5360, -0.0420], ["Wapping", 51.5040, -0.0560],
  ["Crouch End", 51.5800, -0.1230], ["Muswell Hill", 51.5900, -0.1430],
  ["Wood Green", 51.5970, -0.1090], ["Harringay", 51.5770, -0.0980],
  ["Kennington", 51.4880, -0.1110], ["Oval", 51.4820, -0.1130],
  ["Nunhead", 51.4670, -0.0530], ["Forest Hill", 51.4390, -0.0530],
  ["Brockley", 51.4640, -0.0370], ["Lewisham", 51.4620, -0.0100],
  ["Richmond", 51.4610, -0.3040], ["Kew", 51.4840, -0.2880],
  ["Wimbledon", 51.4210, -0.2070], ["Earlsfield", 51.4420, -0.1880],
  ["Acton", 51.5080, -0.2730], ["Kensington", 51.4990, -0.1920],
  ["Earl's Court", 51.4910, -0.1940], ["West Hampstead", 51.5470, -0.1910],
];

function nearestArea(lat, lng) {
  let best = null, bestD = Infinity;
  for (const [name, alat, alng] of AREAS) {
    const d = (lat - alat) ** 2 + ((lng - alng) * 0.62) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  // ~2.5km cutoff: outside London coverage, leave blank.
  return bestD < 0.0006 ? best : null;
}

// ---------------------------------------------------------------- enrichment

const CUISINE_FROM_TYPE = {
  italian_restaurant: "Italian", japanese_restaurant: "Japanese",
  chinese_restaurant: "Chinese", indian_restaurant: "Indian",
  thai_restaurant: "Thai", vietnamese_restaurant: "Vietnamese",
  korean_restaurant: "Korean", mexican_restaurant: "Mexican",
  french_restaurant: "French", spanish_restaurant: "Spanish",
  greek_restaurant: "Greek", turkish_restaurant: "Turkish",
  lebanese_restaurant: "Lebanese", middle_eastern_restaurant: "Middle Eastern",
  american_restaurant: "American", brazilian_restaurant: "Brazilian",
  mediterranean_restaurant: "Mediterranean", seafood_restaurant: "Seafood",
  steak_house: "Steak", sushi_restaurant: "Japanese",
  ramen_restaurant: "Japanese", pizza_restaurant: "Pizza",
  hamburger_restaurant: "Burgers", barbecue_restaurant: "BBQ",
  vegan_restaurant: "Vegan", vegetarian_restaurant: "Vegetarian",
  indonesian_restaurant: "Indonesian", african_restaurant: "African",
  afghani_restaurant: "Afghan", bar_and_grill: "Grill",
  fine_dining_restaurant: null, brunch_restaurant: "Brunch",
  breakfast_restaurant: "Breakfast", cafe: "Café", coffee_shop: "Café",
  bakery: "Bakery", bar: "Bar", wine_bar: "Wine bar", pub: "Pub",
  fast_food_restaurant: null, dessert_shop: "Dessert",
  ice_cream_shop: "Dessert", sandwich_shop: "Sandwiches",
  fish_and_chips_restaurant: "Fish & chips", asian_restaurant: "Asian",
  caribbean_restaurant: "Caribbean", ethiopian_restaurant: "Ethiopian",
  filipino_restaurant: "Filipino", peruvian_restaurant: "Peruvian",
  portuguese_restaurant: "Portuguese", polish_restaurant: "Polish",
  argentinian_restaurant: "Argentinian", israeli_restaurant: "Israeli",
  pakistani_restaurant: "Pakistani", bangladeshi_restaurant: "Bangladeshi",
  sri_lankan_restaurant: "Sri Lankan", nepalese_restaurant: "Nepalese",
  malaysian_restaurant: "Malaysian", singaporean_restaurant: "Singaporean",
  taiwanese_restaurant: "Taiwanese", cantonese_restaurant: "Chinese",
  szechuan_restaurant: "Chinese", georgian_restaurant: "Georgian",
};

const PRICE_MAP = {
  PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

// Vibe vocabulary mined from review text. A vibe is kept when 2+ reviewers
// mention it (1 mention suffices in Google's editorial summary).
const VIBE_PATTERNS = {
  "romantic": /\b(romantic|date night|intimate)\b/gi,
  "cozy": /\b(cozy|cosy|snug|warm atmosphere)\b/gi,
  "lively": /\b(lively|buzzy|bustling|vibrant|buzzing|energetic)\b/gi,
  "quiet": /\b(quiet|peaceful|calm|relaxed atmosphere)\b/gi,
  "unpretentious": /\b(unpretentious|no.?frills|unfussy|down.to.earth|homely)\b/gi,
  "elegant": /\b(elegant|upscale|refined|sophisticated|classy)\b/gi,
  "casual": /\b(casual|laid.?back|informal|chilled)\b/gi,
  "fun": /\b(fun|great vibe|good vibes)\b/gi,
  "trendy": /\b(trendy|hip|cool crowd|instagrammable)\b/gi,
  "hidden gem": /\b(hidden gem|secret spot|off the beaten)\b/gi,
  "friendly staff": /\b(friendly|welcoming|attentive|lovely staff|warm service)\b/gi,
  "good value": /\b(good value|great value|reasonably priced|worth every|won't break)\b/gi,
  "special occasion": /\b(special occasion|anniversary|celebration|birthday)\b/gi,
  "good for groups": /\b(big group|large group|group of|party of)\b/gi,
  "outdoor seating": /\b(terrace|outdoor seating|outside seating|garden|al fresco)\b/gi,
  "great cocktails": /\b(cocktail)\b/gi,
  "good wine": /\b(wine list|natural wine|great wine)\b/gi,
};

function extractVibes(reviews, summary) {
  const vibes = [];
  for (const [vibe, re] of Object.entries(VIBE_PATTERNS)) {
    let mentions = 0;
    for (const r of reviews) {
      re.lastIndex = 0;
      if (re.test(r)) mentions++;
    }
    re.lastIndex = 0;
    if (summary && re.test(summary)) mentions += 2;
    if (mentions >= 2) vibes.push(vibe);
  }
  return vibes;
}

async function enrich(place) {
  const body = {
    textQuery: place.name,
    locationBias: {
      circle: { center: { latitude: place.lat, longitude: place.lng }, radius: 250 },
    },
    pageSize: 1,
  };
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.rating,places.userRatingCount,places.priceLevel,places.types,places.primaryType,places.formattedAddress,places.googleMapsUri,places.displayName,places.editorialSummary,places.reviews",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Places API error ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const p = data.places?.[0];
  if (!p) return {};
  let cuisine = null;
  if (p.primaryType && CUISINE_FROM_TYPE[p.primaryType]) cuisine = CUISINE_FROM_TYPE[p.primaryType];
  if (!cuisine && p.types) {
    for (const t of p.types) {
      if (CUISINE_FROM_TYPE[t]) { cuisine = CUISINE_FROM_TYPE[t]; break; }
    }
  }
  const reviewTexts = (p.reviews || [])
    .map((r) => r.text?.text || "")
    .filter(Boolean);
  const summary = p.editorialSummary?.text || null;
  return {
    placeId: p.id || null,
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? null,
    price: PRICE_MAP[p.priceLevel] ?? null,
    cuisine,
    address: p.formattedAddress || place.address,
    mapsUrl: p.googleMapsUri || null,
    summary,
    vibes: extractVibes(reviewTexts, summary),
    // keep trimmed snippets so the app's text search (and Claude) can use them
    reviews: reviewTexts.slice(0, 3).map((t) => (t.length > 180 ? t.slice(0, 177) + "…" : t)),
  };
}

// --------------------------------------------------------------------- main

function tagsFromNote(note) {
  if (!note) return [];
  return note
    .split(/[,;#\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2 && s.length <= 24); // long fragments stay note-only (searchable, not chips)
}

const main = async () => {
  let html;
  const pre = process.env.HTML_FILE;
  if (pre && existsSync(pre)) {
    const fileHtml = readFileSync(pre, "utf8");
    console.log(
      `Pre-fetched HTML: ${fileHtml.length} bytes, marker=${fileHtml.includes("APP_INITIALIZATION_STATE")}`
    );
    if (fileHtml.includes("APP_INITIALIZATION_STATE")) html = fileHtml;
  }
  if (!html) {
    console.log(`Fetching list: ${LIST_URL}`);
    const r = await fetchListPage(LIST_URL);
    console.log(`Resolved to: ${r.finalUrl}`);
    html = r.html;
  }

  const scraped = parsePlaces(html);
  console.log(`Parsed ${scraped.length} places from the shared list.`);

  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { places: [] };
  const prevById = new Map(prev.places.map((p) => [p.id, p]));

  // Sanity: fail loudly rather than silently nuking the dataset.
  if (scraped.length === 0) {
    console.error("FATAL: parsed 0 places — Google may have changed the page format.");
    process.exit(1);
  }
  if (prev.places.length >= 20 && scraped.length < prev.places.length * 0.5) {
    console.error(
      `FATAL: parsed ${scraped.length} but previous run had ${prev.places.length}. ` +
      "Refusing to overwrite (possible parse regression). Delete data.json to force."
    );
    process.exit(1);
  }

  const overlay = existsSync(OVERLAY) ? JSON.parse(readFileSync(OVERLAY, "utf8")) : {};

  const out = [];
  let enriched = 0, failed = 0;
  for (const s of scraped) {
    const id = s.id;
    const old = prevById.get(id);
    let rec = {
      id,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      note: s.note || null,
      tags: tagsFromNote(s.note),
      area: nearestArea(s.lat, s.lng),
      address: s.address || null,
      cuisine: null, rating: null, ratingCount: null, price: null,
      placeId: null, mapsUrl: null, summary: null, vibes: [], reviews: [],
      ...(old ? {
        cuisine: old.cuisine, rating: old.rating, ratingCount: old.ratingCount,
        price: old.price, placeId: old.placeId, mapsUrl: old.mapsUrl,
        summary: old.summary || null, vibes: old.vibes || [], reviews: old.reviews || [],
        address: old.address || s.address || null,
      } : {}),
    };

    const needsEnrich = API_KEY && !old?.placeId;
    if (needsEnrich) {
      try {
        Object.assign(rec, await enrich(s));
        enriched++;
        await new Promise((r) => setTimeout(r, 120)); // be polite
      } catch (e) {
        failed++;
        console.warn(`  enrich failed for "${s.name}": ${e.message}`);
      }
    }

    if (!rec.mapsUrl) {
      // ftid deep link opens the exact place; fall back to a name+address search
      rec.mapsUrl = s.ftid
        ? `https://maps.google.com/?ftid=${s.ftid}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name + ", " + (s.address || "London"))}`;
    }

    // Manual overrides win over everything.
    if (overlay[id]) Object.assign(rec, overlay[id]);
    out.push(rec);
  }

  const removed = prev.places.filter((p) => !out.some((o) => o.id === p.id)).length;
  const added = out.filter((o) => !prevById.has(o.id)).length;

  writeFileSync(
    OUT,
    JSON.stringify(
      { updated: new Date().toISOString(), source: "google-maps-shared-list", count: out.length, places: out },
      null,
      1
    )
  );
  console.log(
    `Wrote ${OUT}: ${out.length} places (+${added} new, -${removed} removed, ${enriched} enriched, ${failed} enrich failures).`
  );
};

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
