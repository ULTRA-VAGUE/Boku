//===============
// YOMI DEBRID PROVIDER INTERFACE
// This module manages communication with Debrid services (Real-Debrid & Torbox).
// Includes intelligent chunking to prevent 414 URI Too Long errors.
//===============

const axios = require("axios");

//===============
// Checks Real-Debrid for immediate availability.
// Splits the request into blocks of 40 to avoid exceeding API limits.
//===============
async function checkRD(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};
    
    try {
        const results = {};
        
        // A block size of 40 prevents URL overflows
        for (let i = 0; i < hashes.length; i += 40) {
            const chunk = hashes.slice(i, i + 40);
            const url = `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${chunk.join("/")}`;
            const res = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
            
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
        }
        return results;
    } catch (e) { 
        console.error(`[Real-Debrid Error] Error at checkRD: ${e.message}`);
        return {}; 
    }
}

//===============
// Checks Torbox for cached torrents.
// Also splits the request into secure blocks of 40.
//===============
async function checkTorbox(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};

    try {
        const results = {};
        
        for (let i = 0; i < hashes.length; i += 40) {
            const chunk = hashes.slice(i, i + 40);
            const url = `https://api.torbox.app/v1/api/torrents/checkcached?hash=${chunk.join(",")}&format=list&list_files=true`;
            const res = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
            
            if (res.data && res.data.data) {
                res.data.data.forEach(t => {
                    results[t.hash.toLowerCase()] = t.files.map(f => ({ 
                        id: f.id, 
                        name: f.name, 
                        size: f.size 
                    }));
                });
            }
        }
        return results;
    } catch (e) { 
        console.error(`[Torbox Error] Error at checkTorbox: ${e.message}`);
        return {}; 
    }
}

//===============
// Retrieves the current list of active torrents from Real-Debrid.
// The limit has been increased to 100 to accommodate large libraries.
//===============
async function getActiveRD(apiKey) {
    try {
        const res = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=100", { 
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
        console.error(`[Real-Debrid Error] Error at getActiveRD: ${e.message}`);
        return {}; 
    }
}

//===============
// Retrieves the current list of active torrents from Torbox.
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
        console.error(`[Torbox Error] Error at getActiveTorbox: ${e.message}`);
        return {}; 
    }
}

module.exports = { checkRD, checkTorbox, getActiveRD, getActiveTorbox };
