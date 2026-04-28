// ============================================
// MATCH ANALYST BOT v4
// Dati reali API Football + AI solo per commenti tattici
// ============================================

const https = require("https");

const TELEGRAM_TOKEN = process.env.ANALYST_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GROQ_KEY = process.env.GROQ_KEY;
const API_KEY = process.env.API_KEY;

let lastUpdateId = 0;
let waitingFor = null;
let matchData = {};

const TOP_LEAGUES = [2, 3, 848, 135, 39, 140, 78, 61, 94, 88, 203];
// Stagione corrente: tra gen-giu la stagione è quella dellanno precedente (es. 2024 per 2024/25)
const month = new Date().getMonth() + 1;
const SEASON = month <= 6 ? new Date().getFullYear() - 1 : new Date().getFullYear();

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
// API FOOTBALL
// ============================================

function apiFootball(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "v3.football.api-sports.io",
      path,
      method: "GET",
      headers: { "x-apisports-key": API_KEY },
    };
    const req = https.request(opts, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject); req.end();
  });
}

function todayDate() {
  return new Date().toISOString().split("T")[0];
}

// Cerca partite per data in tutte le top leghe
async function fetchMatchesByDate(dateStr) {
  let allMatches = [];
  for (const leagueId of TOP_LEAGUES) {
    try {
      const data = await apiFootball(`/fixtures?league=${leagueId}&season=${SEASON}&date=${dateStr}`);
      const matches = data.response || [];
      console.log(`Lega ${leagueId} (${dateStr}): ${matches.length} partite`);
      allMatches = allMatches.concat(matches);
    } catch(e) { console.error(`Errore lega ${leagueId}:`, e.message); }
  }
  return allMatches;
}

// Partite di oggi nelle top leghe (con fallback giorni successivi)
async function getTopMatchesToday() {
  let allMatches = await fetchMatchesByDate(todayDate());

  if (allMatches.length === 0) {
    for (let i = 1; i <= 2; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      allMatches = await fetchMatchesByDate(d.toISOString().split("T")[0]);
      if (allMatches.length > 0) break;
    }
  }

  const grouped = {};
  for (const f of allMatches) {
    const league = f.league.name;
    if (!grouped[league]) grouped[league] = [];
    grouped[league].push(f);
  }
  return grouped;
}

// Cerca partita per nome squadra (per il flusso manuale con dati reali)
async function searchFixtureByTeam(query) {
  let allMatches = await fetchMatchesByDate(todayDate());
  for (let i = 1; i <= 3; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    allMatches = allMatches.concat(await fetchMatchesByDate(d.toISOString().split("T")[0]));
  }
  return allMatches.filter(f =>
    f.teams.home.name.toLowerCase().includes(query.toLowerCase()) ||
    f.teams.away.name.toLowerCase().includes(query.toLowerCase())
  );
}
// ============================================
// RACCOLTA DATI REALI
// ============================================

async function getRealData(fixtureId) {
  const result = {
    fixture: null,
    homeStandings: null,
    awayStandings: null,
    homeForm: [],
    awayForm: [],
    h2h: [],
    errors: [],
  };

  // 1. Dettagli fixture
  try {
    const data = await apiFootball(`/fixtures?id=${fixtureId}`);
    result.fixture = data.response?.[0] || null;
  } catch(e) { result.errors.push("fixture"); }

  if (!result.fixture) return result;

  const homeId = result.fixture.teams.home.id;
  const awayId = result.fixture.teams.away.id;
  const leagueId = result.fixture.league.id;
  const season = result.fixture.league.season;

  // 2. Classifica
  try {
    const data = await apiFootball(`/standings?league=${leagueId}&season=${season}`);
    const table = data.response?.[0]?.league?.standings?.[0] || [];
    result.homeStandings = table.find(s => s.team.id === homeId) || null;
    result.awayStandings = table.find(s => s.team.id === awayId) || null;
  } catch(e) { result.errors.push("standings"); }

  // 3. Ultimi 5 risultati
  try {
    const data = await apiFootball(`/fixtures?team=${homeId}&league=${leagueId}&season=${season}&last=5&status=FT`);
    result.homeForm = data.response || [];
  } catch(e) { result.errors.push("homeForm"); }

  try {
    const data = await apiFootball(`/fixtures?team=${awayId}&league=${leagueId}&season=${season}&last=5&status=FT`);
    result.awayForm = data.response || [];
  } catch(e) { result.errors.push("awayForm"); }

  // 4. H2H
  try {
    const data = await apiFootball(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=8`);
    result.h2h = data.response || [];
  } catch(e) { result.errors.push("h2h"); }

  return result;
}

// ============================================
// FORMATTAZIONE DATI REALI IN TESTO
// ============================================

function formatStanding(s, teamName) {
  if (!s) return `${teamName}: classifica non disponibile`;
  return `${s.rank}° posto | ${s.points} punti | ${s.all.played} partite | ${s.all.win}V-${s.all.draw}P-${s.all.lose}S | Gol: ${s.all.goals.for}-${s.all.goals.against} | DR: ${s.goalsDiff > 0 ? "+" : ""}${s.goalsDiff}`;
}

function formatFormLine(fixtures, teamId, teamName) {
  if (!fixtures || fixtures.length === 0) return `${teamName}: dati forma non disponibili`;
  const results = fixtures.map(f => {
    const isHome = f.teams.home.id === teamId;
    const myGoals = isHome ? f.goals.home : f.goals.away;
    const oppGoals = isHome ? f.goals.away : f.goals.home;
    const opp = isHome ? f.teams.away.name : f.teams.home.name;
    const date = new Date(f.fixture.date).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" });
    let esito = myGoals > oppGoals ? "V" : myGoals === oppGoals ? "P" : "S";
    return `${esito} ${date} vs ${opp} ${myGoals}-${oppGoals}`;
  });
  const wins = results.filter(r => r.startsWith("V")).length;
  const draws = results.filter(r => r.startsWith("P")).length;
  const losses = results.filter(r => r.startsWith("S")).length;
  return `${teamName}: ${wins}V ${draws}P ${losses}S nelle ultime ${fixtures.length}\n  ${results.join(" | ")}`;
}

function formatH2H(h2h, homeName, awayName) {
  if (!h2h || h2h.length === 0) return "Nessun precedente disponibile";
  let homeWins = 0, awayWins = 0, draws = 0, totalGoals = 0;
  const lines = h2h.map(f => {
    const gh = f.goals.home ?? 0;
    const ga = f.goals.away ?? 0;
    totalGoals += gh + ga;
    if (gh > ga) homeWins++; else if (ga > gh) awayWins++; else draws++;
    const date = new Date(f.fixture.date).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit" });
    return `${date}: ${f.teams.home.name} ${gh}-${ga} ${f.teams.away.name}`;
  });
  const mediaGol = (totalGoals / h2h.length).toFixed(1);
  return `Ultimi ${h2h.length} scontri: ${homeName} ${homeWins}V | Pareggi ${draws} | ${awayName} ${awayWins}V | Media gol: ${mediaGol}\n  ${lines.join(" | ")}`;
}

// ============================================
// COSTRUISCE IL REPORT (dati reali + AI per tattica)
// ============================================

async function buildReport(fixtureId) {
  // Step 1: raccogli dati reali
  const data = await getRealData(fixtureId);

  if (!data.fixture) {
    throw new Error("Impossibile recuperare i dati della partita");
  }

  const home = data.fixture.teams.home.name;
  const away = data.fixture.teams.away.name;
  const league = data.fixture.league.name;
  const date = new Date(data.fixture.fixture.date).toLocaleDateString("it-IT", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Rome"
  });
  const time = new Date(data.fixture.fixture.date).toLocaleTimeString("it-IT", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome"
  });

  // Step 2: formatta i dati reali
  const standingHome = formatStanding(data.homeStandings, home);
  const standingAway = formatStanding(data.awayStandings, away);
  const formHome = formatFormLine(data.homeForm, data.fixture.teams.home.id, home);
  const formAway = formatFormLine(data.awayForm, data.fixture.teams.away.id, away);
  const h2hText = formatH2H(data.h2h, home, away);

  // Step 3: costruisci la sezione dati reali direttamente (senza AI per questa parte)
  const headerBlock =
    `⚽ <b>${home} vs ${away}</b>\n` +
    `🏆 ${league}\n` +
    `📅 ${date} — ore ${time}\n`;

  const classificaBlock =
    `📊 <b>CLASSIFICA</b>\n` +
    `🏠 ${standingHome}\n` +
    `✈️ ${standingAway}`;

  const formaBlock =
    `📈 <b>FORMA RECENTE</b>\n` +
    `🏠 ${formHome}\n` +
    `✈️ ${formAway}`;

  const h2hBlock =
    `🔄 <b>HEAD TO HEAD</b>\n` +
    `${h2hText}`;

  // Step 4: chiedi all'AI SOLO la parte tattica (che non può sbagliare perché è opinione)
  const tacticalAnalysis = await askGroqTactics(home, away, league, standingHome, standingAway, formHome, formAway, h2hText);

  // Step 5: assembla il report finale
  const report =
    `${headerBlock}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${classificaBlock}\n\n` +
    `${formaBlock}\n\n` +
    `${h2hBlock}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${tacticalAnalysis}`;

  return report;
}

// ============================================
// GROQ — SOLO TATTICA E PRONOSTICO
// ============================================

async function askGroqTactics(home, away, league, standHome, standAway, formHome, formAway, h2h) {
  const prompt =
    `Sei un analista tattico di calcio. Ti fornisco i DATI REALI di una partita. ` +
    `Il tuo compito è scrivere SOLO le sezioni tattiche che seguono, senza ripetere i dati che ti ho già dato.\n\n` +
    `DATI REALI (non ripetere questi nel testo):\n` +
    `Partita: ${home} vs ${away} — ${league}\n` +
    `Classifica ${home}: ${standHome}\n` +
    `Classifica ${away}: ${standAway}\n` +
    `Forma ${home}: ${formHome}\n` +
    `Forma ${away}: ${formAway}\n` +
    `H2H: ${h2h}\n\n` +
    `Scrivi ESATTAMENTE queste 4 sezioni in italiano, testo pulito senza eccesso di emoji:\n\n` +
    `🎯 ANALISI TATTICA\n` +
    `[Modulo e stile di gioco di ${home}. Modulo e stile di gioco di ${away}. 2-3 duelli chiave che possono decidere la partita. Max 8 righe totali.]\n\n` +
    `👤 GIOCATORI CHIAVE E ASSENZE\n` +
    `[Giocatori più in forma e assenze note di entrambe le squadre. Max 6 righe.]\n\n` +
    `🔮 PRONOSTICO\n` +
    `[Basandoti SUI DATI REALI forniti sopra, spiega come prevedi si svilupperà la partita e qual è l'esito più probabile. Sii specifico e cita i numeri. Max 6 righe.]\n\n` +
    `🔒 QUOTA SICURA\n` +
    `Tipo scommessa: [es. Over 2.5 / BTTS / 1X2]\n` +
    `Motivazione: [2 righe con riferimento ai dati reali]\n` +
    `Confidenza: [X/10]\n\n` +
    `IMPORTANTE: scrivi in modo diretto e concreto. Niente frasi generiche. Cita sempre i dati reali nel pronostico.`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1500,
      messages: [
        { role: "system", content: "Sei un analista tattico di calcio professionista. Scrivi in italiano. Sii diretto e concreto. Usa i dati reali forniti." },
        { role: "user", content: prompt },
      ],
    });
    const opts = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = opts => new Promise((res, rej) => {
      const r = https.request(opts, (response) => {
        let d = ""; response.on("data", c => d += c);
        response.on("end", () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
      });
      r.on("error", rej); r.write(body); r.end();
      return r;
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
          resolve(parsed.choices?.[0]?.message?.content || "Analisi tattica non disponibile.");
        } catch(e) { resolve("Analisi tattica non disponibile."); }
      });
    }).on("error", () => resolve("Analisi tattica non disponibile."))
      .end(body);
  });
}

// ============================================
// MOSTRA PARTITE DEL GIORNO
// ============================================

async function showTodayMatches() {
  await sendTelegram("⏳ <i>Carico le partite di oggi...</i>");
  let grouped;
  try {
    grouped = await getTopMatchesToday();
  } catch(e) {
    await sendTelegram("❌ Errore nel caricare le partite. Riprova tra poco.");
    return;
  }

  if (Object.keys(grouped).length === 0) {
    await sendTelegram("😴 Nessuna partita nelle top leghe oggi.\n\nUsa /manuale per inserire una partita a mano.");
    return;
  }

  await sendTelegram("📅 <b>Partite di oggi</b>\nClicca su una partita per l'analisi completa 👇");
  await sleep(300);

  for (const league of Object.keys(grouped)) {
    const matches = grouped[league];
    let text = `🏆 <b>${league}</b>\n`;
    const buttons = [];

    for (const fx of matches) {
      const home = fx.teams.home.name;
      const away = fx.teams.away.name;
      const status = fx.fixture.status.short;
      const isLive = ["1H","2H","HT","ET","P"].includes(status);
      const time = new Date(fx.fixture.date).toLocaleTimeString("it-IT", {
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome"
      });
      text += `${isLive ? "🔴 LIVE" : `🕐 ${time}`} — ${home} vs ${away}\n`;
      buttons.push([{ text: `📊 ${home} vs ${away}`, callback_data: `a_${fx.fixture.id}` }]);
    }

    text += "\n<i>Clicca per l'analisi 👆</i>";
    await sendWithButtons(text, buttons);
    await sleep(400);
  }
}

// ============================================
// CALLBACK (bottoni cliccati)
// ============================================

async function handleCallback(cb) {
  if (!cb.data.startsWith("a_")) return;
  await answerCallback(cb.id);
  const fixtureId = cb.data.replace("a_", "");

  try {
    // Mostra subito i dettagli base
    const detailsData = await apiFootball(`/fixtures?id=${fixtureId}`);
    const fx = detailsData.response?.[0];
    if (!fx) { await sendTelegram("❌ Partita non trovata."); return; }

    const home = fx.teams.home.name;
    const away = fx.teams.away.name;
    const league = fx.league.name;

    await sendTelegram(
      `📊 <b>Analisi in preparazione</b>\n` +
      `⚽ <b>${home} vs ${away}</b>\n` +
      `🏆 ${league}\n\n` +
      `🔍 <i>Raccogliendo classifica, forma e H2H reali...</i>`
    );

    const report = await buildReport(fixtureId);
    await sleep(500);
    await sendLong(report);
    await sendTelegram(
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "✅ <b>Report completato!</b>\n\n" +
      "📅 /analisi — altre partite di oggi\n" +
      "✏️ /manuale — partita personalizzata"
    );
  } catch(e) {
    console.error("Errore report:", e.message);
    await sendTelegram("❌ Errore nella generazione. Riprova con /analisi");
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
    waitingFor = null; matchData = {};
    await sendTelegram(
      "⚽ <b>Match Analyst Bot</b>\n\n" +
      "📅 /analisi — Partite importanti di oggi\n" +
      "✏️ /manuale — Inserisci una partita a mano\n" +
      "ℹ️ /info — Come funziona"
    );
    return;
  }

  if (text === "/info") {
    await sendTelegram(
      "ℹ️ <b>Come funziona</b>\n\n" +
      "Il bot raccoglie dati REALI prima di generare l'analisi:\n\n" +
      "✅ Classifica aggiornata con punti reali\n" +
      "✅ Ultimi 5 risultati veri con date e punteggi\n" +
      "✅ Head to head con risultati reali\n" +
      "✅ Analisi tattica e pronostico basati su quei dati\n" +
      "✅ Quota più sicura\n\n" +
      "⏱ Tempo: 30-60 secondi"
    );
    return;
  }

  if (text === "/analisi") {
    waitingFor = null; matchData = {};
    await showTodayMatches();
    return;
  }

  if (text === "/manuale") {
    matchData = {}; waitingFor = "search";
    await sendTelegram("✏️ <b>Cerca partita</b>\n\nScrivi il nome di una squadra:\n<i>Es: PSG, Inter, Arsenal...</i>");
    return;
  }

  // Flusso ricerca manuale
  if (waitingFor === "search") {
    waitingFor = null;
    const query = text;
    await sendTelegram(`🔍 <i>Cerco partite con "${query}"...</i>`);
    try {
      const found = await searchFixtureByTeam(query);
      if (found.length === 0) {
        await sendTelegram(`😔 Nessuna partita trovata con "${query}" nei prossimi giorni.\n\nRiprova con un altro nome.`);
        waitingFor = "search";
        return;
      }
      // Mostra le partite trovate come bottoni
      let text2 = `🔍 <b>Trovate ${found.length} partite:</b>\n\n`;
      const buttons = [];
      found.slice(0, 6).forEach(fx => {
        const home = fx.teams.home.name;
        const away = fx.teams.away.name;
        const date = new Date(fx.fixture.date).toLocaleDateString("it-IT", { day:"2-digit", month:"2-digit" });
        text2 += `📅 ${date} — ${home} vs ${away}\n`;
        buttons.push([{ text: `📊 ${home} vs ${away}`, callback_data: `a_${fx.fixture.id}` }]);
      });
      text2 += "\n<i>Clicca per l'analisi 👆</i>";
      await sendWithButtons(text2, buttons);
    } catch(e) {
      await sendTelegram("❌ Errore nella ricerca. Riprova con /manuale");
    }
    return;
  }

  await sendTelegram("❓ Scrivi /analisi per le partite di oggi o /start per il menu.");
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
  console.log("⚽ Match Analyst Bot v4 avviato!");
  await sendTelegram("⚽ <b>Match Analyst Bot v4 online!</b>\n\nScrivi /analisi per le partite di oggi.");
  setInterval(poll, 3000);
}

main().catch(console.error);
