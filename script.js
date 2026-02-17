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

// Statistics
let stats = {
    total: 0,
    available: 0,
    notAvailable: 0,
    errors: 0
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
        const response = await fetch("https://geo.tunisietelecom.tn/rsm/RSMService.svc/getAppVersion");
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
 * Fetch multiple unique tokens sequentially.
 * Each token requires its own getAppVersion call to ensure uniqueness.
 */
async function getTokens(count) {
    const tokens = [];
    for (let i = 0; i < count; i++) {
        tokens.push(await getToken());
    }
    return tokens;
}

/**
 * Check fiber coverage for a specific coordinate
 * If a pre-fetched token is provided, it will be used directly;
 * otherwise a fresh token is generated (for single/non-batch calls).
 */
async function checkCoverage(lat, lng, prefetchedToken) {
    const token = prefetchedToken || await getToken();
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
        const response = await fetch("https://geo.tunisietelecom.tn/rsm/RSMService.svc/TaghtiaUltimate", {
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

    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    // Initialize marker layer
    markersLayer = L.layerGroup().addTo(map);

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

    // Create circle marker
    const marker = L.circleMarker([lat, lng], {
        radius: 6,
        fillColor: color,
        color: color,
        weight: 1,
        opacity: 0.7,
        fillOpacity: 0.5
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

    const heatData = scanResults
        .filter(r => !r.isError)
        .map(r => {
            const intensity = r.available ? 1.0 : 0.0;
            return [r.lat, r.lng, intensity];
        });

    heatmapLayer = L.heatLayer(heatData, {
        radius: 25,
        blur: 15,
        maxZoom: 17,
        max: 1.0,
        gradient: {
            0.0: '#dc3545',
            0.5: '#ffc107',
            1.0: '#28a745'
        }
    });

    if (document.getElementById('showHeatmap').checked) {
        heatmapLayer.addTo(map);
    }
}

// ===== Scan Functions =====

/**
 * Calculate total number of points to scan
 */
function calculateTotalPoints() {
    const latMin = parseFloat(document.getElementById('latMin').value);
    const latMax = parseFloat(document.getElementById('latMax').value);
    const lngMin = parseFloat(document.getElementById('lngMin').value);
    const lngMax = parseFloat(document.getElementById('lngMax').value);
    const step = parseFloat(document.getElementById('stepSize').value);

    const latSteps = Math.ceil((latMax - latMin) / step) + 1;
    const lngSteps = Math.ceil((lngMax - lngMin) / step) + 1;
    const total = latSteps * lngSteps;

    document.getElementById('totalPoints').textContent = total;
    return total;
}

/**
 * Generate grid points for scanning
 */
function generateGridPoints() {
    const latMin = parseFloat(document.getElementById('latMin').value);
    const latMax = parseFloat(document.getElementById('latMax').value);
    const lngMin = parseFloat(document.getElementById('lngMin').value);
    const lngMax = parseFloat(document.getElementById('lngMax').value);
    const step = parseFloat(document.getElementById('stepSize').value);

    const points = [];
    for (let lat = latMin; lat <= latMax; lat += step) {
        for (let lng = lngMin; lng <= lngMax; lng += step) {
            points.push({ lat: parseFloat(lat.toFixed(6)), lng: parseFloat(lng.toFixed(6)) });
        }
    }
    return points;
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
}

/**
 * Process a single point: check coverage with retry
 * Accepts a pre-fetched token to ensure each parallel request uses its own unique token.
 * Returns { point, result, isError }
 */
async function processPoint(point, token) {
    let result = null;
    let isError = false;
    try {
        result = await checkCoverage(point.lat, point.lng, token);
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
 * Main scan function - processes points in parallel batches
 */
async function startScan() {
    if (scanRunning) return;

    // Reset state
    scanRunning = true;
    scanPaused = false;
    stats = { total: 0, available: 0, notAvailable: 0, errors: 0 };
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
    const concurrency = parseInt(document.getElementById('concurrency').value) || 5;

    const scanStartTime = Date.now();
    let processed = 0;

    for (let i = 0; i < points.length; i += concurrency) {
        // Check if scan should stop
        if (!scanRunning) break;

        // Check if scan is paused
        while (scanPaused && scanRunning) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!scanRunning) break;

        // Pre-fetch unique tokens for each point in the batch (sequentially to ensure uniqueness)
        const batch = points.slice(i, Math.min(i + concurrency, points.length));
        const tokens = await getTokens(batch.length);

        // Fire all coverage requests in parallel, each with its own pre-fetched token
        const promises = batch.map((point, idx) => processPoint(point, tokens[idx]));
        const results = await Promise.allSettled(promises);

        // Process batch results
        for (const settled of results) {
            if (!scanRunning) break;

            const { point, result, isError } = settled.status === 'fulfilled' 
                ? settled.value 
                : { point: null, result: null, isError: true };

            if (!point) continue;

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
            }
        }

        processed = Math.min(i + batch.length, points.length);
        updateStats();
        updateProgress(processed, total);

        // Update speed display
        const elapsedSec = (Date.now() - scanStartTime) / 1000;
        if (elapsedSec > 0) {
            const speed = (processed / elapsedSec).toFixed(1);
            const remaining = total - processed;
            const eta = remaining > 0 ? Math.round(remaining / (processed / elapsedSec)) : 0;
            const etaMin = Math.floor(eta / 60);
            const etaSec = eta % 60;
            document.getElementById('speedText').textContent = 
                `⚡ ${speed} pts/sec | ETA: ${etaMin}m ${etaSec}s`;
        }

        // Delay before next batch
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    // Scan complete
    if (scanRunning) {
        const totalTime = ((Date.now() - scanStartTime) / 1000).toFixed(1);
        document.getElementById('progressText').textContent = `Scan complete! ${stats.total} points scanned in ${totalTime}s.`;
        document.getElementById('speedText').textContent = '';
        updateHeatmap();
        saveToLocalStorage();
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
        saveToLocalStorage();
    }
}

/**
 * Retry scanning for "Not Available" points - processes in parallel batches
 */
async function retryNotAvailablePoints() {
    if (scanRunning) return;
    
    // Filter to get only "Not Available" points (not errors, just fiber not available)
    const notAvailablePoints = scanResults.filter(r => !r.isError && !r.available);
    
    if (notAvailablePoints.length === 0) {
        alert('No "Not Available" points to retry.');
        return;
    }
    
    const confirmRetry = confirm(`Found ${notAvailablePoints.length} "Not Available" points. Retry scanning these points?`);
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
    const concurrency = parseInt(document.getElementById('concurrency').value) || 5;
    let updatedCount = 0;
    let nowAvailableCount = 0;

    const retryStartTime = Date.now();
    let processed = 0;
    
    for (let i = 0; i < notAvailablePoints.length; i += concurrency) {
        // Check if scan should stop
        if (!scanRunning) break;
        
        // Check if scan is paused
        while (scanPaused && scanRunning) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (!scanRunning) break;

        // Pre-fetch unique tokens for each point in the batch (sequentially to ensure uniqueness)
        const batch = notAvailablePoints.slice(i, Math.min(i + concurrency, notAvailablePoints.length));
        const tokens = await getTokens(batch.length);

        // Fire all coverage requests in parallel, each with its own pre-fetched token
        const promises = batch.map((point, idx) => processPoint(point, tokens[idx]));
        const results = await Promise.allSettled(promises);

        // Process batch results
        for (const settled of results) {
            if (!scanRunning) break;

            const { point, result, isError } = settled.status === 'fulfilled' 
                ? settled.value 
                : { point: null, result: null, isError: true };

            if (!point) continue;

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
            }
        }

        processed = Math.min(i + batch.length, notAvailablePoints.length);
        updateStats();
        updateProgress(processed, total);

        // Update speed display
        const elapsedSec = (Date.now() - retryStartTime) / 1000;
        if (elapsedSec > 0) {
            const speed = (processed / elapsedSec).toFixed(1);
            const remaining = total - processed;
            const eta = remaining > 0 ? Math.round(remaining / (processed / elapsedSec)) : 0;
            const etaMin = Math.floor(eta / 60);
            const etaSec = eta % 60;
            document.getElementById('speedText').textContent = 
                `⚡ ${speed} pts/sec | ETA: ${etaMin}m ${etaSec}s`;
        }
        
        // Delay before next batch
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
        saveToLocalStorage();
    }
    
    // Reset UI
    document.getElementById('startBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('retryNotAvailableBtn').disabled = false;
    scanRunning = false;
}

// ===== Export Functions =====

/**
 * Export results as JSON
 */
function exportJSON() {
    if (scanResults.length === 0) {
        alert('No results to export');
        return;
    }

    const data = {
        scanDate: new Date().toISOString(),
        totalPoints: scanResults.length,
        statistics: stats,
        results: scanResults
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
 * Export results as CSV
 */
function exportCSV() {
    if (scanResults.length === 0) {
        alert('No results to export');
        return;
    }

    let csv = 'Latitude,Longitude,Fiber Available,Status,Error\n';
    
    scanResults.forEach(result => {
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

// ===== LocalStorage Functions =====

/**
 * Save results to localStorage
 */
function saveToLocalStorage() {
    const data = {
        scanDate: new Date().toISOString(),
        statistics: stats,
        results: scanResults
    };
    localStorage.setItem('sfaxFiberScanResults', JSON.stringify(data));
}

/**
 * Load results from localStorage
 */
function loadFromLocalStorage() {
    const data = localStorage.getItem('sfaxFiberScanResults');
    if (!data) {
        alert('No previous results found');
        return;
    }

    try {
        const parsed = JSON.parse(data);
        
        // Clear current results
        markersLayer.clearLayers();
        scanResults = parsed.results || [];
        stats = parsed.statistics || { total: 0, available: 0, notAvailable: 0, errors: 0 };
        
        // Restore markers
        scanResults.forEach(result => {
            const marker = L.circleMarker([result.lat, result.lng], {
                radius: 6,
                fillColor: result.color,
                color: result.color,
                weight: 1,
                opacity: 0.7,
                fillOpacity: 0.5
            });
            
            let status = result.available ? 'Fiber Available (GPON)' : 
                        (result.isError ? 'Error / Unknown' : 'Fiber Not Available');
            
            marker.bindPopup(`
                <div>
                    <h6>${status}</h6>
                    <p><strong>Coordinates:</strong><br>
                    Lat: ${result.lat.toFixed(5)}, Lng: ${result.lng.toFixed(5)}</p>
                </div>
            `);
            
            marker.addTo(markersLayer);
        });
        
        // Update UI
        updateStats();
        updateProgress(scanResults.length, scanResults.length);
        updateHeatmap();
        
        alert(`Loaded ${scanResults.length} results from ${new Date(parsed.scanDate).toLocaleString()}`);
    } catch (error) {
        console.error('Error loading results:', error);
        alert('Error loading previous results');
    }
}

/**
 * Clear all results
 */
function clearAll() {
    if (!confirm('Are you sure you want to clear all results?')) {
        return;
    }

    markersLayer.clearLayers();
    scanResults = [];
    stats = { total: 0, available: 0, notAvailable: 0, errors: 0 };
    
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
        heatmapLayer = null;
    }
    
    updateStats();
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('progressBar').textContent = '0%';
    document.getElementById('progressText').textContent = 'Ready to scan';
    
    localStorage.removeItem('sfaxFiberScanResults');
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
    
    // Other actions
    document.getElementById('retryNotAvailableBtn').addEventListener('click', retryNotAvailablePoints);
    document.getElementById('loadPreviousBtn').addEventListener('click', loadFromLocalStorage);
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
    
    // Rectangle draw toggle
    document.getElementById('drawRectangle').addEventListener('change', function(e) {
        if (e.target.checked) {
            map.addControl(drawControl);
        } else {
            map.removeControl(drawControl);
            drawnItems.clearLayers();
        }
    });
    
    // Check for previous results on load
    const previousData = localStorage.getItem('sfaxFiberScanResults');
    if (previousData) {
        const loadPrevious = confirm('Previous scan results found. Would you like to load them?');
        if (loadPrevious) {
            loadFromLocalStorage();
        }
    }
});
