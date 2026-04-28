// ============================================
// MATCH ANALYST BOT v5
// Usa football-data.org — gratuito e stabile
// ============================================

const https = require("https");

const TELEGRAM_TOKEN = process.env.ANALYST_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GROQ_KEY = process.env.GROQ_KEY;
const FD_KEY = process.env.FD_KEY; // football-data.org key

let lastUpdateId = 0;
let waitingFor = null;

// Competizioni supportate dal piano free di football-data.org
// https://www.football-data.org/coverage
const COMPETITIONS = ["CL", "PL", "PD", "BL1", "SA", "FL1", "PPL", "DED"];
const COMP_NAMES = {
  "CL": "Champions League 🏆",
  "PL": "Premier League 🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "PD": "La Liga 🇪🇸",
  "BL1": "Bundesliga 🇩🇪",
  "SA": "Serie A 🇮🇹",
  "FL1": "Ligue 1 🇫🇷",
  "PPL": "Primeira Liga 🇵🇹",
  "DED": "Eredivisie 🇳🇱",
};

// ============================================
// TELEGRAM
// ============================================

function sendTelegram(text, extra = {}) {
  return new Promise((resolve) => {
    const payload = { chat_id: CHAT_ID, text, parse_mode: "HTML", ...extra };
    const body = JSON.stringify(payload);
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve());
    });
    req.on("error", () => resolve()); req.write(body); req.end();
  });
}

function sendWithButtons(text, buttons) {
  return sendTelegram(text, { reply_markup: { inline_keyboard: buttons } });
}

function answerCallback(id) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ callback_query_id: id });
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/answerCallbackQuery`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => { let d=""; res.on("data",c=>d+=c); res.on("end",resolve); });
    req.on("error", resolve); req.write(body); req.end();
  });
}

async function sendLong(text) {
  const MAX = 4000;
  if (text.length <= MAX) { await sendTelegram(text); return; }
  const parts = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + line + "\n").length > MAX) {
      if (cur) parts.push(cur.trim());
      cur = line + "\n";
    } else { cur += line + "\n"; }
  }
  if (cur.trim()) parts.push(cur.trim());
  for (const p of parts) { await sendTelegram(p); await sleep(700); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// FOOTBALL-DATA.ORG API
// ============================================

function fdRequest(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.football-data.org",
      path: `/v4${path}`,
      method: "GET",
      headers: { "X-Auth-Token": FD_KEY },
    };
    const req = https.request(opts, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on("error", reject); req.end();
  });
}

function todayDate() {
  return new Date().toISOString().split("T")[0];
}

// Partite di oggi in tutte le competizioni supportate
async function getMatchesToday() {
  const today = todayDate();
  try {
    // Una sola chiamata per tutte le partite di oggi!
    const data = await fdRequest(`/matches?dateFrom=${today}&dateTo=${today}`);
    const matches = data.matches || [];
    console.log(`Partite oggi: ${matches.length}`);

    // Filtra solo le competizioni nella nostra lista
    const filtered = matches.filter(m => COMPETITIONS.includes(m.competition.code));
    console.log(`Partite top leghe: ${filtered.length}`);

    // Raggruppa per competizione
    const grouped = {};
    for (const m of filtered) {
      const comp = COMP_NAMES[m.competition.code] || m.competition.name;
      if (!grouped[comp]) grouped[comp] = [];
      grouped[comp].push(m);
    }
    return grouped;
  } catch(e) {
    console.error("Errore getMatchesToday:", e.message);
    return {};
  }
}

// Dettagli singola partita
async function getMatchById(matchId) {
  const data = await fdRequest(`/matches/${matchId}`);
  return data;
}

// Classifica della competizione
async function getStandings(competitionCode) {
  try {
    const data = await fdRequest(`/competitions/${competitionCode}/standings`);
    return data.standings?.[0]?.table || [];
  } catch(e) { return []; }
}

// Ultimi 5 risultati di una squadra
async function getTeamForm(teamId) {
  try {
    const data = await fdRequest(`/teams/${teamId}/matches?status=FINISHED&limit=5`);
    return data.matches || [];
  } catch(e) { return []; }
}

// Head to head
async function getH2H(matchId) {
  try {
    const data = await fdRequest(`/matches/${matchId}/head2head?limit=8`);
    return data.matches || [];
  } catch(e) { return []; }
}

// ============================================
// FORMATTAZIONE DATI REALI
// ============================================

function formatStanding(table, teamId, teamName) {
  const s = table.find(r => r.team.id === teamId);
  if (!s) return `${teamName}: classifica non disponibile`;
  return `${s.position}° posto | ${s.points} punti | ${s.playedGames} partite | ${s.won}V-${s.draw}P-${s.lost}S | Gol: ${s.goalsFor}-${s.goalsAgainst} | DR: ${s.goalDifference > 0 ? "+" : ""}${s.goalDifference}`;
}

function formatForm(matches, teamId, teamName) {
  if (!matches || matches.length === 0) return `${teamName}: dati non disponibili`;
  const results = matches.map(m => {
    const isHome = m.homeTeam.id === teamId;
    const myGoals = isHome ? m.score.fullTime.home : m.score.fullTime.away;
    const oppGoals = isHome ? m.score.fullTime.away : m.score.fullTime.home;
    const opp = isHome ? m.awayTeam.name : m.homeTeam.name;
    const date = new Date(m.utcDate).toLocaleDateString("it-IT", { day:"2-digit", month:"2-digit" });
    const esito = myGoals > oppGoals ? "V" : myGoals === oppGoals ? "P" : "S";
    return `${esito} ${date} vs ${opp} ${myGoals ?? "?"}-${oppGoals ?? "?"}`;
  });
  const wins = results.filter(r => r.startsWith("V")).length;
  const draws = results.filter(r => r.startsWith("P")).length;
  const losses = results.filter(r => r.startsWith("S")).length;
  return `${teamName}: ${wins}V ${draws}P ${losses}S nelle ultime ${matches.length}\n  ${results.join(" | ")}`;
}

function formatH2H(matches, homeName, awayName) {
  if (!matches || matches.length === 0) return "Nessun precedente disponibile";
  let homeWins = 0, awayWins = 0, draws = 0, totalGoals = 0;
  const lines = matches.map(m => {
    const gh = m.score.fullTime.home ?? 0;
    const ga = m.score.fullTime.away ?? 0;
    totalGoals += gh + ga;
    const hn = m.homeTeam.name; const an = m.awayTeam.name;
    if (gh > ga) { if (hn === homeName) homeWins++; else awayWins++; }
    else if (ga > gh) { if (an === homeName) homeWins++; else awayWins++; }
    else draws++;
    const date = new Date(m.utcDate).toLocaleDateString("it-IT", { day:"2-digit", month:"2-digit", year:"2-digit" });
    return `${date}: ${hn} ${gh}-${ga} ${an}`;
  });
  const avg = (totalGoals / matches.length).toFixed(1);
  return `Ultimi ${matches.length} scontri: ${homeName} ${homeWins}V | Pareggi ${draws} | ${awayName} ${awayWins}V | Media gol: ${avg}\n  ${lines.join(" | ")}`;
}

// ============================================
// RACCOLTA DATI E GENERAZIONE REPORT
// ============================================

async function buildReport(matchId, competitionCode) {
  await sendTelegram("🔍 <i>Raccogliendo dati reali...</i>");

  // Dati partita
  const matchData = await getMatchById(matchId);
  const home = matchData.homeTeam.name;
  const away = matchData.awayTeam.name;
  const competition = matchData.competition.name;
  const date = new Date(matchData.utcDate).toLocaleDateString("it-IT", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Rome"
  });
  const time = new Date(matchData.utcDate).toLocaleTimeString("it-IT", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome"
  });
  const homeId = matchData.homeTeam.id;
  const awayId = matchData.awayTeam.id;

  // Raccogli tutto in parallelo
  const [standings, homeForm, awayForm, h2hMatches] = await Promise.all([
    getStandings(competitionCode),
    getTeamForm(homeId),
    getTeamForm(awayId),
    getH2H(matchId),
  ]);

  const standHome = formatStanding(standings, homeId, home);
  const standAway = formatStanding(standings, awayId, away);
  const formHome = formatForm(homeForm, homeId, home);
  const formAway = formatForm(awayForm, awayId, away);
  const h2hText = formatH2H(h2hMatches, home, away);

  await sendTelegram("🤖 <i>Generando analisi tattica...</i>");

  // Chiedi all'AI solo la parte tattica
  const tactical = await askGroqTactics(home, away, competition, standHome, standAway, formHome, formAway, h2hText);

  // Assembla report finale con dati reali in testa
  const report =
    `⚽ <b>${home} vs ${away}</b>\n` +
    `🏆 ${competition}\n` +
    `📅 ${date} — ore ${time}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📊 <b>CLASSIFICA</b>\n` +
    `🏠 ${standHome}\n` +
    `✈️ ${standAway}\n\n` +
    `📈 <b>FORMA RECENTE</b>\n` +
    `🏠 ${formHome}\n` +
    `✈️ ${formAway}\n\n` +
    `🔄 <b>HEAD TO HEAD</b>\n` +
    `${h2hText}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${tactical}`;

  return report;
}

// ============================================
// GROQ — SOLO TATTICA
// ============================================

async function askGroqTactics(home, away, competition, standHome, standAway, formHome, formAway, h2h) {
  const prompt =
    `Sei un analista tattico di calcio. Hai questi DATI REALI:\n\n` +
    `Partita: ${home} vs ${away} — ${competition}\n` +
    `Classifica ${home}: ${standHome}\n` +
    `Classifica ${away}: ${standAway}\n` +
    `Forma ${home}: ${formHome}\n` +
    `Forma ${away}: ${formAway}\n` +
    `H2H: ${h2h}\n\n` +
    `Scrivi SOLO queste 4 sezioni in italiano, testo pulito:\n\n` +
    `🎯 ANALISI TATTICA\n` +
    `[Modulo e stile di gioco di entrambe. 2-3 duelli chiave. Max 8 righe.]\n\n` +
    `👤 GIOCATORI CHIAVE E ASSENZE\n` +
    `[Chi è in forma, assenze note. Max 6 righe.]\n\n` +
    `🔮 PRONOSTICO\n` +
    `[Basati SUI DATI REALI sopra. Cita i numeri. Esito più probabile con motivazione. Max 6 righe.]\n\n` +
    `🔒 QUOTA SICURA\n` +
    `Tipo: [es. Over 2.5]\n` +
    `Motivazione: [2 righe con riferimento ai dati reali]\n` +
    `Confidenza: [X/10]`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1500,
      messages: [
        { role: "system", content: "Sei un analista tattico di calcio. Scrivi in italiano. Usa i dati reali forniti. Sii diretto e concreto." },
        { role: "user", content: prompt },
      ],
    });
    https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(d);
          resolve(parsed.choices?.[0]?.message?.content || "Analisi non disponibile.");
        } catch(e) { resolve("Analisi non disponibile."); }
      });
    }).on("error", () => resolve("Analisi non disponibile.")).end(body);
  });
}

// ============================================
// MOSTRA PARTITE DEL GIORNO
// ============================================

async function showTodayMatches() {
  await sendTelegram("⏳ <i>Carico le partite di oggi...</i>");
  const grouped = await getMatchesToday();

  if (Object.keys(grouped).length === 0) {
    await sendTelegram("😴 Nessuna partita nelle top leghe oggi.\n\nUsa /cerca per cercare una squadra specifica!");
    return;
  }

  await sendTelegram("📅 <b>Partite di oggi</b>\nClicca per l'analisi completa 👇");
  await sleep(300);

  for (const comp of Object.keys(grouped)) {
    const matches = grouped[comp];
    let text = `${comp}\n`;
    const buttons = [];

    for (const m of matches) {
      const home = m.homeTeam.name;
      const away = m.awayTeam.name;
      const status = m.status;
      const isLive = ["IN_PLAY", "PAUSED", "HALFTIME"].includes(status);
      const time = new Date(m.utcDate).toLocaleTimeString("it-IT", {
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome"
      });
      text += `${isLive ? "🔴 LIVE" : `🕐 ${time}`} — ${home} vs ${away}\n`;
      buttons.push([{ text: `📊 ${home} vs ${away}`, callback_data: `a_${m.id}_${m.competition.code}` }]);
    }

    text += "\n<i>Clicca per l'analisi 👆</i>";
    await sendWithButtons(text, buttons);
    await sleep(300);
  }
}

// ============================================
// CERCA PARTITA PER NOME
// ============================================

async function searchByTeam(query) {
  const grouped = await getMatchesToday();
  const allMatches = Object.values(grouped).flat();
  return allMatches.filter(m =>
    m.homeTeam.name.toLowerCase().includes(query.toLowerCase()) ||
    m.awayTeam.name.toLowerCase().includes(query.toLowerCase())
  );
}

// ============================================
// CALLBACK
// ============================================

async function handleCallback(cb) {
  if (!cb.data.startsWith("a_")) return;
  await answerCallback(cb.id);
  const parts = cb.data.replace("a_", "").split("_");
  const matchId = parts[0];
  const compCode = parts[1];

  try {
    const report = await buildReport(matchId, compCode);
    await sleep(500);
    await sendLong(report);
    await sendTelegram(
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "✅ <b>Report completato!</b>\n\n" +
      "📅 /analisi — altre partite\n" +
      "🔍 /cerca — cerca una squadra"
    );
  } catch(e) {
    console.error("Errore report:", e.message);
    await sendTelegram("❌ Errore. Riprova con /analisi");
  }
}

// ============================================
// COMANDI
// ============================================

async function getUpdates() {
  return new Promise((resolve) => {
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
      method: "GET",
    };
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ result: [] }); } });
    });
    req.on("error", () => resolve({ result: [] })); req.end();
  });
}

async function handleMessage(text) {
  text = text.trim();

  if (text === "/start" || text === "/menu") {
    waitingFor = null;
    await sendTelegram(
      "⚽ <b>Match Analyst Bot</b>\n\n" +
      "📅 /analisi — Partite di oggi\n" +
      "🔍 /cerca — Cerca una squadra\n" +
      "ℹ️ /info — Come funziona"
    );
    return;
  }

  if (text === "/info") {
    await sendTelegram(
      "ℹ️ <b>Come funziona</b>\n\n" +
      "Dati reali da football-data.org:\n" +
      "✅ Classifica con punti reali\n" +
      "✅ Ultimi 5 risultati veri\n" +
      "✅ Head to head reali\n" +
      "✅ Analisi tattica + pronostico AI\n" +
      "✅ Quota più sicura\n\n" +
      "Leghe supportate: Champions League, Premier League, Serie A, La Liga, Bundesliga, Ligue 1 e altre."
    );
    return;
  }

  if (text === "/analisi") {
    waitingFor = null;
    await showTodayMatches();
    return;
  }

  if (text === "/cerca" || text.startsWith("/cerca ")) {
    const query = text.replace("/cerca", "").trim();
    if (!query) {
      waitingFor = "search";
      await sendTelegram("🔍 Scrivi il nome della squadra che vuoi cercare:");
      return;
    }
    await doSearch(query);
    return;
  }

  if (waitingFor === "search") {
    waitingFor = null;
    await doSearch(text);
    return;
  }

  await sendTelegram("❓ Scrivi /analisi per le partite di oggi o /start per il menu.");
}

async function doSearch(query) {
  await sendTelegram(`🔍 <i>Cerco "${query}"...</i>`);
  const found = await searchByTeam(query);
  if (found.length === 0) {
    await sendTelegram(`😔 Nessuna partita trovata con "${query}" oggi.\n\nProva con /analisi per vedere tutte le partite!`);
    return;
  }
  let text = `🔍 <b>Trovate ${found.length} partite:</b>\n\n`;
  const buttons = [];
  found.slice(0, 6).forEach(m => {
    const home = m.homeTeam.name;
    const away = m.awayTeam.name;
    const time = new Date(m.utcDate).toLocaleTimeString("it-IT", { hour:"2-digit", minute:"2-digit", timeZone:"Europe/Rome" });
    text += `🕐 ${time} — ${home} vs ${away}\n`;
    buttons.push([{ text: `📊 ${home} vs ${away}`, callback_data: `a_${m.id}_${m.competition.code}` }]);
  });
  text += "\n<i>Clicca per l'analisi 👆</i>";
  await sendWithButtons(text, buttons);
}

async function poll() {
  const data = await getUpdates();
  for (const update of (data.result || [])) {
    lastUpdateId = update.update_id;
    try {
      if (update.callback_query) await handleCallback(update.callback_query);
      else if (update.message?.text) await handleMessage(update.message.text);
    } catch(e) { console.error("Errore poll:", e.message); }
  }
}

async function main() {
  console.log("⚽ Match Analyst Bot v5 avviato!");
  await sendTelegram("⚽ <b>Match Analyst Bot v5 online!</b>\n\nScrivi /analisi per le partite di oggi.");
  setInterval(poll, 3000);
}

main().catch(console.error);
