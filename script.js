// ===== Global Variables =====
let map;
let markersLayer;
let heatmapLayer;
let drawControl;
let drawnItems;
let scanResults = [];
let scanRunning = false;
let scanPaused = false;
const RETRY_DELAY_MS = 1000; // Delay before retrying failed requests
const COORDINATE_TOLERANCE = 0.00001; // Tolerance for comparing coordinates

// CORS proxy for GitHub Pages deployment (avoids cross-origin preflight failures)
const API_BASE_URL = "https://geo.tunisietelecom.tn/rsm/RSMService.svc";
const isLocalhost = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
// "https://corsproxy.io/?url=" Disable proxy due to custom domain (free for github.io")
const CORS_PROXY = isLocalhost ? "" : ""; 

/**
 * Build API URL, routing through CORS proxy when not on localhost
 */
function apiUrl(endpoint) {
    const url = API_BASE_URL + endpoint;
    return CORS_PROXY ? CORS_PROXY + encodeURIComponent(url) : url;
}

// ===== IndexedDB Cache Layer =====
const DB_NAME = 'sfaxFiberScannerDB';
const DB_VERSION = 1;
const STORE_NAME = 'scannedPoints';
let dbInstance = null;

function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
        request.onsuccess = (event) => {
            dbInstance = event.target.result;
            resolve(dbInstance);
        };
        request.onerror = (event) => reject(event.target.error);
    });
}

async function getCachedPoint(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

async function putCachedPoint(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

async function getAllCachedPoints() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

async function clearCachedPoints() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/**
 * Return the marker fill color for a given scan result state
 */
function markerColor(isError, available) {
    if (isError) return '#ffc107';  // yellow for errors
    return available ? '#28a745' : '#dc3545';  // green / red
}

// Statistics
let stats = {
    total: 0,
    available: 0,
    notAvailable: 0,
    errors: 0,
    cached: 0
};

// ===== Token Generation Functions =====

/**
 * Generate a random string of 10 characters
 * Character set matches the API's expected format (reverse-engineered from Tunisie Telecom API)
 */
function makeRString() {
    let text = "";
    const possible = "ABCxyz0123456789"; // Specific charset required by the API
    for (let i = 0; i < 10; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * Fetch and generate API token
 */
async function getToken() {
    try {
        const response = await fetch(apiUrl("/getAppVersion"));
        const data = await response.json();
        const r = data.getAppVersionResult;
        const WS1 = r;
        const WS2 = WS1.substring(10, WS1.length);
        let t_s = parseInt(WS2);
        t_s = t_s - 1334170131052;
        const t_c = t_s + 1225486587123;
        const token = makeRString() + t_c + "";
        return token;
    } catch (error) {
        console.error("Error generating token:", error);
        return null;
    }
}

// ===== Coordinate Encoding =====

/**
 * Encode coordinates for API request
 */
function codeCoordinates(x, y) {
    const Ax = 100000.0;
    const Ay = 100000.0;
    const Bx = 123456.0;
    const By = 654321.0;
    return { 
        xCoded: (x * Ax) - Bx, 
        yCoded: (y * Ay) - By 
    };
}

// ===== API Functions =====

/**
 * Check fiber coverage for a specific coordinate
 * Generates a fresh token for each request as required by the API.
 * Requests must be made sequentially — the API returns faulty responses
 * when multiple requests are sent concurrently.
 */
async function checkCoverage(lat, lng) {
    const token = await getToken();
    if (!token) {
        throw new Error('Failed to generate token');
    }
    
    const coded = codeCoordinates(lng, lat);
    const payload = {
        TaghtiaRequest: {
            token: token,
            X: coded.xCoded,
            Y: coded.yCoded
        }
    };

    try {
        const response = await fetch(apiUrl("/TaghtiaUltimate"), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await response.json();
        return data.TaghtiaUltimateResult;
    } catch (error) {
        console.error("Error checking coverage:", error);
        throw error;
    }
}

// ===== Map Initialization =====

/**
 * Initialize the Leaflet map
 */
function initMap() {
    // Create map centered on Sfax
    map = L.map('map').setView([34.74, 10.76], 13);

    // Define base tile layers
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    });

    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '© Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        maxZoom: 19
    });

    const topoMap = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenTopoMap contributors',
        maxZoom: 17
    });

    // Add default layer
    osm.addTo(map);

    // Add layer control switcher
    const baseLayers = {
        'Street': osm,
        'Satellite': satellite,
        'Topographic': topoMap
    };
    L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);

    // Initialize marker layer (not added to map — hidden by default)
    markersLayer = L.layerGroup();

    // Initialize heatmap layer (not added by default)
    heatmapLayer = null;

    // Initialize drawn items for rectangle selection
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Add draw control (initially hidden)
    drawControl = new L.Control.Draw({
        draw: {
            rectangle: true,
            polygon: false,
            circle: false,
            marker: false,
            polyline: false,
            circlemarker: false
        },
        edit: {
            featureGroup: drawnItems
        }
    });

    // Handle rectangle drawn event
    map.on(L.Draw.Event.CREATED, function (event) {
        const layer = event.layer;
        drawnItems.clearLayers();
        drawnItems.addLayer(layer);
        
        // Update bounds in the form
        const bounds = layer.getBounds();
        document.getElementById('latMin').value = bounds.getSouth().toFixed(4);
        document.getElementById('latMax').value = bounds.getNorth().toFixed(4);
        document.getElementById('lngMin').value = bounds.getWest().toFixed(4);
        document.getElementById('lngMax').value = bounds.getEast().toFixed(4);
        
        calculateTotalPoints();
    });
}

// ===== Marker Functions =====

/**
 * Add a marker to the map based on scan result
 */
function addMarker(lat, lng, result, isError = false) {
    let color = '#ffc107'; // Yellow for errors
    let status = 'Error / Unknown';
    let available = false;

    if (!isError && result && result.taghtiaGPON) {
        if (result.taghtiaGPON.Code_taghtia == 200 && 
            result.taghtiaGPON.Message_taghtia == "OK" && 
            result.taghtiaGPON.Taghtia == "OUI") {
            color = '#28a745'; // Green for available
            status = 'Fiber Available (GPON)';
            available = true;
        } else {
            color = '#dc3545'; // Red for not available
            status = 'Fiber Not Available';
        }
    }

    // Create circle marker (low opacity so the underlying map remains visible)
    const marker = L.circleMarker([lat, lng], {
        radius: 6,
        fillColor: color,
        color: color,
        weight: 1,
        opacity: 0.4,
        fillOpacity: 0.25
    });

    // Create popup content
    let popupContent = `
        <div>
            <h6>${status}</h6>
            <p><strong>Coordinates:</strong><br>
            Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}</p>
    `;

    if (!isError && result && result.taghtiaGPON) {
        if (available && result.taghtiaGPON.Debit) {
            popupContent += `<p><strong>Speed:</strong> ${result.taghtiaGPON.Debit}</p>`;
        }
        
        // Add ADSL info if available
        if (result.taghtiaADSL && result.taghtiaADSL.Taghtia == "OUI") {
            popupContent += `<p><strong>ADSL:</strong> Available</p>`;
        }
        
        // Add VDSL info if available
        if (result.taghtiaVDSL && result.taghtiaVDSL.Taghtia == "OUI") {
            popupContent += `<p><strong>VDSL:</strong> Available</p>`;
        }
        
        // Add PC info if available
        if (result.taghtiaGPON.PC_CODE) {
            popupContent += `<p><strong>PC Code:</strong> ${result.taghtiaGPON.PC_CODE}</p>`;
        }
    }

    popupContent += `</div>`;
    marker.bindPopup(popupContent);

    // Add to layer
    marker.addTo(markersLayer);

    return { lat, lng, available, color, result };
}

// ===== Heatmap Functions =====

/**
 * Update heatmap layer with current results
 */
function updateHeatmap() {
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
    }

    // Only show fiber-available points so the heatmap represents coverage
    const heatData = scanResults
        .filter(r => !r.isError && r.available)
        .map(r => [r.lat, r.lng, 1.0]);

    heatmapLayer = L.heatLayer(heatData, {
        radius: 25,
        blur: 15,
        maxZoom: 17,
        max: 1.0,
        minOpacity: 0.1,
        gradient: {
            0.4: '#28a745',
            1.0: '#155724'
        }
    });

    if (document.getElementById('showHeatmap').checked) {
        heatmapLayer.addTo(map);
    }
}

// ===== Scan Functions =====

/**
 * Number of grid steps needed to cover a range.
 * Uses epsilon-aware rounding so that floating-point noise
 * (e.g. 3.0000000000001) doesn't add an extra step.
 */
function gridSteps(range, step) {
    const raw = range / step;
    const rounded = Math.round(raw);
    if (Math.abs(raw - rounded) < 1e-9) {
        return rounded;
    }
    return Math.ceil(raw);
}

/**
 * Calculate total number of points to scan
 */
function calculateTotalPoints() {
    const latMin = parseFloat(document.getElementById('latMin').value);
    const latMax = parseFloat(document.getElementById('latMax').value);
    const lngMin = parseFloat(document.getElementById('lngMin').value);
    const lngMax = parseFloat(document.getElementById('lngMax').value);
    const step = parseFloat(document.getElementById('stepSize').value);

    const latSteps = gridSteps(latMax - latMin, step) + 1;
    const lngSteps = gridSteps(lngMax - lngMin, step) + 1;
    const total = latSteps * lngSteps;

    document.getElementById('totalPoints').textContent = total;
    updateCoverageInfo();
    return total;
}

/**
 * Generate grid points for scanning.
 * Uses index-based calculation to avoid floating-point accumulation drift,
 * ensuring the point count matches calculateTotalPoints().
 */
function generateGridPoints() {
    const latMin = parseFloat(document.getElementById('latMin').value);
    const latMax = parseFloat(document.getElementById('latMax').value);
    const lngMin = parseFloat(document.getElementById('lngMin').value);
    const lngMax = parseFloat(document.getElementById('lngMax').value);
    const step = parseFloat(document.getElementById('stepSize').value);

    const latSteps = gridSteps(latMax - latMin, step) + 1;
    const lngSteps = gridSteps(lngMax - lngMin, step) + 1;

    const points = [];
    for (let i = 0; i < latSteps; i++) {
        const lat = Math.min(latMin + i * step, latMax);
        for (let j = 0; j < lngSteps; j++) {
            const lng = Math.min(lngMin + j * step, lngMax);
            points.push({ lat: parseFloat(lat.toFixed(6)), lng: parseFloat(lng.toFixed(6)) });
        }
    }
    return points;
}

/**
 * Show how many grid points are already in the IndexedDB cache
 */
async function updateCoverageInfo() {
    const infoEl = document.getElementById('coverageInfo');
    if (!infoEl) return;
    try {
        const points = generateGridPoints();
        const total = points.length;
        const allCached = await getAllCachedPoints();
        const cachedKeys = new Set(
            allCached.filter(r => !r.isError).map(r => r.key)
        );
        let cachedCount = 0;
        for (const point of points) {
            if (cachedKeys.has(`${point.lat},${point.lng}`)) cachedCount++;
        }
        if (cachedCount > 0) {
            infoEl.textContent =
                `💾 ${cachedCount} of ${total} already cached — ${total - cachedCount} new API calls needed`;
        } else {
            infoEl.textContent = '';
        }
    } catch (e) {
        console.error('Error updating coverage info:', e);
    }
}

/**
 * Update progress display
 */
function updateProgress(current, total) {
    const percentage = Math.round((current / total) * 100);
    const progressBar = document.getElementById('progressBar');
    progressBar.style.width = percentage + '%';
    progressBar.textContent = percentage + '%';
    progressBar.setAttribute('aria-valuenow', percentage);
    
    document.getElementById('progressText').textContent = `Scanning point ${current} / ${total}`;
}

/**
 * Update statistics display
 */
function updateStats() {
    document.getElementById('statTotal').textContent = stats.total;
    
    const availablePercentage = stats.total > 0 
        ? Math.round((stats.available / stats.total) * 100) 
        : 0;
    document.getElementById('statAvailable').textContent = 
        `${stats.available} (${availablePercentage}%)`;
    
    document.getElementById('statNotAvailable').textContent = stats.notAvailable;
    document.getElementById('statErrors').textContent = stats.errors;
    document.getElementById('statCached').textContent = stats.cached;
}

/**
 * Process a single point: check coverage with retry
 * Returns { point, result, isError }
 */
async function processPoint(point) {
    let result = null;
    let isError = false;
    try {
        result = await checkCoverage(point.lat, point.lng);
    } catch (error) {
        // Retry once with a new token
        try {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            result = await checkCoverage(point.lat, point.lng);
        } catch (retryError) {
            console.error(`Failed to check coverage for ${point.lat}, ${point.lng}:`, retryError);
            isError = true;
        }
    }
    return { point, result, isError };
}

/**
 * Main scan function - processes points sequentially (one at a time).
 * Checks the IndexedDB cache first; skips API calls for already-cached points.
 */
async function startScan() {
    if (scanRunning) return;

    // Reset state
    scanRunning = true;
    scanPaused = false;
    stats = { total: 0, available: 0, notAvailable: 0, errors: 0, cached: 0 };
    scanResults = [];
    
    // Clear markers
    markersLayer.clearLayers();
    
    // Update UI
    document.getElementById('startBtn').disabled = true;
    document.getElementById('pauseBtn').disabled = false;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('progressText').textContent = 'Initializing scan...';
    document.getElementById('speedText').textContent = '';

    // Generate points
    const points = generateGridPoints();
    const total = points.length;
    const delay = parseInt(document.getElementById('delayMs').value);

    // Pre-fetch all cached points for fast O(1) lookup during the scan loop
    let cachedPointsMap = new Map();
    try {
        const allCached = await getAllCachedPoints();
        allCached.forEach(r => cachedPointsMap.set(r.key, r));
    } catch (e) {
        console.error('Error loading cache:', e);
    }

    const scanStartTime = Date.now();

    for (let i = 0; i < points.length; i++) {
        // Check if scan should stop
        if (!scanRunning) break;

        // Check if scan is paused
        while (scanPaused && scanRunning) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!scanRunning) break;

        const point = points[i];
        const cacheKey = `${point.lat},${point.lng}`;
        const cached = cachedPointsMap.get(cacheKey);

        try {
            if (cached && !cached.isError) {
                // Use cached result — no API call needed
                const markerData = addMarker(cached.lat, cached.lng, cached.result, false);
                scanResults.push({ ...markerData, isError: false });
                stats.total++;
                stats.cached++;
                if (cached.available) {
                    stats.available++;
                } else {
                    stats.notAvailable++;
                }
            } else {
                // Fresh API call
                const { result, isError } = await processPoint(point);

                if (isError) {
                    stats.errors++;
                }

                // Add marker and update results
                const markerData = addMarker(point.lat, point.lng, result, isError);
                scanResults.push({ ...markerData, isError });

                // Update statistics
                if (!isError) {
                    stats.total++;
                    if (markerData.available) {
                        stats.available++;
                    } else {
                        stats.notAvailable++;
                    }
                    // Save to IndexedDB cache (non-blocking)
                    putCachedPoint({
                        key: cacheKey,
                        lat: point.lat,
                        lng: point.lng,
                        available: markerData.available,
                        color: markerData.color,
                        result,
                        isError: false,
                        timestamp: Date.now()
                    }).catch(e => console.error('Error saving to cache:', e));
                }

                // Delay only for fresh API calls
                if (delay > 0) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        } catch (loopError) {
            console.error(`Unexpected error processing point ${i}:`, loopError);
            stats.errors++;
        }

        updateStats();
        updateProgress(i + 1, total);

        // Update speed display
        const elapsedSec = (Date.now() - scanStartTime) / 1000;
        if (elapsedSec > 0) {
            const speed = ((i + 1) / elapsedSec).toFixed(1);
            const remaining = total - (i + 1);
            const eta = remaining > 0 ? Math.round(remaining / ((i + 1) / elapsedSec)) : 0;
            const etaMin = Math.floor(eta / 60);
            const etaSec = eta % 60;
            document.getElementById('speedText').textContent = 
                `⚡ ${speed} pts/sec | ETA: ${etaMin}m ${etaSec}s`;
        }
    }

    // Scan complete
    if (scanRunning) {
        const totalTime = ((Date.now() - scanStartTime) / 1000).toFixed(1);
        const freshCount = stats.total - stats.cached;
        document.getElementById('progressText').textContent =
            `Scan complete! ${stats.total} points in ${totalTime}s (${stats.cached} cached, ${freshCount} fresh).`;
        document.getElementById('speedText').textContent = '';
        updateHeatmap();
        updateCoverageInfo();
    }

    // Reset UI
    document.getElementById('startBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('stopBtn').disabled = true;
    scanRunning = false;
}

/**
 * Pause scan
 */
function pauseScan() {
    if (!scanRunning) return;
    
    scanPaused = !scanPaused;
    const pauseBtn = document.getElementById('pauseBtn');
    
    if (scanPaused) {
        pauseBtn.innerHTML = '<i class="bi bi-play-fill"></i> Resume';
        pauseBtn.classList.remove('btn-warning');
        pauseBtn.classList.add('btn-info');
        document.getElementById('progressText').textContent = 'Scan paused';
    } else {
        pauseBtn.innerHTML = '<i class="bi bi-pause-fill"></i> Pause';
        pauseBtn.classList.remove('btn-info');
        pauseBtn.classList.add('btn-warning');
        document.getElementById('progressText').textContent = 'Scan resumed';
    }
}

/**
 * Stop scan
 */
function stopScan() {
    scanRunning = false;
    scanPaused = false;
    
    document.getElementById('startBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('pauseBtn').innerHTML = '<i class="bi bi-pause-fill"></i> Pause';
    document.getElementById('pauseBtn').classList.remove('btn-info');
    document.getElementById('pauseBtn').classList.add('btn-warning');
    document.getElementById('progressText').textContent = 'Scan stopped';
    
    if (scanResults.length > 0) {
        updateHeatmap();
    }
}

/**
 * Retry scanning for "Not Available" points - processes sequentially
 * @param {boolean} skipConfirm - skip the confirmation dialog (used when called programmatically)
 */
async function retryNotAvailablePoints(skipConfirm = false) {
    if (scanRunning) return;
    
    // Filter to get only "Not Available" points (not errors, just fiber not available)
    const notAvailablePoints = scanResults.filter(r => !r.isError && !r.available);
    
    if (notAvailablePoints.length === 0) {
        alert('No "Not Available" points to retry.');
        return;
    }
    
    const confirmRetry = skipConfirm ||
        confirm(`Found ${notAvailablePoints.length} "Not Available" points. Retry scanning these points?`);
    if (!confirmRetry) return;
    
    // Set scan as running
    scanRunning = true;
    scanPaused = false;
    
    // Update UI
    document.getElementById('startBtn').disabled = true;
    document.getElementById('pauseBtn').disabled = false;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('retryNotAvailableBtn').disabled = true;
    document.getElementById('progressText').textContent = 'Retrying Not Available points...';
    document.getElementById('speedText').textContent = '';
    
    const total = notAvailablePoints.length;
    const delay = parseInt(document.getElementById('delayMs').value);
    let updatedCount = 0;
    let nowAvailableCount = 0;

    const retryStartTime = Date.now();
    
    for (let i = 0; i < notAvailablePoints.length; i++) {
        // Check if scan should stop
        if (!scanRunning) break;
        
        // Check if scan is paused
        while (scanPaused && scanRunning) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (!scanRunning) break;

        const pointData = notAvailablePoints[i];
        try {
            const { point, result, isError } = await processPoint(pointData);

            // Find and remove old marker from map
            markersLayer.eachLayer(layer => {
                if (layer instanceof L.CircleMarker) {
                    const latlng = layer.getLatLng();
                    if (Math.abs(latlng.lat - point.lat) < COORDINATE_TOLERANCE && 
                        Math.abs(latlng.lng - point.lng) < COORDINATE_TOLERANCE) {
                        markersLayer.removeLayer(layer);
                    }
                }
            });
            
            // Add new marker with updated result
            const markerData = addMarker(point.lat, point.lng, result, isError);
            
            // Find and update the point in scanResults
            const resultIndex = scanResults.findIndex(r => 
                Math.abs(r.lat - point.lat) < COORDINATE_TOLERANCE && 
                Math.abs(r.lng - point.lng) < COORDINATE_TOLERANCE
            );
            
            if (resultIndex !== -1) {
                const oldResult = scanResults[resultIndex];
                
                // Update statistics - remove old count (we know it was "Not Available")
                if (!oldResult.isError && !oldResult.available) {
                    stats.notAvailable--;
                }
                
                // Update the result
                scanResults[resultIndex] = { ...markerData, isError };
                
                // Update statistics - add new count based on new status
                if (isError) {
                    stats.errors++;
                } else if (markerData.available) {
                    stats.available++;
                    nowAvailableCount++;
                } else {
                    stats.notAvailable++;
                }
                
                updatedCount++;

                // Update IndexedDB cache with refreshed result (non-blocking)
                if (!isError) {
                    putCachedPoint({
                        key: `${point.lat},${point.lng}`,
                        lat: point.lat,
                        lng: point.lng,
                        available: markerData.available,
                        color: markerData.color,
                        result,
                        isError: false,
                        timestamp: Date.now()
                    }).catch(e => console.error('Error updating cache:', e));
                }
            }
        } catch (loopError) {
            console.error(`Unexpected error retrying point ${i}:`, loopError);
            stats.errors++;
        }

        updateStats();
        updateProgress(i + 1, total);

        // Update speed display
        const elapsedSec = (Date.now() - retryStartTime) / 1000;
        if (elapsedSec > 0) {
            const speed = ((i + 1) / elapsedSec).toFixed(1);
            const remaining = total - (i + 1);
            const eta = remaining > 0 ? Math.round(remaining / ((i + 1) / elapsedSec)) : 0;
            const etaMin = Math.floor(eta / 60);
            const etaSec = eta % 60;
            document.getElementById('speedText').textContent = 
                `⚡ ${speed} pts/sec | ETA: ${etaMin}m ${etaSec}s`;
        }
        
        // Delay before next request
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    // Retry complete
    if (scanRunning) {
        const totalTime = ((Date.now() - retryStartTime) / 1000).toFixed(1);
        const message = `Retry complete! Updated ${updatedCount} points in ${totalTime}s. ${nowAvailableCount} are now available.`;
        document.getElementById('progressText').textContent = message;
        document.getElementById('speedText').textContent = '';
        updateHeatmap();
    }
    
    // Reset UI
    document.getElementById('startBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('retryNotAvailableBtn').disabled = false;
    scanRunning = false;
}

/**
 * Export all cached results as JSON
 */
async function exportJSON() {
    let allPoints;
    try {
        allPoints = await getAllCachedPoints();
    } catch (e) {
        console.error('Error reading cache:', e);
        allPoints = [];
    }

    if (allPoints.length === 0) {
        alert('No cached results to export');
        return;
    }

    const data = {
        exportDate: new Date().toISOString(),
        totalPoints: allPoints.length,
        results: allPoints
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sfax-fiber-scan-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Export all cached results as CSV
 */
async function exportCSV() {
    let allPoints;
    try {
        allPoints = await getAllCachedPoints();
    } catch (e) {
        console.error('Error reading cache:', e);
        allPoints = [];
    }

    if (allPoints.length === 0) {
        alert('No cached results to export');
        return;
    }

    let csv = 'Latitude,Longitude,Fiber Available,Status,Error\n';
    
    allPoints.forEach(result => {
        const available = result.available ? 'Yes' : 'No';
        const error = result.isError ? 'Yes' : 'No';
        const status = result.available ? 'Available' : (result.isError ? 'Error' : 'Not Available');
        csv += `${result.lat},${result.lng},${available},${status},${error}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sfax-fiber-scan-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ===== IndexedDB Persistence Functions =====

/**
 * Load all cached points from IndexedDB and display them on the map.
 * @param {boolean} silent - when true, suppress informational alerts (used for auto-load on startup)
 */
async function loadFromIndexedDB(silent = false) {
    let allCached;
    try {
        allCached = await getAllCachedPoints();
    } catch (e) {
        console.error('Error loading from IndexedDB:', e);
        if (!silent) alert('Error loading cached results');
        return;
    }

    if (allCached.length === 0) {
        if (!silent) alert('No cached results found');
        return;
    }

    // Clear current display
    markersLayer.clearLayers();
    scanResults = [];
    stats = { total: 0, available: 0, notAvailable: 0, errors: 0, cached: 0 };

    // Restore markers from cache
    allCached.forEach(cached => {
        const color = cached.color || markerColor(cached.isError, cached.available);

        const marker = L.circleMarker([cached.lat, cached.lng], {
            radius: 6,
            fillColor: color,
            color: color,
            weight: 1,
            opacity: 0.4,
            fillOpacity: 0.25
        });

        const status = cached.available ? 'Fiber Available (GPON)' :
                      (cached.isError ? 'Error / Unknown' : 'Fiber Not Available');

        marker.bindPopup(`
            <div>
                <h6>${status}</h6>
                <p><strong>Coordinates:</strong><br>
                Lat: ${cached.lat.toFixed(5)}, Lng: ${cached.lng.toFixed(5)}</p>
            </div>
        `);

        marker.addTo(markersLayer);

        scanResults.push({
            lat: cached.lat,
            lng: cached.lng,
            available: cached.available,
            color,
            result: cached.result,
            isError: cached.isError
        });

        if (!cached.isError) {
            stats.total++;
            if (cached.available) stats.available++;
            else stats.notAvailable++;
        } else {
            stats.errors++;
        }
    });

    // Update UI
    updateStats();
    updateProgress(scanResults.length, scanResults.length);
    updateHeatmap();

    if (!silent) {
        const notAvailableCount = scanResults.filter(r => !r.isError && !r.available).length;
        if (notAvailableCount > 0) {
            const msg = `Loaded ${allCached.length} cached points (${notAvailableCount} "Not Available").\nRetry the "Not Available" points now?`;
            if (confirm(msg)) {
                retryNotAvailablePoints(true);
                return;
            }
        } else {
            alert(`Loaded ${allCached.length} cached points from IndexedDB`);
        }
    }
}

/**
 * Trigger the file chooser for JSON import
 */
function importFromJSON() {
    document.getElementById('importJsonInput').click();
}

/**
 * Handle the selected JSON file and import its records into IndexedDB
 */
async function handleImportJSON(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        const results = data.results || [];
        if (results.length === 0) {
            alert('No results found in the JSON file');
            return;
        }

        let importedCount = 0;
        for (const r of results) {
            if (r.lat == null || r.lng == null) continue;
            const key = r.key || `${r.lat},${r.lng}`;
            const isErr = r.isError ?? false;
            const avail = r.available ?? false;
            await putCachedPoint({
                key,
                lat: r.lat,
                lng: r.lng,
                available: avail,
                color: r.color || markerColor(isErr, avail),
                result: r.result || null,
                isError: isErr,
                timestamp: r.timestamp || Date.now()
            });
            importedCount++;
        }

        alert(`Imported ${importedCount} points into the cache. Click "Load Previous Results" to display them.`);
        updateCoverageInfo();
    } catch (error) {
        console.error('Error importing JSON:', error);
        alert('Error importing JSON file. Please make sure it is a valid scan export.');
    }

    // Reset file input so the same file can be re-selected if needed
    event.target.value = '';
}

/**
 * Clear all results
 */
function clearAll() {
    if (!confirm('Are you sure you want to clear all results from the map?')) {
        return;
    }

    markersLayer.clearLayers();
    scanResults = [];
    stats = { total: 0, available: 0, notAvailable: 0, errors: 0, cached: 0 };
    
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
        heatmapLayer = null;
    }
    
    updateStats();
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('progressBar').textContent = '0%';
    document.getElementById('progressText').textContent = 'Ready to scan';
    document.getElementById('coverageInfo').textContent = '';

    if (confirm('Also clear the IndexedDB cache? This permanently deletes all saved scan data.')) {
        clearCachedPoints()
            .then(() => alert('IndexedDB cache cleared.'))
            .catch(e => console.error('Error clearing cache:', e));
    }
}

// ===== Seed-file Initialization =====

/**
 * Try to seed the IndexedDB from a JSON file at the given URL.
 * Only inserts records whose key is NOT already in the DB (preserves user scans).
 * Returns { count, found } where found=true when the file existed and was parseable.
 */
async function tryImportSeedJSON(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return { count: 0, found: false };
        const data = await res.json();
        const results = data.results || [];
        if (!results.length) return { count: 0, found: true };

        // Load existing keys in one DB read for efficient lookup
        const existing = await getAllCachedPoints();
        const existingKeys = new Set(existing.map(r => r.key));

        let count = 0;
        for (const r of results) {
            if (r.lat == null || r.lng == null) continue;
            const key = r.key || `${r.lat},${r.lng}`;
            if (existingKeys.has(key)) continue;
            const isErr = r.isError ?? false;
            const avail = r.available ?? false;
            await putCachedPoint({
                key,
                lat: r.lat,
                lng: r.lng,
                available: avail,
                color: r.color || markerColor(isErr, avail),
                result: r.result || null,
                isError: isErr,
                timestamp: r.timestamp || Date.now()
            });
            count++;
        }
        if (count > 0) console.log(`Seeded ${count} new records from ${url}`);
        return { count, found: true };
    } catch (e) {
        return { count: 0, found: false }; // File absent or parse error — silently skip
    }
}

/**
 * Try to seed the IndexedDB from a CSV file at the given URL.
 * Expected columns: Latitude,Longitude,Fiber Available,Status,Error
 * Only inserts records whose key is NOT already in the DB.
 */
async function tryImportSeedCSV(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return 0;
        const text = await res.text();
        const lines = text.trim().split('\n');
        if (lines.length <= 1) return 0; // header only

        const existing = await getAllCachedPoints();
        const existingKeys = new Set(existing.map(r => r.key));

        let count = 0;
        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(',');
            if (parts.length < 2) continue;
            const lat = parseFloat(parts[0]);
            const lng = parseFloat(parts[1]);
            if (isNaN(lat) || isNaN(lng)) continue;
            const latVal = parseFloat(lat.toFixed(6));
            const lngVal = parseFloat(lng.toFixed(6));
            const key = `${latVal},${lngVal}`;
            if (existingKeys.has(key)) continue;
            const avail = parts[2] ? parts[2].trim().toLowerCase() === 'yes' : false;
            const isErr = parts[4] ? parts[4].trim().toLowerCase() === 'yes' : false;
            await putCachedPoint({
                key,
                lat: latVal,
                lng: lngVal,
                available: avail,
                color: markerColor(isErr, avail),
                result: null,
                isError: isErr,
                timestamp: Date.now()
            });
            count++;
        }
        if (count > 0) console.log(`Seeded ${count} new records from ${url}`);
        return count;
    } catch (e) {
        return 0; // File absent or parse error — silently skip
    }
}

/**
 * Seed the IndexedDB from optional data files in the app root.
 * Tries cached_coverage.json first, then cached_coverage.csv.
 * Already-cached keys are never overwritten.
 * Returns { totalImported, jsonFound } — jsonFound=true when cached_coverage.json existed.
 */
async function seedFromFile() {
    const json = await tryImportSeedJSON('./cached_coverage.json');
    const csvCount = await tryImportSeedCSV('./cached_coverage.csv');
    return { totalImported: json.count + csvCount, jsonFound: json.found };
}

/**
 * Write all current IndexedDB points to cached_coverage.json via the local dev server.
 * Only works on localhost (requires the POST /api/save-coverage endpoint in server.js).
 * Silently skipped when not on localhost.
 */
async function syncCoverageJsonToServer() {
    if (!isLocalhost) return;
    try {
        const allPoints = await getAllCachedPoints();
        if (allPoints.length === 0) return;
        const data = {
            exportDate: new Date().toISOString(),
            totalPoints: allPoints.length,
            results: allPoints
        };
        const res = await fetch('/api/save-coverage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (res.ok) {
            console.log(`cached_coverage.json synced (${allPoints.length} points)`);
        }
    } catch (e) {
        console.error('Error syncing cached_coverage.json:', e);
    }
}

// ===== Event Listeners =====

document.addEventListener('DOMContentLoaded', function() {
    // Initialize map
    initMap();
    
    // Calculate initial total points
    calculateTotalPoints();
    
    // Input change listeners
    document.getElementById('latMin').addEventListener('change', calculateTotalPoints);
    document.getElementById('latMax').addEventListener('change', calculateTotalPoints);
    document.getElementById('lngMin').addEventListener('change', calculateTotalPoints);
    document.getElementById('lngMax').addEventListener('change', calculateTotalPoints);
    document.getElementById('stepSize').addEventListener('change', calculateTotalPoints);
    
    // Control buttons
    document.getElementById('startBtn').addEventListener('click', startScan);
    document.getElementById('pauseBtn').addEventListener('click', pauseScan);
    document.getElementById('stopBtn').addEventListener('click', stopScan);
    
    // Export buttons
    document.getElementById('exportJsonBtn').addEventListener('click', exportJSON);
    document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);

    // Import JSON
    document.getElementById('importJsonBtn').addEventListener('click', importFromJSON);
    document.getElementById('importJsonInput').addEventListener('change', handleImportJSON);
    
    // Other actions
    document.getElementById('retryNotAvailableBtn').addEventListener('click', retryNotAvailablePoints);
    document.getElementById('loadPreviousBtn').addEventListener('click', loadFromIndexedDB);
    document.getElementById('clearBtn').addEventListener('click', clearAll);
    
    // Heatmap toggle
    document.getElementById('showHeatmap').addEventListener('change', function(e) {
        if (e.target.checked) {
            if (scanResults.length > 0) {
                updateHeatmap();
            }
        } else {
            if (heatmapLayer) {
                map.removeLayer(heatmapLayer);
            }
        }
    });

    // Hide all points toggle
    document.getElementById('hidePoints').addEventListener('change', function(e) {
        if (e.target.checked) {
            map.removeLayer(markersLayer);
        } else {
            markersLayer.addTo(map);
        }
    });
    
    // Rectangle draw toggle
    document.getElementById('drawRectangle').addEventListener('change', function(e) {
        if (e.target.checked) {
            map.addControl(drawControl);
        } else {
            map.removeControl(drawControl);
            drawnItems.clearLayers();
        }
    });
    
    // Always seed from cached_coverage.json / .csv on startup, then load all cached data automatically.
    // If cached_coverage.json was missing, sync the current DB to it (localhost only).
    seedFromFile()
        .then(async ({ jsonFound }) => {
            if (!jsonFound) {
                await syncCoverageJsonToServer();
            }
            return loadFromIndexedDB(true);
        })
        .catch(e => console.error('Error initializing data:', e));
});
