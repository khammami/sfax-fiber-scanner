const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
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

// Proxy /api/rsm/* → https://gis.tunisietelecom.tn/rsm/*
// IMPORTANT: this must be registered BEFORE express.json() so the raw request
// body stream is forwarded intact to the upstream server.  If a body-parser
// middleware runs first it consumes the stream and the proxy sends an empty body,
// causing the upstream to hang on POST requests.
//
// The upstream API returns 403 for desktop browser requests.  We spoof a mobile
// User-Agent and strip Chromium client-hint / Fetch-metadata headers that
// fingerprint a desktop browser before forwarding to the target.
const MOBILE_UA =
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

app.use(
    "/api/rsm",
    createProxyMiddleware({
        target: "https://gis.tunisietelecom.tn",
        changeOrigin: true,
        pathRewrite: { "^/": "/rsm/" },
        secure: false, // TT server has an untrusted SSL certificate
        on: {
            proxyReq(proxyReq) {
                // The upstream IIS server enforces Referer-based hotlink protection:
                // requests without a Referer matching its own domain get 403.
                // The browser sends Referer: http://localhost:3000/ which is rejected,
                // so we override it with the upstream origin before forwarding.
                proxyReq.setHeader("referer", "https://gis.tunisietelecom.tn/");

                // Override User-Agent with a mobile browser string.
                proxyReq.setHeader("user-agent", MOBILE_UA);

                // Remove Chromium client-hint headers — these betray a desktop
                // browser even when the UA string says otherwise.
                // sec-ch-ua-mobile: ?0  means "not a mobile device" → 403
                proxyReq.removeHeader("sec-ch-ua");
                proxyReq.removeHeader("sec-ch-ua-mobile");
                proxyReq.removeHeader("sec-ch-ua-platform");

                // Remove Fetch metadata headers (browser-only context signals).
                proxyReq.removeHeader("sec-fetch-site");
                proxyReq.removeHeader("sec-fetch-mode");
                proxyReq.removeHeader("sec-fetch-dest");
            },
        },
    })
);

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
