// ===== Utilities =====

/**
 * Escape a value for safe inclusion in HTML.
 * Prevents XSS when interpolating API response data into popup content.
 */
function escapeHtml(unsafe) {
    if (unsafe == null) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

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

// On localhost, route API calls through the local dev server proxy to avoid CORS issues.
// In production (GitHub Pages / custom domain), call the API directly.
const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const API_BASE_URL = isLocalhost
    ? "/api/rsm/RSMService.svc"
    : "https://gis.tunisietelecom.tn/rsm/RSMService.svc";

/**
 * Build API URL for the given endpoint path.
 */
function apiUrl(endpoint) {
    return API_BASE_URL + endpoint;
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

// ===== Loading Overlay Helpers =====

function showLoading(message) {
    const overlay = document.getElementById('loadingOverlay');
    const msgEl = document.getElementById('loadingMessage');
    if (msgEl) msgEl.textContent = message || 'Loading...';
    if (overlay) overlay.classList.remove('hidden');
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
}

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

// ===== Bitmap Coverage Encoding =====

/**
 * Detect the grid step size from an array of coordinate values.
 * Returns the smallest non-zero difference between sorted unique values,
 * or null if fewer than 2 unique values exist.
 */
function detectStep(values) {
    const unique = [...new Set(values.map(v => parseFloat(v.toFixed(6))))].sort((a, b) => a - b);
    if (unique.length < 2) return null;
    let minDiff = Infinity;
    for (let i = 1; i < unique.length; i++) {
        const diff = unique[i] - unique[i - 1];
        if (diff > 1e-9 && diff < minDiff) minDiff = diff;
    }
    return minDiff < Infinity ? parseFloat(minDiff.toFixed(6)) : null;
}

/**
 * Encode an array of { lat, lng } points into a base64 bitmap string.
 * Each bit represents a grid cell: 1 = fiber available.
 */
function encodeBitmap(points, latMin, lngMin, latSteps, lngSteps, step) {
    const totalBits = latSteps * lngSteps;
    const bytes = new Uint8Array(Math.ceil(totalBits / 8));
    for (const p of points) {
        const row = Math.round((p.lat - latMin) / step);
        const col = Math.round((p.lng - lngMin) / step);
        if (row < 0 || row >= latSteps || col < 0 || col >= lngSteps) continue;
        const idx = row * lngSteps + col;
        bytes[idx >> 3] |= (1 << (idx & 7));
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Decode a base64 bitmap string back into an array of { lat, lng } points.
 */
function decodeBitmap(base64, latMin, lngMin, latSteps, lngSteps, step) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    const points = [];
    const totalBits = latSteps * lngSteps;
    for (let idx = 0; idx < totalBits; idx++) {
        if (bytes[idx >> 3] & (1 << (idx & 7))) {
            const row = Math.floor(idx / lngSteps);
            const col = idx % lngSteps;
            const lat = parseFloat((latMin + row * step).toFixed(6));
            const lng = parseFloat((lngMin + col * step).toFixed(6));
            points.push({ lat, lng });
        }
    }
    return points;
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
            fwa: 0,
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

    // Create popup content — all dynamic values are escaped to prevent XSS
    let popupContent = `
        <div>
            <h6>${escapeHtml(status)}</h6>
            <p><strong>Coordinates:</strong><br>
            Lat: ${escapeHtml(lat.toFixed(5))}, Lng: ${escapeHtml(lng.toFixed(5))}</p>
    `;

    if (!isError && result && result.taghtiaGPON) {
        if (available && result.taghtiaGPON.Debit) {
            popupContent += `<p><strong>Speed:</strong> ${escapeHtml(result.taghtiaGPON.Debit)}</p>`;
        }
        
        // Add ADSL info if available
        if (result.taghtiaADSL && result.taghtiaADSL.Taghtia == "OUI") {
            popupContent += `<p><strong>ADSL:</strong> Available</p>`;
        }
        
        // Add VDSL info if available
        if (result.taghtiaVDSL && result.taghtiaVDSL.Taghtia == "OUI") {
            popupContent += `<p><strong>VDSL:</strong> Available</p>`;
        }
        
        // Add FWA (5G Fixed Wireless Access) info if available
        if (result.taghtiaFWA && result.taghtiaFWA.Taghtia == "OUI" && result.taghtiaFWA.Code_taghtia == "200") {
            popupContent += `<p><strong>5G FWA:</strong> Available (Class ${escapeHtml(result.taghtiaFWA.Classe)})</p>`;
            if (result.taghtiaFWA.saturated === 1) {
                popupContent += `<p><strong>FWA Zone:</strong> <span style="color:red">Saturated</span></p>`;
            } else if (result.taghtiaFWA.saturated === 0) {
                popupContent += `<p><strong>FWA Zone:</strong> <span style="color:green">Capacity Available</span></p>`;
            }
        }
        
        // Add PC info if available
        if (result.taghtiaGPON.PC_CODE) {
            popupContent += `<p><strong>PC Code:</strong> ${escapeHtml(result.taghtiaGPON.PC_CODE)}</p>`;
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
 * Update heatmap layer with current results.
 * @param {boolean} forceShow - when true, add the heatmap to the map unconditionally
 *                              (ignores the checkbox — used by the startup initializer)
 */
function updateHeatmap(forceShow = false) {
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
    }

    // Only show fiber-available points so the heatmap represents coverage
    const heatData = scanResults
        .filter(r => !r.isError && r.available)
        .map(r => [r.lat, r.lng, 0.3]);

    heatmapLayer = L.heatLayer(heatData, {
        radius: 10,
        blur: 15,
        maxZoom: 17,
        max: 1.0,
        minOpacity: 0.3,
        gradient: {
            0.4: '#28a745',
            1.0: '#155724'
        }
    });

    if (forceShow || document.getElementById('showHeatmap').checked) {
        heatmapLayer.addTo(map);
    }
}

/**
 * Apply the default map visibility state after data has been loaded:
 *  - Heatmap layer: built from current scanResults and explicitly added to the map;
 *    the #showHeatmap checkbox is set to checked.
 *  - Point markers: markersLayer is removed from the map;
 *    the #hidePoints checkbox is set to checked.
 * Called explicitly after the startup data load to guarantee a deterministic visual state.
 */
function applyInitialMapVisibility() {
    // 1. Sync checkbox states to the desired defaults
    document.getElementById('showHeatmap').checked = true;
    document.getElementById('hidePoints').checked = true;

    // 2. Build the heatmap layer and force it onto the map
    updateHeatmap(true);

    // 3. Ensure point markers are not on the map
    if (map.hasLayer(markersLayer)) {
        map.removeLayer(markersLayer);
    }
}



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
        const reqStatus = document.getElementById('currentRequestStatus');

        try {
            if (cached && !cached.isError) {
                // Use cached result — no API call needed
                if (reqStatus) reqStatus.textContent = `💾 Cached — (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)})`;
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
                if (reqStatus) reqStatus.textContent = `⏳ Checking (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)})...`;
                const { result, isError } = await processPoint(point);

                if (isError) {
                    stats.errors++;
                    if (reqStatus) reqStatus.textContent = `⚠️ Error — (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)})`;
                }

                // Add marker and update results
                const markerData = addMarker(point.lat, point.lng, result, isError);
                scanResults.push({ ...markerData, isError });

                // Update statistics
                if (!isError) {
                    stats.total++;
                    if (markerData.available) {
                        stats.available++;
                        if (reqStatus) reqStatus.textContent = `✅ Available — (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)})`;
                    } else {
                        stats.notAvailable++;
                        if (reqStatus) reqStatus.textContent = `🔴 Not available — (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)})`;
                    }
                    // Save to IndexedDB cache (non-blocking) — only available points
                    if (markerData.available) {
                        putCachedPoint({
                            key: cacheKey,
                            lat: point.lat,
                            lng: point.lng,
                            available: true,
                            color: markerData.color,
                            result,
                            isError: false,
                            timestamp: Date.now()
                        }).catch(e => console.error('Error saving to cache:', e));
                    }
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
        document.getElementById('currentRequestStatus').textContent = '';
        updateHeatmap();
        updateCoverageInfo();
        syncCoverageJsonToServer();
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
    document.getElementById('currentRequestStatus').textContent = '';
    
    if (scanResults.length > 0) {
        updateHeatmap();
        syncCoverageJsonToServer();
    }
}

/**
 * Export all cached results as JSON
 */
async function exportJSON() {
    showLoading('Exporting JSON...');
    let allPoints;
    try {
        allPoints = await getAllCachedPoints();
    } catch (e) {
        console.error('Error reading cache:', e);
        allPoints = [];
    }

    if (allPoints.length === 0) {
        hideLoading();
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
    hideLoading();
}

/**
 * Export all cached results as CSV
 */
async function exportCSV() {
    showLoading('Exporting CSV...');
    let allPoints;
    try {
        allPoints = await getAllCachedPoints();
    } catch (e) {
        console.error('Error reading cache:', e);
        allPoints = [];
    }

    if (allPoints.length === 0) {
        hideLoading();
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
    hideLoading();
}

// ===== IndexedDB Persistence Functions =====

/**
 * Load all cached points from IndexedDB and display them on the map.
 * @param {boolean} silent - when true, suppress informational alerts (used for auto-load on startup)
 */
async function loadFromIndexedDB(silent = false) {
    if (!silent) showLoading('Loading results from cache...');
    let allCached;
    try {
        allCached = await getAllCachedPoints();
    } catch (e) {
        console.error('Error loading from IndexedDB:', e);
        if (!silent) { hideLoading(); alert('Error loading cached results'); }
        return;
    }

    if (allCached.length === 0) {
        if (!silent) { hideLoading(); alert('No cached results found'); }
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
                <h6>${escapeHtml(status)}</h6>
                <p><strong>Coordinates:</strong><br>
                Lat: ${escapeHtml(cached.lat.toFixed(5))}, Lng: ${escapeHtml(cached.lng.toFixed(5))}</p>
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
        hideLoading();
        alert(`Loaded ${allCached.length} cached points from IndexedDB`);
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

    showLoading('Importing data...');
    try {
        const text = await file.text();
        const data = JSON.parse(text);

        const results = data.results || [];
        if (results.length === 0) {
            hideLoading();
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

        hideLoading();
        alert(`Imported ${importedCount} points into the cache. Click "Load Previous Results" to display them.`);
        updateCoverageInfo();
    } catch (error) {
        console.error('Error importing JSON:', error);
        hideLoading();
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
        showLoading('Clearing cache...');
        clearCachedPoints()
            .then(() => { hideLoading(); alert('IndexedDB cache cleared.'); })
            .catch(e => { hideLoading(); console.error('Error clearing cache:', e); });
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
        if (!res.ok) return { count: 0, found: false, isBitmap: false };
        const data = await res.json();

        // Load existing keys in one DB read for efficient lookup
        const existing = await getAllCachedPoints();
        const existingKeys = new Set(existing.map(r => r.key));

        let count = 0;

        // Bitmap format (version 3)
        if (data.version === 3 && data.bitmap) {
            const { bounds, step, latSteps, lngSteps, bitmap } = data;
            const points = decodeBitmap(bitmap, bounds.latMin, bounds.lngMin, latSteps, lngSteps, step);
            for (const p of points) {
                const key = `${p.lat},${p.lng}`;
                if (existingKeys.has(key)) continue;
                await putCachedPoint({
                    key,
                    lat: p.lat,
                    lng: p.lng,
                    available: true,
                    color: '#28a745',
                    result: null,
                    isError: false,
                    timestamp: Date.now()
                });
                count++;
            }
            if (count > 0) console.log(`Seeded ${count} new records from bitmap (${url})`);
            return { count, found: true, isBitmap: true };
        }

        // Legacy format (array of point objects)
        const results = data.results || [];
        if (!results.length) return { count: 0, found: true, isBitmap: false };

        for (const r of results) {
            if (r.lat == null || r.lng == null) continue;
            const isErr = r.isError ?? false;
            const avail = r.available ?? false;
            // Only cache available (fiber-covered) points
            if (!avail || isErr) continue;
            const key = r.key || `${r.lat},${r.lng}`;
            if (existingKeys.has(key)) continue;
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
        if (count > 0) console.log(`Seeded ${count} new records from legacy JSON (${url})`);
        return { count, found: true, isBitmap: false };
    } catch (e) {
        return { count: 0, found: false, isBitmap: false }; // File absent or parse error — silently skip
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
            // Only cache available (fiber-covered) points
            if (!avail || isErr) continue;
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
 * Tries cached_coverage.json first; falls back to cached_coverage.csv only if JSON was absent.
 * Already-cached keys are never overwritten.
 * Returns { totalImported, jsonFound } — jsonFound=true when cached_coverage.json existed.
 */
async function seedFromFile() {
    const json = await tryImportSeedJSON('./cached_coverage.json');
    // Only try CSV fallback if JSON seed file was not found (avoids a 404 console error)
    const csvCount = json.found ? 0 : await tryImportSeedCSV('./cached_coverage.csv');
    return { totalImported: json.count + csvCount, jsonFound: json.found, isBitmap: json.isBitmap || false };
}

/**
 * Write fiber-available points from IndexedDB to cached_coverage.json via the local dev server.
 * Only available points are saved to keep the file small.
 * Only works on localhost (requires the POST /api/save-coverage endpoint in server.js).
 * Silently skipped when not on localhost.
 */
async function syncCoverageJsonToServer() {
    if (!isLocalhost) return;
    try {
        const allPoints = await getAllCachedPoints();
        // Only persist available (fiber-covered) points
        const availablePoints = allPoints.filter(p => p.available && !p.isError);
        if (availablePoints.length === 0) return;

        // Derive grid parameters from the actual data
        const lats = availablePoints.map(p => p.lat);
        const lngs = availablePoints.map(p => p.lng);
        const latMin = Math.min(...lats);
        const latMax = Math.max(...lats);
        const lngMin = Math.min(...lngs);
        const lngMax = Math.max(...lngs);
        const step = detectStep(lats) || detectStep(lngs) || 0.002;
        const latSteps = Math.round((latMax - latMin) / step) + 1;
        const lngSteps = Math.round((lngMax - lngMin) / step) + 1;

        const data = {
            version: 3,
            exportDate: new Date().toISOString(),
            bounds: { latMin, latMax, lngMin, lngMax },
            step,
            latSteps,
            lngSteps,
            totalPoints: availablePoints.length,
            bitmap: encodeBitmap(availablePoints, latMin, lngMin, latSteps, lngSteps, step)
        };
        const res = await fetch('/api/save-coverage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (res.ok) {
            console.log(`cached_coverage.json synced as bitmap (${availablePoints.length} points, ${(JSON.stringify(data).length / 1024).toFixed(1)} KB)`);
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
    
    // Strict startup sequence:
    // 1. Seed IndexedDB from cached_coverage.json / .csv (no-op if already up to date)
    // 2. If cached_coverage.json was missing or legacy format, resync as bitmap (localhost only)
    // 3. Load all cached points into scanResults and render markers into markersLayer
    // 4. Explicitly apply the default map visibility: heatmap ON, point markers HIDDEN
    // Sidebar toggle (mobile)
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');

    function openSidebar() {
        sidebar.classList.add('show');
        sidebarBackdrop.classList.remove('hidden');
        sidebarToggle.textContent = '\u2715';
    }

    function closeSidebar() {
        sidebar.classList.remove('show');
        sidebarBackdrop.classList.add('hidden');
        sidebarToggle.textContent = '\u2630';
    }

    sidebarToggle.addEventListener('click', function() {
        if (sidebar.classList.contains('show')) {
            closeSidebar();
        } else {
            openSidebar();
        }
    });

    sidebarBackdrop.addEventListener('click', closeSidebar);

    // Legend toggle
    const mapLegend = document.getElementById('mapLegend');
    const legendToggleBtn = document.getElementById('legendToggleBtn');
    const legendCloseBtn = document.getElementById('legendCloseBtn');
    const showLegendCheckbox = document.getElementById('showLegend');

    function setLegendVisible(visible) {
        if (visible) {
            mapLegend.classList.remove('hidden');
            legendToggleBtn.classList.add('hidden');
            showLegendCheckbox.checked = true;
        } else {
            mapLegend.classList.add('hidden');
            legendToggleBtn.classList.remove('hidden');
            showLegendCheckbox.checked = false;
        }
    }

    legendCloseBtn.addEventListener('click', function() {
        setLegendVisible(false);
    });

    legendToggleBtn.addEventListener('click', function() {
        setLegendVisible(true);
    });

    showLegendCheckbox.addEventListener('change', function(e) {
        setLegendVisible(e.target.checked);
    });

    // Strict startup sequence with loading overlay
    showLoading('Loading cached coverage data...');
    seedFromFile()
        .then(async ({ jsonFound, isBitmap }) => {
            if (!jsonFound || !isBitmap) {
                showLoading('Saving coverage data...');
                await syncCoverageJsonToServer();
            }
            showLoading('Rendering map data...');
            await loadFromIndexedDB(true);
            applyInitialMapVisibility();
            hideLoading();
        })
        .catch(e => { hideLoading(); console.error('Error initializing data:', e); });
});
