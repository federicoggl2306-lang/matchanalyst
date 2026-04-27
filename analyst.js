// ============================================
// MATCH ANALYST BOT v3 - Riscritto da zero
// Dati reali, testo pulito, classifica inclusa
// ============================================

const https = require("https");

const TELEGRAM_TOKEN = process.env.ANALYST_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GROQ_KEY = process.env.GROQ_KEY;
const API_KEY = process.env.API_KEY;

let lastUpdateId = 0;
let waitingFor = null;
let matchData = {};

// Leghe top — filtriamo solo queste per /analisi
const TOP_LEAGUES = [2, 3, 848, 135, 39, 140, 78, 61, 94, 88, 203];

const LEAGUE_EMOJI = {
  "UEFA Champions League": "🏆",
  "UEFA Europa League": "🟠",
  "UEFA Europa Conference League": "🟢",
  "Serie A": "🇮🇹",
  "Premier League": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "La Liga": "🇪🇸",
  "Bundesliga": "🇩🇪",
  "Ligue 1": "🇫🇷",
  "Primeira Liga": "🇵🇹",
  "Eredivisie": "🇳🇱",
};

// ============================================
// TELEGRAM
// ============================================

function sendTelegram(text, extra = {}) {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: CHAT_ID, text, parse_mode: "HTML", ...extra };
    const body = JSON.stringify(payload);
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
    });
    req.on("error", reject); req.write(body); req.end();
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

// Spezza messaggi lunghi (limite Telegram 4096 char)
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

// Partite di oggi nelle top leghe (sia live che programmate)
async function getTopMatchesToday() {
  const date = todayDate();
  const data = await apiFootball(`/fixtures?date=${date}&timezone=Europe/Rome`);
  const all = data.response || [];
  const top = all.filter(f => TOP_LEAGUES.includes(f.league.id));

  // Raggruppa per lega
  const grouped = {};
  for (const f of top) {
    const league = f.league.name;
    if (!grouped[league]) grouped[league] = [];
    grouped[league].push(f);
  }
  return grouped;
}

// Classifica della lega per trovare la posizione delle due squadre
async function getStandings(leagueId, season) {
  try {
    const data = await apiFootball(`/standings?league=${leagueId}&season=${season}`);
    const standings = data.response?.[0]?.league?.standings?.[0] || [];
    return standings;
  } catch(e) { return []; }
}

// Ultimi 5 risultati di una squadra
async function getLastFive(teamId, leagueId, season) {
  try {
    const data = await apiFootball(`/fixtures?team=${teamId}&league=${leagueId}&season=${season}&last=5`);
    return data.response || [];
  } catch(e) { return []; }
}

// Head to head ultimi 10 scontri
async function getH2H(homeId, awayId) {
  try {
    const data = await apiFootball(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`);
    return data.response || [];
  } catch(e) { return []; }
}

// Formatta risultato singola partita (per forma recente)
function formatResult(fixture, teamId) {
  const home = fixture.teams.home;
  const away = fixture.teams.away;
  const gh = fixture.goals.home ?? 0;
  const ga = fixture.goals.away ?? 0;
  const isHome = home.id === teamId;
  const teamGoals = isHome ? gh : ga;
  const oppGoals = isHome ? ga : gh;
  const opp = isHome ? away.name : home.name;
  let result = teamGoals > oppGoals ? "✅" : teamGoals === oppGoals ? "🟡" : "❌";
  const date = new Date(fixture.fixture.date).toLocaleDateString("it-IT", { day:"2-digit", month:"2-digit" });
  return `${result} ${date} vs ${opp}: ${teamGoals}-${oppGoals}`;
}

// ============================================
// GROQ AI — Genera analisi con dati reali iniettati
// ============================================

async function generateAnalysis(match, extraData) {
  const {
    homeStanding, awayStanding,
    homeForm, awayForm,
    h2hText,
  } = extraData;

  const prompt = `Sei un Match Analyst di calcio professionista. Scrivi un report pre-partita in italiano, chiaro, ben strutturato e leggibile. Usa i dati reali qui sotto e integra con la tua conoscenza tattica delle squadre.

═══════════════════════════
PARTITA: ${match.home} vs ${match.away}
COMPETIZIONE: ${match.competition}
DATA: ${match.date}
═══════════════════════════

DATI REALI FORNITI:
• ${match.home} in classifica: ${homeStanding}
• ${match.away} in classifica: ${awayStanding}
• Ultimi 5 risultati ${match.home}: ${homeForm}
• Ultimi 5 risultati ${match.away}: ${awayForm}
• Head to Head (ultimi scontri): ${h2hText}

═══════════════════════════
STRUTTURA REPORT (segui esattamente):

1️⃣ CONTESTO E POSTA IN GIOCO
Spiega cosa significa questa partita per entrambe le squadre (classifica, obiettivi stagionali, rivalità).

2️⃣ FORMA RECENTE
Per ogni squadra analizza i risultati reali forniti sopra: quanti punti nelle ultime 5, gol fatti/subiti, trend (in salita o in calo). Sii specifico con i numeri.

3️⃣ CLASSIFICA
Indica la posizione attuale di entrambe le squadre con punti, partite giocate, differenza reti. Spiega il gap tra le due.

4️⃣ HEAD TO HEAD
Analizza gli scontri diretti forniti: chi ha vinto di più, media gol, pattern ricorrenti (es. partite sempre equilibrate, una squadra dominante, tanti gol).

5️⃣ ANALISI TATTICA
${match.home}: modulo probabile, stile di gioco, punti di forza.
${match.away}: modulo probabile, stile di gioco, punti di forza.
Identifica 2-3 duelli chiave che possono decidere la partita.

6️⃣ ASSENZE E GIOCATORI CHIAVE
Elenca infortuni/squalifiche noti e i giocatori più in forma di entrambe le squadre in questo momento.

7️⃣ PRONOSTICO
Come si svilupperà la partita? Chi favorito e perché? Esito più probabile con motivazione chiara basata sui dati.

━━━━━━━━━━━━━━━━━━━━━━
🔒 QUOTA SICURA
Identifica la scommessa statisticamente più solida per questa partita (Over/Under, BTTS, 1X2, handicap...).
Formato: 
• Tipo: [es. Over 2.5]
• Motivazione: [2-3 righe con i dati che la supportano]  
• Confidenza: [X/10]
━━━━━━━━━━━━━━━━━━━━━━

IMPORTANTE: scrivi in modo chiaro e leggibile. Usa a capo tra le sezioni. Niente muri di testo. Sii diretto e concreto.`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 4000,
      messages: [
        { role: "system", content: "Sei un Match Analyst professionista. Rispondi in italiano. Scrivi in modo chiaro, strutturato e leggibile. Usa i dati reali forniti." },
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
    const req = https.request(opts, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.choices?.[0]?.message?.content || "Errore nella generazione.");
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

// ============================================
// PREPARA DATI REALI E GENERA ANALISI
// ============================================

async function prepareAndAnalyze(fixtureId, home, away, competition, date) {
  // Step 1 — Dettagli fixture
  const fixtureData = await apiFootball(`/fixtures?id=${fixtureId}`);
  const f = fixtureData.response?.[0];
  const homeId = f?.teams?.home?.id;
  const awayId = f?.teams?.away?.id;
  const leagueId = f?.league?.id;
  const season = f?.league?.season;

  await sendTelegram(`🔍 <i>Raccogliendo dati reali per ${home} vs ${away}...</i>`);

  // Step 2 — Classifica
  const standings = await getStandings(leagueId, season);
  const homeS = standings.find(s => s.team.id === homeId);
  const awayS = standings.find(s => s.team.id === awayId);

  const homeStanding = homeS
    ? `${homeS.rank}° posto — ${homeS.points} punti in ${homeS.all.played} partite (${homeS.all.win}V ${homeS.all.draw}P ${homeS.all.lose}S) DR: ${homeS.goalsDiff}`
    : "classifica non disponibile";

  const awayStanding = awayS
    ? `${awayS.rank}° posto — ${awayS.points} punti in ${awayS.all.played} partite (${awayS.all.win}V ${awayS.all.draw}P ${awayS.all.lose}S) DR: ${awayS.goalsDiff}`
    : "classifica non disponibile";

  // Step 3 — Ultimi 5 risultati
  const [homeResults, awayResults] = await Promise.all([
    getLastFive(homeId, leagueId, season),
    getLastFive(awayId, leagueId, season),
  ]);

  const homeForm = homeResults.length > 0
    ? homeResults.map(fx => formatResult(fx, homeId)).join(" | ")
    : "dati non disponibili";

  const awayForm = awayResults.length > 0
    ? awayResults.map(fx => formatResult(fx, awayId)).join(" | ")
    : "dati non disponibili";

  // Step 4 — Head to head
  const h2h = await getH2H(homeId, awayId);
  let h2hText = "";
  if (h2h.length === 0) {
    h2hText = "Nessuno scontro diretto recente disponibile";
  } else {
    h2hText = h2h.slice(0, 8).map(fx => {
      const gh = fx.goals.home ?? 0;
      const ga = fx.goals.away ?? 0;
      const hName = fx.teams.home.name;
      const aName = fx.teams.away.name;
      const d = new Date(fx.fixture.date).toLocaleDateString("it-IT", { day:"2-digit", month:"2-digit", year:"2-digit" });
      return `${d}: ${hName} ${gh}-${ga} ${aName}`;
    }).join(" | ");
  }

  await sendTelegram(`🤖 <i>Dati raccolti. Generando l'analisi...</i>`);

  // Step 5 — Genera analisi con AI
  const match = { home, away, competition, date };
  const extraData = { homeStanding, awayStanding, homeForm, awayForm, h2hText };
  const analysis = await generateAnalysis(match, extraData);

  return analysis;
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
    await sendTelegram(
      "😴 Nessuna partita nelle top leghe oggi.\n\n" +
      "Puoi comunque inserire una partita manualmente con /manuale"
    );
    return;
  }

  await sendTelegram("📅 <b>Partite importanti di oggi</b>\nClicca per l'analisi completa 👇");

  for (const league of Object.keys(grouped)) {
    const matches = grouped[league];
    const emoji = LEAGUE_EMOJI[league] || "⚽";
    let text = `${emoji} <b>${league}</b>\n`;

    const buttons = [];
    for (const fx of matches) {
      const home = fx.teams.home.name;
      const away = fx.teams.away.name;
      const time = new Date(fx.fixture.date).toLocaleTimeString("it-IT", {
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome"
      });
      const status = fx.fixture.status.short;
      const isLive = ["1H","2H","HT","ET","P"].includes(status);
      text += `${isLive ? "🔴 LIVE" : `🕐 ${time}`} — ${home} vs ${away}\n`;
      buttons.push([{ text: `📊 ${home} vs ${away}`, callback_data: `a_${fx.fixture.id}` }]);
    }

    await sendWithButtons(text, buttons);
    await sleep(300);
  }
}

// ============================================
// GESTIONE CALLBACK (bottoni)
// ============================================

async function handleCallback(cb) {
  if (!cb.data.startsWith("a_")) return;
  await answerCallback(cb.id);

  const fixtureId = cb.data.replace("a_", "");

  try {
    const res = await apiFootball(`/fixtures?id=${fixtureId}`);
    const f = res.response?.[0];
    if (!f) { await sendTelegram("❌ Partita non trovata."); return; }

    const home = f.teams.home.name;
    const away = f.teams.away.name;
    const league = f.league.name;
    const date = new Date(f.fixture.date).toLocaleDateString("it-IT", {
      weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Rome"
    });

    await sendTelegram(
      `📊 <b>Analisi in preparazione</b>\n\n` +
      `⚽ <b>${home} vs ${away}</b>\n` +
      `🏆 ${league}\n` +
      `📅 ${date}\n\n` +
      `⏳ <i>Raccogliendo dati reali... 30-60 secondi.</i>`
    );

    const analysis = await prepareAndAnalyze(fixtureId, home, away, league, date);
    await sleep(500);
    await sendLong(analysis);
    await sendTelegram(
      "━━━━━━━━━━━━━━━━━━━━━━\n" +
      "✅ <b>Report completato!</b>\n\n" +
      "📅 Altre partite: /analisi\n" +
      "✏️ Partita manuale: /manuale\n" +
      "🏠 Menu: /start"
    );

  } catch(e) {
    console.error("Errore analisi:", e.message);
    await sendTelegram("❌ Errore nella generazione. Riprova con /analisi");
  }
}

// ============================================
// GESTIONE MESSAGGI
// ============================================

async function handleMessage(text) {
  text = text.trim();

  if (text === "/start" || text === "/menu") {
    waitingFor = null; matchData = {};
    await sendTelegram(
      "⚽ <b>Match Analyst Bot</b>\n\n" +
      "Il tuo analista tattico personale.\n\n" +
      "📅 /analisi — Partite importanti di oggi\n" +
      "✏️ /manuale — Inserisci una partita a mano\n" +
      "ℹ️ /info — Come funziona\n\n" +
      "<i>Dati reali + AI</i>"
    );
    return;
  }

  if (text === "/info") {
    await sendTelegram(
      "ℹ️ <b>Come funziona</b>\n\n" +
      "1️⃣ Scrivi /analisi\n" +
      "2️⃣ Clicca la partita che ti interessa\n" +
      "3️⃣ Il bot raccoglie dati reali (classifica, forma, H2H) e genera il report\n\n" +
      "Il report include:\n" +
      "• Classifica attuale con punti\n" +
      "• Ultimi 5 risultati reali\n" +
      "• Head to head con risultati veri\n" +
      "• Analisi tattica\n" +
      "• Giocatori chiave e assenze\n" +
      "• Pronostico motivato\n" +
      "• Quota più sicura\n\n" +
      "⏱ Tempo medio: 30-60 secondi"
    );
    return;
  }

  if (text === "/analisi") {
    waitingFor = null; matchData = {};
    await showTodayMatches();
    return;
  }

  if (text === "/manuale") {
    matchData = {}; waitingFor = "home";
    await sendTelegram("✏️ <b>Partita manuale</b>\n\nNome della <b>squadra di casa</b>:");
    return;
  }

  // Flusso manuale
  if (waitingFor === "home") {
    matchData.home = text; waitingFor = "away";
    await sendTelegram(`✅ Casa: <b>${text}</b>\n\nSquadra <b>ospite</b>:`);
    return;
  }
  if (waitingFor === "away") {
    matchData.away = text; waitingFor = "competition";
    await sendTelegram(`✅ Ospite: <b>${text}</b>\n\n<b>Competizione</b>?`);
    return;
  }
  if (waitingFor === "competition") {
    matchData.competition = text; waitingFor = "date";
    await sendTelegram(`✅ Competizione: <b>${text}</b>\n\n<b>Data</b> della partita:`);
    return;
  }
  if (waitingFor === "date") {
    matchData.date = text; waitingFor = null;
    await sendTelegram(
      `📊 <b>${matchData.home} vs ${matchData.away}</b>\n` +
      `🏆 ${matchData.competition} — ${matchData.date}\n\n` +
      `⏳ <i>Generando analisi con AI... 30-60 secondi.</i>`
    );
    try {
      // Per manuale non abbiamo fixtureId, usiamo solo AI senza dati API
      const analysis = await generateAnalysis(matchData, {
        homeStanding: "cerca tu dalla classifica",
        awayStanding: "cerca tu dalla classifica",
        homeForm: "analizza dalla tua conoscenza",
        awayForm: "analizza dalla tua conoscenza",
        h2hText: "analizza dalla tua conoscenza",
      });
      await sleep(500);
      await sendLong(analysis);
      await sendTelegram("✅ <b>Report completato!</b>\n\n/analisi — partite oggi\n/start — menu");
    } catch(e) {
      await sendTelegram("❌ Errore. Riprova con /manuale");
    }
    matchData = {};
    return;
  }

  await sendTelegram("❓ Scrivi /analisi per le partite di oggi o /start per il menu.");
}

// ============================================
// POLLING
// ============================================

async function getUpdates() {
  return new Promise((resolve) => {
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
      method: "GET",
    };
    const req = https.request(opts, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ result: [] }); } });
    });
    req.on("error", () => resolve({ result: [] })); req.end();
  });
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

// ============================================
// AVVIO
// ============================================

async function main() {
  console.log("⚽ Match Analyst Bot v3 avviato!");
  await sendTelegram("⚽ <b>Match Analyst Bot v3 online!</b>\n\nScrivi /analisi per le partite di oggi.");
  setInterval(poll, 3000);
}

main().catch(console.error);
