const https = require("https");
const http = require("http");
const WebSocket = require("ws");
const ws = WebSocket.Server;
const config = require(`${__dirname}/config.js`);
const { httpPort, httpsPort, wsPort, wssPort, wsHeartbeat } = config;
const fs = require("fs");
let proxy = JSON.parse(fs.readFileSync(`${__dirname}/proxy.json`, "utf-8"));
const cert = fs.readFileSync(config.cert, "utf-8");
const key = fs.readFileSync(config.key, "utf-8");
let httpsServer;
let httpServer;
let wsServer;
let wssServer;
let wsSocket;
let wssSocket;

if (httpsPort) {
    try {
        httpsServer = https.createServer({ key, cert });
        httpsServer.on("request", request);
        httpsServer.listen(httpsPort, () => console.log(`HTTPS server listening on port ${httpsPort}`));
    } catch (err) { console.log(`Failed to create HTTPS server for port ${httpsPort}! Error: ${err.message}`) }
}

if (httpPort) {
    try {
        httpServer = http.createServer();
        httpServer.on("request", request);
        httpServer.listen(httpPort, () => console.log(`HTTP server listening on port ${httpPort}`));
    } catch (err) { console.log(`Failed to create HTTP server for port ${httpPort}! Error: ${err.message}`) }
}

if (wssPort) {
    try {
        if (wssPort !== httpsPort) wssServer = https.createServer();
        wssSocket = new ws({ server: wssPort === httpsPort ? httpsServer : wssServer });
        wssSocket.on("connection", connection);
        if (wssServer) wssServer.listen(wssPort, () => console.log(`WSS server listening on port ${wssPort}`)); else wssSocket.on("listening", () => console.log(`WSS server listening on port ${wssPort} (same as HTTPS)`));
    } catch (err) { console.log(`Failed to create WSS server for port ${wssPort}! Error: ${err.message}`) }
}

if (wsPort) {
    try {
        if (wsPort !== httpPort) wsServer = http.createServer();
        wsSocket = new ws({ server: wsPort === httpPort ? httpServer : wsServer });
        wsSocket.on("connection", connection);
        if (wsServer) wsServer.listen(wsPort, () => console.log(`WS server listening on port ${wsPort}`)); else wsSocket.on("listening", () => console.log(`WS server listening on port ${wsPort} (same as HTTP)`));
    } catch (err) { console.log(`Failed to create WS server for port ${wsPort}! Error: ${err.message}`) }
}

fs.watchFile(`${__dirname}/proxy.json`, { encoding: "utf-8" }, () => {
    try {
        const newProxy = fs.readFileSync(`${__dirname}/proxy.json`, "utf-8");
        if (JSON.stringify(proxy) !== newProxy) {
            proxy = JSON.parse(newProxy);
            console.log("Updated proxy configuration");
        }
    } catch (err) { console.log(`Failed to update proxy configuration! Error: ${err.message}`) };
});

function request(req, res) {
    try {
        let data;
        req.on("data", d => data ? data = new Buffer.concat([data, Buffer.from(d)]) : data = Buffer.from(d));
        req.on("end", () => {
            const host = req.headers.host;
            const proxyHost = proxy[host];
            const ip = req.socket.remoteAddress.split("::ffff:")[1];
            if (!proxyHost) return console.log(`HTTP: IP ${ip} went to unknown host ${host}`);
            const proxyDomain = proxyHost[1] || host.substring(host.indexOf(".") + 1);
            let protocol = req.socket.encrypted ? "https" : "http";
            if (proxyHost[0]) if (typeof proxyHost[0] === "string") { if (proxyHost[0].startsWith("http")) protocol = proxyHost[0] } else proxyHost[0].forEach(i => { if (i.startsWith("http")) protocol = i });
            console.log(`HTTP: Sending IP ${ip} from ${host}${req.url} (${req.socket.encrypted ? "Secure" : "Unsecure"}) to ${proxyDomain}${req.url} (${protocol === "https" ? "Secure" : "Unsecure"})`);
            const proxyReq = (protocol === "https" ? https : http).request({
                host: proxyDomain,
                port: proxyHost[2] === 80 ? undefined : proxyHost[2],
                path: req.url,
                headers: req.headers,
                method: req.method,
            }, proxyRes => {
                let proxyData;
                proxyRes.on("data", d => proxyData ? proxyData = new Buffer.concat([proxyData, Buffer.from(d)]) : proxyData = Buffer.from(d));
                proxyRes.on("end", () => {
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(proxyData);
                });
                proxyRes.on("error", err => console.log(`HTTP: Error with proxy response ${proxyDomain}! Error: ${err.message}`));
            });
            proxyReq.end(data);
            proxyReq.on("error", err => console.log(`HTTP: Error with proxy request ${proxyDomain}! Error: ${err.message}`));
        });
    } catch (err) { console.log(`HTTP: Error with request ${req.headers.host}! Error: ${err.message}`) }
}

function connection(client, req) {
    try {
        const host = req.headers.host;
        const proxyHost = proxy[host];
        const ip = req.socket.remoteAddress.split("::ffff:")[1];
        if (!proxyHost) {
            client.close();
            return console.log(`WS: IP ${ip} went to unknown host ${host}`);
        }
        const proxyDomain = proxyHost[1] || host.substring(host.indexOf(".") + 1);
        let protocol = req.socket.encrypted ? "wss" : "ws";
        if (proxyHost[0]) if (typeof proxyHost[0] === "string") { if (proxyHost[0].startsWith("ws")) protocol = proxyHost[0] } else proxyHost[0].forEach(i => { if (i.startsWith("ws")) protocol = i });
        console.log(`WS: Sending IP ${ip} from ${host}${req.url} (${req.socket.encrypted ? "Secure" : "Unsecure"}) to ${proxyDomain} (${protocol === "wss" ? "Secure" : "Unsecure"})`);
        const proxyWs = new WebSocket(`${protocol}://${proxyDomain}${proxyHost[2] ? `:${proxyHost[2]}` : ""}${req.url}`, {
            host: proxyDomain,
            port: proxyHost[2] === 80 ? undefined : proxyHost[2],
            path: req.url,
            headers: req.headers,
            method: req.method
        });

        proxyWs.on("message", msg => client.send(msg));
        proxyWs.on("close", (code, reason) => client.close(code, reason));
        proxyWs.on("ping", data => client.ping(data));
        proxyWs.on("pong", data => client.pong(data));
        proxyWs.on("error", err => { console.log(`WS: Error with proxy WebSocket ${proxyDomain}! Error: ${err.message}`); client.close() });

        client.on("message", msg => proxyWs.send(msg));
        client.on("close", (code, reason) => proxyWs.close(code, reason));
        client.on("ping", data => proxyWs.ping(data));
        client.on("pong", data => proxyWs.pong(data));
        client.on("error", err => console.log(`WS: Error with client WebSocket ${host}! Error: ${err.message}`));
    } catch (err) { console.log(`WS: Error with WebSocket ${req.headers.host}! Error: ${err.message}`); client.close() }
}