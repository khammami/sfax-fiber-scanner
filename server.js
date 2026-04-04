const express = require("express");
const https = require("https");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;
const COVERAGE_FILE = path.join(__dirname, "cached_coverage.json");

// Security headers via helmet
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "https://cdn.jsdelivr.net",
                "https://unpkg.com",
            ],
            // Leaflet Draw uses inline event handler attributes internally
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.jsdelivr.net",
                "https://unpkg.com",
            ],
            imgSrc: [
                "'self'",
                "data:",
                "https://*.tile.openstreetmap.org",
                "https://server.arcgisonline.com",
                "https://*.tile.opentopomap.org",
                "https://unpkg.com",
            ],
            connectSrc: [
                "'self'",
                "https://gis.tunisietelecom.tn",
                "https://cdn.jsdelivr.net",
                "https://unpkg.com",
            ],
            fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
            // Disable upgrade-insecure-requests — the dev server runs on plain HTTP
            upgradeInsecureRequests: null,
        },
    },
    // OSM tile servers require a Referer header; helmet defaults to "no-referrer"
    // which strips it and causes 403 errors on map tiles.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));

// Manual proxy: /api/rsm/* → https://gis.tunisietelecom.tn/rsm/*
// Uses a fresh HTTPS request per call with no connection pooling, matching what
// a browser would do when talking to the upstream directly.
// IMPORTANT: this must be registered BEFORE express.json() so the raw request
// body stream is forwarded intact to the upstream server.
app.use("/api/rsm", (req, res) => {
    const upstreamPath = "/rsm" + req.url;
    const chunks = [];

    // Collect the raw request body (if any)
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
        const body = chunks.length ? Buffer.concat(chunks) : null;

        const options = {
            hostname: "gis.tunisietelecom.tn",
            path: upstreamPath,
            method: req.method,
            headers: {
                ...(req.headers["content-type"] && { "Content-Type": req.headers["content-type"] }),
                ...(req.headers["accept"] && { Accept: req.headers["accept"] }),
                ...(body && { "Content-Length": body.length }),
            },
            // No connection reuse — upstream sends Connection: close
            agent: false,
            rejectUnauthorized: false
        };

        const proxyReq = https.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on("timeout", () => {
            console.error(`Proxy timeout [${req.method} ${req.originalUrl}]`);
            proxyReq.destroy();
            if (!res.headersSent) {
                res.status(504).json({ error: "Upstream server timed out", code: "ETIMEDOUT" });
            }
        });

        proxyReq.on("error", (err) => {
            console.error(`Proxy error [${req.method} ${req.originalUrl}]: ${err.code || err.message}`);
            if (!res.headersSent) {
                res.status(502).json({ error: "Upstream request failed", code: err.code || "UNKNOWN" });
            }
        });

        if (body) proxyReq.write(body);
        proxyReq.end();
    });
});

// Parse JSON request bodies (only affects non-proxied routes below this line)
app.use(express.json({ limit: "100mb" }));

// Write the current IndexedDB state to cached_coverage.json.
// Called by the client when the file is missing on startup so the local cache stays in sync.
app.post("/api/save-coverage", (req, res) => {
    const body = req.body;

    // Validate expected payload shape to prevent arbitrary file writes
    if (
        !body ||
        typeof body !== "object" ||
        body.version !== 3 ||
        typeof body.bitmap !== "string" ||
        typeof body.totalPoints !== "number" ||
        !body.bounds ||
        typeof body.bounds.latMin !== "number" ||
        typeof body.bounds.latMax !== "number" ||
        typeof body.bounds.lngMin !== "number" ||
        typeof body.bounds.lngMax !== "number" ||
        typeof body.step !== "number" ||
        typeof body.latSteps !== "number" ||
        typeof body.lngSteps !== "number"
    ) {
        return res.status(400).json({ ok: false, error: "Invalid payload structure" });
    }

    try {
        fs.writeFileSync(COVERAGE_FILE, JSON.stringify(body, null, 2), "utf-8");
        console.log(`cached_coverage.json updated (${body.totalPoints ?? "?"} points)`);
        res.json({ ok: true });
    } catch (err) {
        console.error("Error writing cached_coverage.json:", err);
        res.status(500).json({ ok: false, error: "Internal server error" });
    }
});

// Block access to sensitive files (server code, configs, dotfiles, node_modules)
app.use((req, res, next) => {
    const reqPath = decodeURIComponent(req.path).toLowerCase();
    if (
        reqPath === "/server.js" ||
        reqPath === "/package.json" ||
        reqPath === "/package-lock.json" ||
        reqPath.startsWith("/node_modules") ||
        reqPath.startsWith("/test") ||
        reqPath.startsWith("/.")
    ) {
        return res.status(404).send("Not found");
    }
    next();
});

// Return empty 204 for missing favicon to suppress browser 404 noise
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Serve static files from the project root
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
    console.log(`Dev server running at http://localhost:${PORT}`);
    console.log(`API requests to /api/rsm/* are proxied to https://gis.tunisietelecom.tn/rsm/*`);
});
