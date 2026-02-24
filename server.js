const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const path = require("path");

const app = express();
const PORT = 3000;

// Proxy /api/rsm/* → https://geo.tunisietelecom.tn/rsm/*
app.use(
    "/api/rsm",
    createProxyMiddleware({
        target: "https://geo.tunisietelecom.tn",
        changeOrigin: true,
        pathRewrite: { "^/api/rsm": "/rsm" },
    })
);

// Serve static files from the project root
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
    console.log(`Dev server running at http://localhost:${PORT}`);
    console.log(`API requests to /api/rsm/* are proxied to https://geo.tunisietelecom.tn/rsm/*`);
});
