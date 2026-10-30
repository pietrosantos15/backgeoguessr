const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const ROUNDS = 5;
const MAX_PLAYERS = 4;
const ROUND_SECONDS = 120;

const LOCATIONS = vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "locations.js"), "utf8") + ";LOCATIONS");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const PUBLIC = new Set(["/index.html", "/style.css", "/game.js", "/config.js"]);

const server = http.createServer((req, res) => {
  let p = req.url.split("?")[0];
  if (p === "/") p = "/index.html";
  if (!PUBLIC.has(p)) { res.writeHead(404).end("Not found"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] + "; charset=utf-8", "Cache-Control": "no-cache" });
  fs.createReadStream(path.join(__dirname, p)).pipe(res);
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
let nextId = 1;

function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const scoreFor = (km) => (km < 0.05 ? 5000 : Math.round(5000 * Math.exp(-km / 1492.7)));

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;
  do code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  while (rooms.has(code));
  return code;
}

function pickLocations(n) {
  const pool = [...LOCATIONS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).map(([name, lat, lng]) => ({ name, lat, lng }));
}

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (room, msg) => room.players.forEach((p) => send(p.ws, msg));

function playersView(room) {
  return room.players.map((p) => ({
    id: p.id, name: p.name, score: p.score, guessed: !!p.guess, host: p === room.players[0],
  }));
}

function sendRoom(room) {
  broadcast(room, { type: "room", code: room.code, state: room.state, players: playersView(room) });
}

function startRound(room) {
  room.state = "round";
  room.players.forEach((p) => (p.guess = null));
  const loc = room.locations[room.round];
  room.deadline = Date.now() + ROUND_SECONDS * 1000;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room), ROUND_SECONDS * 1000);
  broadcast(room, {
    type: "round", round: room.round + 1, total: ROUNDS, lat: loc.lat, lng: loc.lng,
    seconds: ROUND_SECONDS, players: playersView(room),
  });
}

function endRound(room) {
  if (room.state !== "round") return;
  clearTimeout(room.timer);
  room.state = "result";
  const loc = room.locations[room.round];
  const guesses = room.players.map((p) => {
    if (!p.guess) return { id: p.id, name: p.name, km: null, points: 0 };
    const km = haversineKm(p.guess, loc);
    const points = scoreFor(km);
    p.score += points;
    return { id: p.id, name: p.name, lat: p.guess.lat, lng: p.guess.lng, km, points };
  });
  const last = room.round + 1 === ROUNDS;
  broadcast(room, {
    type: "result", name: loc.name, lat: loc.lat, lng: loc.lng, guesses, last,
    players: playersView(room),
  });
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.players = room.players.filter((p) => p.ws !== ws);
  ws.room = null;
  if (!room.players.length) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  if (room.state === "round" && room.players.every((p) => p.guess)) return endRound(room);
  sendRoom(room);
}

function handle(ws, msg) {
  const room = ws.room;
  switch (msg.type) {
    case "create":
    case "join": {
      if (room) return;
      const name = String(msg.name || "").trim().slice(0, 16) || `Jogador ${ws.id}`;
      let r;
      if (msg.type === "create") {
        r = { code: makeCode(), players: [], state: "lobby", round: 0, locations: [], timer: null };
        rooms.set(r.code, r);
      } else {
        r = rooms.get(String(msg.code || "").toUpperCase().trim());
        if (!r) return send(ws, { type: "error", message: "Sala não encontrada." });
        if (r.state !== "lobby") return send(ws, { type: "error", message: "A partida já começou." });
        if (r.players.length >= MAX_PLAYERS) return send(ws, { type: "error", message: "Sala cheia (máx. 4)." });
      }
      r.players.push({ ws, id: ws.id, name, score: 0, guess: null });
      ws.room = r;
      sendRoom(r);
      break;
    }
    case "start":
      if (!room || room.state !== "lobby" || room.players[0].ws !== ws) return;
      room.locations = pickLocations(ROUNDS);
      room.round = 0;
      room.players.forEach((p) => (p.score = 0));
      startRound(room);
      break;
    case "guess": {
      if (!room || room.state !== "round") return;
      const p = room.players.find((x) => x.ws === ws);
      const lat = Number(msg.lat), lng = Number(msg.lng);
      if (!p || p.guess || !isFinite(lat) || !isFinite(lng)) return;
      p.guess = { lat, lng };
      broadcast(room, { type: "guessed", id: p.id });
      if (room.players.every((x) => x.guess)) endRound(room);
      break;
    }
    case "next":
      if (!room || room.state !== "result" || room.players[0].ws !== ws) return;
      room.round++;
      if (room.round < ROUNDS) return startRound(room);
      room.state = "end";
      broadcast(room, {
        type: "end", players: playersView(room), hostId: room.players[0].id,
        ranking: playersView(room).sort((a, b) => b.score - a.score),
      });
      break;
    case "again":
      if (!room || room.state !== "end" || room.players[0].ws !== ws) return;
      room.state = "lobby";
      sendRoom(room);
      break;
  }
}

// Ping periódico: proxies de hospedagem derrubam conexões ociosas (~60 s)
setInterval(() => wss.clients.forEach((c) => c.readyState === 1 && c.ping()), 30000);

wss.on("connection", (ws) => {
  ws.id = nextId++;
  send(ws, { type: "you", id: ws.id });
  ws.on("message", (data) => {
    try { handle(ws, JSON.parse(data)); } catch { /* ignora mensagens inválidas */ }
  });
  ws.on("close", () => leave(ws));
});

server.listen(PORT, () => console.log(`GeoGuessr em http://localhost:${PORT}`));
