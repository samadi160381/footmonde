// /api/scorers.js
//
// Proxies API-Football's top-scorers endpoint. The API key lives only here
// (server-side, via the APIFOOTBALL_KEY environment variable set in Vercel
// project settings) and is never exposed to the browser.
//
// Two layers of protection against burning through the free-trial quota:
//
// 1. Edge cache (Cache-Control: s-maxage) — Vercel's CDN serves cached
//    responses directly, so a warm cache means ZERO calls reach API-Football
//    at all, no matter how much traffic hits the site.
//
// 2. In-memory "single-flight" lock (below) — closes the one gap the edge
//    cache has: if the cache is cold and many visitors hit at once, only the
//    FIRST request actually calls API-Football; every other concurrent
//    request for the same league waits on that same in-flight call instead
//    of firing its own. This means at most one real upstream request per
//    league per cache window, even under a traffic spike.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const memoryCache = new Map();   // league -> { data, expiresAt }
const inFlight = new Map();      // league -> Promise (dedupes concurrent cold requests)

async function fetchFromApiFootball(league, season, apiKey) {
  const apiRes = await fetch(
    `https://v3.football.api-sports.io/players/topscorers?league=${league}&season=${season}`,
    { headers: { 'x-apisports-key': apiKey } }
  );
  const data = await apiRes.json();
  if (!apiRes.ok) {
    const err = new Error(`Upstream error ${apiRes.status}`);
    err.details = data;
    throw err;
  }
  const scorers = (data.response || []).slice(0, 5).map((entry) => ({
    name: entry.player?.name || 'Unknown',
    photo: entry.player?.photo || '',
    club: entry.statistics?.[0]?.team?.name || '',
    goals: entry.statistics?.[0]?.goals?.total ?? 0,
  }));
  // Surface upstream diagnostics even on a "successful" HTTP response, since
  // API-Football often returns 200 with an empty response[] plus an errors{}
  // object for auth/plan/quota problems rather than a non-200 status.
  return { scorers, _debug: { results: data.results, errors: data.errors } };
}

export default async function handler(req, res) {
  const { league } = req.query;

  if (!league) {
    return res.status(400).json({ error: 'Missing "league" query param' });
  }

  const season = req.query.season || 2023; // free-trial plans only cover 2022–2024
  const apiKey = process.env.APIFOOTBALL_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing APIFOOTBALL_KEY' });
  }

  const cacheKey = `${league}:${season}`;
  const cached = memoryCache.get(cacheKey);

  // Fast path: still-fresh in-memory data, no network call at all.
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({ scorers: cached.data, _debug: cached.debug });
  }

  try {
    // Single-flight: if a request for this league is already in progress,
    // piggyback on it instead of starting a second upstream call.
    let promise = inFlight.get(cacheKey);
    if (!promise) {
      promise = fetchFromApiFootball(league, season, apiKey).finally(() => {
        inFlight.delete(cacheKey);
      });
      inFlight.set(cacheKey, promise);
    }

    const { scorers, _debug } = await promise;
    memoryCache.set(cacheKey, { data: scorers, debug: _debug, expiresAt: Date.now() + CACHE_TTL_MS });

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({ scorers, _debug });
  } catch (err) {
    // If we have stale cached data, serve it rather than failing outright.
    if (cached) {
      return res.status(200).json({ scorers: cached.data, stale: true });
    }
    return res.status(502).json({ error: 'Failed to fetch scorer data', details: err.details || err.message });
  }
}

