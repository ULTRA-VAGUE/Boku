//===============
// YOMI METADATA PROVIDER - ANILIST & MYANIMELIST (JIKAN)
// This module handles all metadata requests for the add-on.
//===============

const axios = require("axios");
const ANILIST_URL = "https://graphql.anilist.co";

function toBase64Safe(str) {
    return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

const apiCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

function setLRUCache(key, dataOrPromise) {
    if (apiCache.has(key)) { apiCache.delete(key); } 
    else if (apiCache.size >= MAX_CACHE_ENTRIES) { apiCache.delete(apiCache.keys().next().value); }
    apiCache.set(key, { timestamp: Date.now(), data: dataOrPromise });
}

function getLRUCache(key) {
    if (apiCache.has(key)) {
        const item = apiCache.get(key);
        if (Date.now() - item.timestamp < CACHE_TTL) {
            apiCache.delete(key);
            apiCache.set(key, item);
            return item.data;
        } else { apiCache.delete(key); }
    }
    return null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatDescription(anime) {
    let text = anime.description || anime.synopsis || "No description available.";
    text = text.replace(/~![\s\S]*?!~/g, "[Spoiler removed]").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>?/gm, "");
    text = text.replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#039;/g, "\"").replace(/&mdash;/g, "—");
    text = text.replace(/\[Written by MAL Rewrite\]/gi, "").trim().replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();

    let header = [];
    if (anime.format) header.push("📺 Format: " + anime.format);
    if (anime.status) header.push("📌 Status: " + anime.status.replace(/_/g, " "));
    if (anime.releaseDate) header.push("📅 Released: " + anime.releaseDate);
    
    if (anime.averageScore) {
        let finalScore = parseInt(anime.averageScore);
        if (finalScore > 100) finalScore = Math.round(finalScore / 10);
        if (finalScore > 100) finalScore = 100; 
        header.push("⭐️ Score: " + finalScore + "%");
    }
    return header.length > 0 ? (header.join(" | ") + "\n\n" + text) : text;
}

async function _fetchAniList(query, variables, retries = 3) {
    const cacheKey = "anilist_" + JSON.stringify(variables || {});
    const cachedItem = getLRUCache(cacheKey);
    if (cachedItem) return cachedItem;

    const fetchPromise = (async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await axios.post(ANILIST_URL, { query, variables }, { timeout: 6000 });
                if (!response.data?.data?.Page) { apiCache.delete(cacheKey); return []; }
                
                const results = response.data.data.Page.media.map(anime => {
                    const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
                    const base64Title = toBase64Safe(cleanTitle);
                    const year = anime.startDate?.year || anime.seasonYear;
                    const month = anime.startDate?.month;
                    const releaseDateStr = year ? (month ? month.toString().padStart(2, "0") + "/" + year : "" + year) : null;
                    const released = year ? new Date(Date.UTC(year, (month || 1) - 1, (anime.startDate?.day || 1))).toISOString() : undefined;
                    
                    let epCount = anime.episodes || (anime.nextAiringEpisode?.episode ? anime.nextAiringEpisode.episode - 1 : 1);
                    return {
                        id: "yomi:" + anime.id + ":" + base64Title,
                        type: "series", 
                        name: cleanTitle,
                        poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                        background: anime.bannerImage || "",
                        description: formatDescription({ ...anime, releaseDate: releaseDateStr }),
                        releaseInfo: year ? "" + year : undefined,
                        released: released,
                        episodes: epCount
                    };
                });
                setLRUCache(cacheKey, results);
                return results;
            } catch (error) { if (attempt < retries - 1) await sleep(1000); }
        }
        apiCache.delete(cacheKey); return [];
    })();
    setLRUCache(cacheKey, fetchPromise); return fetchPromise;
}

async function searchAdultAnime(query) {
    const q = `query ($search: String) { Page(page: 1, perPage: 50) { media(search: $search, type: ANIME, isAdult: true) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes nextAiringEpisode { episode airingAt } averageScore status seasonYear startDate { year month day } } } }`;
    return _fetchAniList(q, { search: query });
}

async function getTrendingAdultAnime() {
    const q = `query ($sort: [MediaSort]) { Page(page: 1, perPage: 30) { media(type: ANIME, isAdult: true, sort: $sort) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes nextAiringEpisode { episode airingAt } averageScore status seasonYear startDate { year month day } } } }`;
    return _fetchAniList(q, { sort: ["TRENDING_DESC"] });
}

async function getTopAdultAnime() {
    const q = `query ($sort: [MediaSort]) { Page(page: 1, perPage: 30) { media(type: ANIME, isAdult: true, sort: $sort) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes nextAiringEpisode { episode airingAt } averageScore status seasonYear startDate { year month day } } } }`;
    return _fetchAniList(q, { sort: ["SCORE_DESC"] });
}

async function getAnimeMeta(anilistId, retries = 3) {
    const cacheKey = "anilist_meta_" + anilistId;
    const cachedItem = getLRUCache(cacheKey);
    if (cachedItem) return cachedItem;

    // Amatsu-style direct Media lookup (No Page wrapper needed for ID search)
    const q = `query ($id: Int) { 
        Media(id: $id, type: ANIME) { 
            id idMal title { romaji english } synonyms coverImage { extraLarge } bannerImage description format episodes 
            nextAiringEpisode { episode airingAt } streamingEpisodes { title thumbnail } averageScore status seasonYear 
            startDate { year month day } 
        } 
    }`;

    const fetchPromise = (async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await axios.post(ANILIST_URL, { query: q, variables: { id: parseInt(anilistId) } }, { timeout: 6000 });
                const anime = response.data?.data?.Media;
                if (!anime) { apiCache.delete(cacheKey); return null; }

                const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
                const base64Title = toBase64Safe(cleanTitle);
                const year = anime.startDate?.year || anime.seasonYear;
                const month = anime.startDate?.month;
                const releaseDateStr = year ? (month ? month.toString().padStart(2, "0") + "/" + year : "" + year) : null;
                const released = year ? new Date(Date.UTC(year, (month || 1) - 1, (anime.startDate?.day || 1))).toISOString() : undefined;

                let epCount = anime.episodes || (anime.nextAiringEpisode?.episode ? anime.nextAiringEpisode.episode - 1 : 1);
                let epMeta = {};
                if (anime.streamingEpisodes) {
                    anime.streamingEpisodes.forEach(ep => {
                        const match = ep.title.match(/(?:Episode|Ep)\s+(\d+)\s*[-:]\s*(.*)/i) || ep.title.match(/\d+/);
                        if (match) epMeta[parseInt(Array.isArray(match) ? (match[1] || match[0]) : match)] = { title: match[2] || ep.title, thumbnail: ep.thumbnail };
                    });
                }

                const result = {
                    id: "yomi:" + anime.id + ":" + base64Title,
                    idMal: anime.idMal, type: "series", name: cleanTitle, altName: anime.title.english || "", synonyms: anime.synonyms || [],
                    poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                    background: anime.bannerImage || "", description: formatDescription({ ...anime, releaseDate: releaseDateStr }),
                    releaseInfo: year ? "" + year : undefined, released: released, episodes: epCount, epMeta: epMeta,
                    baseTime: year ? new Date(Date.UTC(year, (month || 1) - 1, (anime.startDate?.day || 1))).getTime() : Date.now(),
                    nextAiringEpisode: anime.nextAiringEpisode
                };
                setLRUCache(cacheKey, result);
                return result;
            } catch (error) { if (attempt < retries - 1) await sleep(1000); }
        }
        apiCache.delete(cacheKey); return null;
    })();
    setLRUCache(cacheKey, fetchPromise); return fetchPromise;
}

async function fetchEpisodeDetails(malId) {
    if (!malId) return {};
    const cacheKey = "jikan_eps_" + malId;
    const cached = getLRUCache(cacheKey);
    if (cached) return cached;
    const eps = {};
    try {
        let page = 1, hasNextPage = true;
        while (hasNextPage && page <= 4) {
            const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`, { timeout: 4000 });
            if (res.data?.data) res.data.data.forEach(ep => { eps[ep.mal_id] = { title: ep.title, aired: ep.aired }; });
            hasNextPage = res.data?.pagination?.has_next_page;
            if (hasNextPage) { page++; await sleep(400); }
        }
        setLRUCache(cacheKey, eps);
    } catch (e) {}
    return eps;
}

async function getJikanMeta(cleanedTitle, retries = 3) {
    const cacheKey = "jikan_" + cleanedTitle;
    const cachedItem = getLRUCache(cacheKey);
    if (cachedItem) return cachedItem;

    const fetchPromise = (async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const url = "https://api.jikan.moe/v4/anime?q=" + encodeURIComponent(cleanedTitle) + "&sfw=false&limit=1";
                const response = await axios.get(url, { timeout: 4000 });
                const anime = response.data?.data?.[0];
                if (anime) {
                    const year = anime.aired?.prop?.from?.year || anime.year;
                    const result = {
                        poster: anime.images?.jpg?.large_image_url || null, background: anime.trailer?.images?.maximum_image_url || anime.images?.jpg?.large_image_url || null,
                        description: formatDescription({ synopsis: anime.synopsis, format: anime.type, status: anime.status, averageScore: anime.score ? Math.round(anime.score * 10) : null }),
                        releaseInfo: year ? "" + year : undefined, episodes: anime.episodes || null, altName: anime.title_english || "", synonyms: anime.title_synonyms || [],
                        baseTime: year ? new Date(Date.UTC(year, (anime.aired?.prop?.from?.month || 1) - 1, 1)).getTime() : Date.now(), epMeta: {}
                    };
                    setLRUCache(cacheKey, result); return result;
                }
                apiCache.delete(cacheKey); return null; 
            } catch (error) { if (attempt < retries - 1) await sleep(1000); }
        }
        apiCache.delete(cacheKey); return null;
    })();
    setLRUCache(cacheKey, fetchPromise); return fetchPromise;
}

module.exports = { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime, getJikanMeta, fetchEpisodeDetails };
