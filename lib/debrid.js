//===============
// YOMI DEBRID PROVIDER INTERFACE
// This module manages communication with Debrid services (Real-Debrid & Torbox).
// It performs two main tasks:
// 1. Cache check: Checking whether a torrent is already immediately available.
// 2. Progress tracking: Monitoring the status of torrents being downloaded to the cloud.
//===============

const axios = require("axios");

//===============
// Checks Real-Debrid for immediate availability of a list of hashes.
// If cached, returns the file structure of the first available variant.
// @param {string[]} hashes - Array of torrent info hashes.
// @param {string} apiKey - User's Real-Debrid API key.
// @returns {Promise<Object>} - Mapping from hash to an array of files {id, name, size}.
//===============
async function checkRD(hashes, apiKey) {
    try {
        const url = `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashes.join("/")}`;
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        const results = {};
        
        Object.keys(res.data).forEach(hash => {
            const h = hash.toLowerCase();
            const availability = res.data[hash];
            
            if (availability && availability.rd && availability.rd.length > 0) {
                let allFiles = [];
                const variant = availability.rd[0];
                Object.keys(variant).forEach(fileId => {
                    allFiles.push({ 
                        id: fileId, 
                        name: variant[fileId].filename, 
                        size: variant[fileId].filesize 
                    });
                });
                results[h] = allFiles;
            }
        });
        return results;
    } catch (e) { 
        console.error(`[Real-Debrid Error] Fehler bei checkRD: ${e.message}`);
        return {}; 
    }
}

//===============
// Checks Torbox for cached torrents.
// @param {string[]} hashes - Array of torrent info hashes.
// @param {string} apiKey - The user's Torbox API key.
// @returns {Promise<Object>} - Mapping from hash to an array of files {id, name, size}.
//===============
async function checkTorbox(hashes, apiKey) {
    try {
        const url = `https://api.torbox.app/v1/api/torrents/checkcached?hash=${hashes.join(",")}&format=list&list_files=true`;
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        const results = {};
        
        if (res.data && res.data.data) {
            res.data.data.forEach(t => {
                results[t.hash.toLowerCase()] = t.files.map(f => ({ 
                    id: f.id, 
                    name: f.name, 
                    size: f.size 
                }));
            });
        }
        return results;
    } catch (e) { 
        console.error(`[Torbox Error] Fehler bei checkTorbox: ${e.message}`);
        return {}; 
    }
}

//===============
// Retrieves the current list of active torrents from Real-Debrid.
// Used to display the download progress (0–100%) for torrents that have not yet been cached.
// @param {string} apiKey - The user's Real-Debrid API key.
// @returns {Promise<Object>} - Mapping from hash to progress in percent (0 to 100).
//===============
async function getActiveRD(apiKey) {
    try {
        const res = await axios.get("https://api.real-debrid.com/rest/1.0/torrents", { 
            headers: { Authorization: `Bearer ${apiKey}` } 
        });
        const active = {};
        
        res.data.forEach(t => {
            if (t.status === "downloaded") {
                active[t.hash.toLowerCase()] = 100;
            } else if (t.status !== "error" && t.status !== "dead") {
                active[t.hash.toLowerCase()] = t.progress || 0;
            }
        });
        return active;
    } catch (e) { 
        console.error(`[Real-Debrid Error] Fehler bei getActiveRD: ${e.message}`);
        return {}; 
    }
}

//===============
// Retrieves the current list of active torrents from Torbox.
// Normalizes the progress data to a standardized 0–100 integer format.
// @param {string} apiKey - The user's Torbox API key.
// @returns {Promise<Object>} - A mapping from hash to progress percentage (0 to 100).
//===============
async function getActiveTorbox(apiKey) {
    try {
        const res = await axios.get("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true", { 
            headers: { Authorization: `Bearer ${apiKey}` } 
        });
        const active = {};
        
        if (res.data && res.data.data) {
            res.data.data.forEach(t => {
                if (t.download_state === "completed" || t.download_state === "cached") {
                    active[t.hash.toLowerCase()] = 100;
                } else {
                    let p = t.progress || 0;
                    if (p <= 1 && p > 0) p = p * 100;
                    active[t.hash.toLowerCase()] = Math.round(p);
                }
            });
        }
        return active;
    } catch (e) { 
        console.error(`[Torbox Error] Fehler bei getActiveTorbox: ${e.message}`);
        return {}; 
    }
}

module.exports = { checkRD, checkTorbox, getActiveRD, getActiveTorbox };
