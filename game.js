const $ = (id) => document.getElementById(id);
const COLORS = ["#e53935", "#1e88e5", "#43a047", "#fb8c00"];
const fmt = (n) => n.toLocaleString("pt-BR");
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${fmt(Math.round(km))} km`);

let ws, myId, roomPlayers = [], isHost = false;
let guessMap, guessMarker, guessLatLng, guessSent;
let resultMap, resultLayer;
let apiPano = null;
let timerId, deadline;

const tiles = () => L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "© OpenStreetMap",
});

const colorOf = (id) => COLORS[Math.max(0, roomPlayers.findIndex((p) => p.id === id)) % COLORS.length];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dot = (id) => `<i class="dot" style="background:${colorOf(id)}"></i>`;

function show(...ids) {
  ["start", "lobby", "result", "end"].forEach((id) => ($(id).hidden = !ids.includes(id)));
}

/* ---------- Street View ---------- */

function loadMapsApi(key) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) return resolve();
    window.__gmReady = resolve;
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__gmReady`;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function showApiPano(loc) {
  new google.maps.StreetViewService().getPanorama(
    { location: { lat: loc.lat, lng: loc.lng }, radius: 100000 },
    (data, status) => {
      if (status !== "OK") return showIframePano(loc);
      $("pano-api").hidden = false;
      $("pano").hidden = true;
      if (!apiPano) {
        apiPano = new google.maps.StreetViewPanorama($("pano-api"), {
          addressControl: false, showRoadLabels: false, fullscreenControl: false, enableCloseButton: false,
        });
      }
      apiPano.setPano(data.location.pano);
      apiPano.setPov({ heading: Math.random() * 360, pitch: 0 });
      apiPano.setVisible(true);
    });
}

function showIframePano(loc) {
  $("pano-api").hidden = true;
  $("pano").hidden = false;
  $("pano").src =
    `https://maps.google.com/maps?layer=c&cbll=${loc.lat},${loc.lng}&cbp=11,${Math.floor(Math.random() * 360)},0,0,0&source=embed&output=svembed`;
}

/* ---------- Rede ---------- */

function connect(first) {
  ws = new WebSocket(window.SERVER_URL || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify(first));
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if ($("start").hidden) {
      $("hud").hidden = true; $("guess-box").hidden = true;
      show("start");
      $("start-error").textContent = "Conexão perdida com o servidor.";
    }
  };
}
const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

async function enter(type) {
  const name = $("name").value.trim();
  if (!name) { $("start-error").textContent = "Digite seu nome."; return; }
  const key = $("api-key").value.trim() || localStorage.getItem("gmaps-key") || "";
  if (key && !window.google?.maps) {
    try { await loadMapsApi(key); localStorage.setItem("gmaps-key", key); } catch { /* usa o embed */ }
  }
  $("start-error").textContent = "";
  const msg = { type, name };
  if (type === "join") msg.code = $("code").value.trim().toUpperCase();
  if (ws) ws.onclose = null, ws.close();
  connect(msg);
}

function onMessage(m) {
  switch (m.type) {
    case "error": $("start-error").textContent = m.message; show("start"); break;
    case "you": myId = m.id; break;
    case "room": return onRoom(m);
    case "round": return onRound(m);
    case "guessed": {
      const p = roomPlayers.find((x) => x.id === m.id);
      if (p) p.guessed = true;
      renderHud();
      break;
    }
    case "result": return onResult(m);
    case "end": return onEnd(m);
  }
}

/* ---------- Lobby ---------- */

function onRoom(m) {
  roomPlayers = m.players;
  isHost = roomPlayers[0]?.id === myId;
  if (m.state === "lobby") {
    $("hud").hidden = true; $("guess-box").hidden = true;
    $("pano-api").hidden = true; $("pano").hidden = true;
    show("lobby");
    $("lobby-code").textContent = m.code;
    $("lobby-players").innerHTML = roomPlayers
      .map((p) => `<li>${dot(p.id)}${esc(p.name)}${p.host ? " 👑" : ""}${p.id === myId ? " (você)" : ""}</li>`).join("");
    $("btn-begin").hidden = !isHost;
    $("lobby-wait").hidden = isHost;
  } else {
    renderHud(); // alguém saiu no meio da partida
  }
}

/* ---------- Rodada ---------- */

function initGuessMap() {
  guessMap = L.map("guess-map", { worldCopyJump: true, zoomControl: false }).setView([20, 0], 1);
  tiles().addTo(guessMap);
  guessMap.on("click", (e) => {
    if (guessSent) return;
    guessLatLng = e.latlng.wrap();
    if (guessMarker) guessMarker.setLatLng(e.latlng);
    else guessMarker = L.marker(e.latlng).addTo(guessMap);
    $("btn-guess").disabled = false;
    $("btn-guess").textContent = "Confirmar palpite";
  });
  $("guess-box").addEventListener("transitionend", () => guessMap.invalidateSize());
}

function renderHud() {
  $("hud-players").innerHTML = roomPlayers
    .map((p) => `<li>${dot(p.id)}${esc(p.name)} <b>${fmt(p.score)}</b> ${p.guessed ? "✓" : "…"}</li>`).join("");
}

function tick() {
  const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  $("hud-time").textContent = s;
}

function onRound(m) {
  roomPlayers = m.players;
  show();
  $("hud").hidden = false;
  $("guess-box").hidden = false;
  $("hud-round").textContent = `${m.round}/${m.total}`;
  renderHud();
  deadline = Date.now() + m.seconds * 1000;
  clearInterval(timerId); tick(); timerId = setInterval(tick, 500);

  if (window.google?.maps) showApiPano(m); else showIframePano(m);

  if (!guessMap) initGuessMap();
  guessSent = false;
  guessLatLng = null;
  if (guessMarker) { guessMap.removeLayer(guessMarker); guessMarker = null; }
  guessMap.setView([20, 0], 1);
  $("btn-guess").disabled = true;
  $("btn-guess").textContent = "Selecione um ponto no mapa";
  setTimeout(() => guessMap.invalidateSize(), 50);
}

function submitGuess() {
  if (!guessLatLng || guessSent) return;
  guessSent = true;
  send({ type: "guess", lat: guessLatLng.lat, lng: guessLatLng.lng });
  $("btn-guess").disabled = true;
  $("btn-guess").textContent = "Aguardando os outros jogadores…";
}

/* ---------- Resultado ---------- */

function onResult(m) {
  clearInterval(timerId);
  roomPlayers = m.players;
  renderHud();
  isHost = roomPlayers[0]?.id === myId;
  show("result");
  $("result-place").textContent = m.name;
  const ranked = [...m.guesses].sort((a, b) => b.points - a.points);
  $("result-list").innerHTML = ranked.map((g) => {
    const total = roomPlayers.find((p) => p.id === g.id)?.score ?? 0;
    const txt = g.km == null ? "sem palpite" : `${fmtKm(g.km)}`;
    return `<li>${dot(g.id)}${esc(g.name)} — ${txt} · <b>+${fmt(g.points)}</b> <span class="muted">(total ${fmt(total)})</span></li>`;
  }).join("");
  $("btn-next").textContent = m.last ? "Ver resultado final" : "Próxima rodada";
  $("btn-next").hidden = !isHost;
  $("result-wait").hidden = isHost;
  showResultMap(m);
}

function showResultMap(m) {
  if (!resultMap) {
    resultMap = L.map("result-map", { worldCopyJump: true });
    tiles().addTo(resultMap);
  }
  if (resultLayer) resultMap.removeLayer(resultLayer);
  const actual = L.latLng(m.lat, m.lng);
  const layers = [L.marker(actual).bindTooltip("Local real", { permanent: true, direction: "top", offset: [0, -40] })];
  const pts = [actual];
  m.guesses.forEach((g) => {
    if (g.km == null) return;
    const p = L.latLng(g.lat, g.lng);
    pts.push(p);
    const c = colorOf(g.id);
    layers.push(
      L.polyline([p, actual], { color: c, dashArray: "6 8", weight: 3 }),
      L.circleMarker(p, { radius: 9, color: "#fff", weight: 2, fillColor: c, fillOpacity: 1 })
        .bindTooltip(g.name, { permanent: true, direction: "top" }));
  });
  resultLayer = L.layerGroup(layers).addTo(resultMap);
  resultMap.invalidateSize();
  resultMap.fitBounds(L.latLngBounds(pts).pad(0.4), { maxZoom: 12 });
}

/* ---------- Fim ---------- */

function onEnd(m) {
  roomPlayers = m.players;
  isHost = m.hostId === myId;
  $("hud").hidden = true; $("guess-box").hidden = true;
  $("pano").src = "about:blank"; $("pano-api").hidden = true;
  show("end");
  const best = m.ranking[0].score;
  const winners = m.ranking.filter((p) => p.score === best);
  $("end-title").textContent = m.ranking.length === 1 ? "Fim de jogo!"
    : winners.length > 1 ? "Empate!" : `🏆 ${winners[0].name} venceu!`;
  $("ranking").innerHTML = m.ranking
    .map((p) => `<li>${dot(p.id)}${esc(p.name)} — <b>${fmt(p.score)}</b></li>`).join("");
  $("btn-again").hidden = !isHost;
  $("end-wait").hidden = isHost;
}

/* ---------- Eventos ---------- */

$("btn-create").onclick = () => enter("create");
$("btn-join").onclick = () => enter("join");
$("code").addEventListener("input", (e) => (e.target.value = e.target.value.toUpperCase()));
$("btn-begin").onclick = () => send({ type: "start" });
$("btn-guess").onclick = submitGuess;
$("btn-next").onclick = () => send({ type: "next" });
$("btn-again").onclick = () => send({ type: "again" });
