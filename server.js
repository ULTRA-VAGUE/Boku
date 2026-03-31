//===============
// YOMI GATEWAY - SERVER CORE
// This is the entry point of the application. It sets up the Express server,
// handles static assets, and provides the specialized routes for stream resolution
// and subtitle proxying.
//===============

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const { getRouter } = require("stremio-addon-sdk");
const { addonInterface } = require("./addon");
const { selectBestVideoFile } = require("./lib/parser");

const app = express();
app.use(express.json()); 
const port = process.env.PORT || 7000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "static")));

// Health check endpoint for PaaS platforms
app.get("/health", (req, res) => res.status(200).json({ status: "alive" }));

//===============
// SUKEBEI STATUS CHECK
// Pings Sukebei and caches the result for 5 minutes to prevent rate limiting
//===============
let sukebeiCache = { status: "checking", timestamp: 0 };

app.get("/sukebei-status", async (req, res) => {
    const now = Date.now();
    if (now - sukebeiCache.timestamp < 300000 && sukebeiCache.status !== "checking") {
        return res.json({ status: sukebeiCache.status });
    }
    
    try {
        await axios.get("https://sukebei.nyaa.si", { 
            timeout: 8000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        sukebeiCache = { status: "online", timestamp: now };
        res.json({ status: "online" });
    } catch (error) {
        sukebeiCache = { status: "offline", timestamp: now };
        res.json({ status: "offline" });
    }
});

app.get("/configure", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

//===============
// SUBTITLE PROXY
// Downloads subtitles from Debrid providers and pipes them directly to the client.
// This prevents memory leaks caused by buffering large files in RAM.
//===============
app.get("/sub/:provider/:apiKey/:hash/:fileId", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    const { provider, apiKey, hash, fileId } = req.params;
    try {
        let downloadUrl = null;
        let fileName = "sub.srt";
        if (provider === "realdebrid") {
            const list = await axios.get("https://api.real-debrid.com/rest/1.0/torrents", { headers: { Authorization: `Bearer ${apiKey}` } });
            const torrent = list.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            if (torrent) {
                const info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
                const fileIdx = info.data.files.findIndex(f => f.id == fileId);
                fileName = info.data.files[fileIdx].path;
                const unrestrict = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link", new URLSearchParams({ link: info.data.links[fileIdx] }), { headers: { Authorization: `Bearer ${apiKey}` } });
                downloadUrl = unrestrict.data.download;
            }
        } else if (provider === "torbox") {
            const dl = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&hash=${hash}&file_id=${fileId}`);
            downloadUrl = dl.data.data;
        }
        if (!downloadUrl) return res.status(404).send("Subtitle not found");
        
        const ext = fileName.split(".").pop().toLowerCase();
        let mime = "text/plain";
        if (ext === "vtt") mime = "text/vtt";
        else if (ext === "ass" || ext === "ssa") mime = "text/x-ssa";
        else if (ext === "srt") mime = "application/x-subrip";
        
        res.set("Content-Type", mime);

        // Streaming data to prevent memory spikes
        const subResponse = await axios.get(downloadUrl, { responseType: "stream" });
        subResponse.data.pipe(res);
    } catch (e) { 
        console.error(`[Subtitle Error] Failed to fetch subtitle: ${e.message}`);
        res.status(500).send("Error fetching subtitle"); 
    }
});
    
// Redirects to a local loading video while Debrid is preparing the file.
function serveLoadingVideo(req, res) {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    res.redirect(`${protocol}://${req.headers.host}/waiting.mp4`);
}

// Redirects to an informational video when a torrent only contains archives (.rar/.zip).
function serveArchiveVideo(req, res) {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    res.redirect(`${protocol}://${req.headers.host}/archive.mp4`);
}

//===============
// STREAM RESOLVER
// Converts a Torrent Hash + Episode Number into a playable direct link.
// Handles magnet addition, file selection, and unrestricting on the fly.    
//===============
app.get("/resolve/:provider/:apiKey/:hash/:episode?", async (req, res) => {
    const { provider, apiKey, hash, episode } = req.params;
    const requestedEp = episode || "1";
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    try {
        if (provider === "realdebrid") {
            const listRes = await axios.get("https://api.real-debrid.com/rest/1.0/torrents", { headers: { Authorization: `Bearer ${apiKey}` } });
            let torrent = listRes.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            if (!torrent) {
                const add = await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", new URLSearchParams({ magnet }), { headers: { Authorization: `Bearer ${apiKey}` } });
                torrent = { id: add.data.id };
            }
            let info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
            
            if (info.data.status !== "downloaded") {
                if (info.data.status === "waiting_files_selection") {
                    const bestFile = selectBestVideoFile(info.data.files, requestedEp);
                    
                    if (!bestFile) {
                        return serveArchiveVideo(req, res);
                    }
                    
                    const selectedIds = [bestFile.id];

                    info.data.files.forEach(f => {
                        const name = (f.path || f.name || "").toLowerCase();
                        if (/\.(ass|srt|ssa|vtt|sub|idx)$/.test(name)) {
                            if (!selectedIds.includes(f.id)) selectedIds.push(f.id);
                        }
                    });
                    
                    const bodyString = "files=" + selectedIds.join(",");
                    await axios.post("https://api.real-debrid.com/rest/1.0/torrents/selectFiles/" + torrent.id, bodyString, { 
                        headers: { 
                            Authorization: `Bearer ${apiKey}`,
                            "Content-Type": "application/x-www-form-urlencoded"
                        } 
                    });

                    await new Promise(resolve => setTimeout(resolve, 1500));
                    info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
                }
                
                if (info.data.status !== "downloaded") {
                    return serveLoadingVideo(req, res);
                }
            }
            
            const bestFileFresh = selectBestVideoFile(info.data.files, requestedEp);
            
            if (!bestFileFresh) {
                return serveArchiveVideo(req, res);
            }
            
            const targetFileIndex = info.data.files.findIndex(f => f.id === bestFileFresh.id);
            let targetLink = info.data.links[0]; 
            
            if (targetFileIndex !== -1) {
                let linkCounter = 0;
                for (let i = 0; i < info.data.files.length; i++) {
                    if (i === targetFileIndex) {
                        targetLink = info.data.links[linkCounter];
                        break;
                    }
                    if (info.data.files[i].selected === 1) {
                        linkCounter++;
                    }
                }
            }

            if (!targetLink) {
                 return serveLoadingVideo(req, res);
            }

            const unrestrict = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link", new URLSearchParams({ link: targetLink }), { headers: { Authorization: `Bearer ${apiKey}` } });
            return res.redirect(unrestrict.data.download);
        }
        if (provider === "torbox") {
            const list = await axios.get("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true", { headers: { Authorization: `Bearer ${apiKey}` } });
            let torrent = list.data.data ? list.data.data.find(t => t.hash.toLowerCase() === hash.toLowerCase()) : null;
            if (!torrent) {
                const boundary = "----WebKitFormBoundaryYomi";
                await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", `--${boundary}\r\nContent-Disposition: form-data; name="magnet"\r\n\r\n${magnet}\r\n--${boundary}--`, { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": `multipart/form-data; boundary=${boundary}` } });
                return serveLoadingVideo(req, res);
            }
            if (torrent.download_state !== "completed" && torrent.download_state !== "cached") return serveLoadingVideo(req, res);
            
            const bestFile = selectBestVideoFile(torrent.files, requestedEp);
            if (!bestFile) {
                return serveArchiveVideo(req, res);
            }
            
            const dl = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${bestFile.id}`);
            return res.redirect(dl.data.data);
        }
    } catch (e) { return serveLoadingVideo(req, res); }
});

app.use("/", getRouter(addonInterface));
app.listen(port, () => console.log(`YOMI ONLINE | PORT ${port}`));
