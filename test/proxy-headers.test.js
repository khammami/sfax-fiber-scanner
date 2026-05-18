/**
 * Integration test: verify the /api/rsm proxy strips desktop fingerprint
 * headers and injects a mobile User-Agent before forwarding to the upstream.
 *
 * No external test framework required — uses only Node.js built-in modules.
 * Run with:  node test/proxy-headers.test.js
 */

"use strict";

const http = require("http");
const net = require("net");
const assert = require("assert");
const path = require("path");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

// ── Constants (must match server.js) ────────────────────────────────────────

const MOBILE_UA =
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const DESKTOP_UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find a free TCP port on loopback. */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}

/**
 * Start a minimal HTTP server that records the headers of the FIRST request it
 * receives and immediately responds with 200 OK.
 *
 * Returns { server, headersPromise }
 *   headersPromise resolves with the IncomingMessage headers object.
 */
function startMockTarget(port) {
    let resolveHeaders;
    const headersPromise = new Promise((res) => { resolveHeaders = res; });

    const server = http.createServer((req, res) => {
        resolveHeaders(req.headers);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });

    return new Promise((resolve, reject) => {
        server.listen(port, "127.0.0.1", () =>
            resolve({ server, headersPromise })
        );
        server.on("error", reject);
    });
}

/**
 * Build an Express app with the same proxy middleware configuration as
 * server.js, but pointing at a local mock target instead of the real upstream.
 */
function buildProxyApp(mockPort) {
    const app = express();
    app.use(
        "/api/rsm",
        createProxyMiddleware({
            target: `http://127.0.0.1:${mockPort}`,
            changeOrigin: true,
            pathRewrite: { "^/": "/rsm/" },
            on: {
                proxyReq(proxyReq) {
                    proxyReq.setHeader("referer", "https://gis.tunisietelecom.tn/");
                    proxyReq.setHeader("user-agent", MOBILE_UA);
                    proxyReq.removeHeader("sec-ch-ua");
                    proxyReq.removeHeader("sec-ch-ua-mobile");
                    proxyReq.removeHeader("sec-ch-ua-platform");
                    proxyReq.removeHeader("sec-fetch-site");
                    proxyReq.removeHeader("sec-fetch-mode");
                    proxyReq.removeHeader("sec-fetch-dest");
                },
            },
        })
    );
    return app;
}

/** Wrap http.get in a Promise. */
function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers }, (res) => {
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => resolve({ status: res.statusCode, body }));
        });
        req.on("error", reject);
    });
}

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            console.log(`  ✓  ${name}`);
            passed++;
        })
        .catch((err) => {
            console.error(`  ✗  ${name}`);
            console.error(`       ${err.message}`);
            failed++;
        });
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function main() {
    console.log("\nProxy mobile-header tests\n");

    const [mockPort, proxyPort] = await Promise.all([freePort(), freePort()]);

    const { server: mockServer, headersPromise } = await startMockTarget(mockPort);
    const proxyApp = buildProxyApp(mockPort);
    const proxyServer = await new Promise((resolve, reject) => {
        const s = proxyApp.listen(proxyPort, "127.0.0.1", () => resolve(s));
        s.on("error", reject);
    });

    // Send a request that simulates a desktop Chromium browser on localhost
    // (with all the fingerprinting headers the real browser would add, including
    // a localhost Referer that the upstream would normally reject with 403).
    const desktopHeaders = {
        "user-agent": DESKTOP_UA,
        "referer": "http://localhost:3000/",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Linux"',
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "accept": "application/json",
    };

    const proxyUrl = `http://127.0.0.1:${proxyPort}/api/rsm/RSMService.svc/getAppVersion`;
    const [response, forwardedHeaders] = await Promise.all([
        httpGet(proxyUrl, desktopHeaders),
        headersPromise,
    ]);

    // ── assertions ────────────────────────────────────────────────────────────

    await test("proxy responds with 200 (not 403)", () => {
        assert.strictEqual(response.status, 200,
            `Expected 200 but got ${response.status}`);
    });

    await test("user-agent forwarded to upstream is the mobile UA", () => {
        assert.strictEqual(
            forwardedHeaders["user-agent"],
            MOBILE_UA,
            `Got: ${forwardedHeaders["user-agent"]}`
        );
    });

    await test("original desktop user-agent is NOT forwarded", () => {
        assert.notStrictEqual(
            forwardedHeaders["user-agent"],
            DESKTOP_UA,
            "Desktop UA was forwarded — mobile override did not work"
        );
    });

    await test("sec-ch-ua is stripped", () => {
        assert.strictEqual(
            forwardedHeaders["sec-ch-ua"],
            undefined,
            `sec-ch-ua was forwarded: ${forwardedHeaders["sec-ch-ua"]}`
        );
    });

    await test("sec-ch-ua-mobile is stripped", () => {
        assert.strictEqual(
            forwardedHeaders["sec-ch-ua-mobile"],
            undefined,
            `sec-ch-ua-mobile was forwarded: ${forwardedHeaders["sec-ch-ua-mobile"]}`
        );
    });

    await test("sec-ch-ua-platform is stripped", () => {
        assert.strictEqual(
            forwardedHeaders["sec-ch-ua-platform"],
            undefined,
            `sec-ch-ua-platform was forwarded: ${forwardedHeaders["sec-ch-ua-platform"]}`
        );
    });

    await test("sec-fetch-site is stripped", () => {
        assert.strictEqual(
            forwardedHeaders["sec-fetch-site"],
            undefined,
            `sec-fetch-site was forwarded: ${forwardedHeaders["sec-fetch-site"]}`
        );
    });

    await test("sec-fetch-mode is stripped", () => {
        assert.strictEqual(
            forwardedHeaders["sec-fetch-mode"],
            undefined,
            `sec-fetch-mode was forwarded: ${forwardedHeaders["sec-fetch-mode"]}`
        );
    });

    await test("sec-fetch-dest is stripped", () => {
        assert.strictEqual(
            forwardedHeaders["sec-fetch-dest"],
            undefined,
            `sec-fetch-dest was forwarded: ${forwardedHeaders["sec-fetch-dest"]}`
        );
    });

    await test("referer is overridden with upstream TT domain (not localhost)", () => {
        assert.strictEqual(
            forwardedHeaders["referer"],
            "https://gis.tunisietelecom.tn/",
            `referer was: ${forwardedHeaders["referer"]}`
        );
    });

    await test("original localhost referer is NOT forwarded", () => {
        assert.notStrictEqual(
            forwardedHeaders["referer"],
            "http://localhost:3000/",
            "Localhost referer was forwarded — upstream would return 403"
        );
    });

    await test("non-fingerprinting headers (accept) are still forwarded", () => {
        assert.strictEqual(
            forwardedHeaders["accept"],
            "application/json",
            `accept header was dropped: ${forwardedHeaders["accept"]}`
        );
    });

    // ── teardown ──────────────────────────────────────────────────────────────

    await Promise.all([
        new Promise((r) => proxyServer.close(r)),
        new Promise((r) => mockServer.close(r)),
    ]);

    // ── summary ───────────────────────────────────────────────────────────────

    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error("\nUnexpected error:", err);
    process.exit(1);
});
