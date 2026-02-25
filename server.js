const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;
const COVERAGE_FILE = path.join(__dirname, "cached_coverage.json");

// Proxy /api/rsm/* → https://geo.tunisietelecom.tn/rsm/*
// IMPORTANT: this must be registered BEFORE express.json() so the raw request
// body stream is forwarded intact to the upstream server.  If a body-parser
// middleware runs first it consumes the stream and the proxy sends an empty body,
// causing the upstream to hang on POST requests.
app.use(
    "/api/rsm",
    createProxyMiddleware({
        target: "https://geo.tunisietelecom.tn/rsm",
        changeOrigin: true,
    })
);

// Parse JSON request bodies (only affects non-proxied routes below this line)
app.use(express.json({ limit: "50mb" }));

// Write the current IndexedDB state to cached_coverage.json.
// Called by the client when the file is missing on startup so the local cache stays in sync.
app.post("/api/save-coverage", (req, res) => {
    try {
        fs.writeFileSync(COVERAGE_FILE, JSON.stringify(req.body, null, 2), "utf-8");
        console.log(`cached_coverage.json updated (${req.body.totalPoints ?? "?"} points)`);
        res.json({ ok: true });
    } catch (err) {
        console.error("Error writing cached_coverage.json:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Serve static files from the project root
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
    console.log(`Dev server running at http://localhost:${PORT}`);
    console.log(`API requests to /api/rsm/* are proxied to https://geo.tunisietelecom.tn/rsm/*`);
});
