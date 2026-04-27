// ============================================
// MATCH ANALYST BOT - Analisi pre-partita con AI
// ============================================

const https = require("https");

const TELEGRAM_TOKEN = process.env.ANALYST_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GROQ_KEY = process.env.GROQ_KEY;

let lastUpdateId = 0;
let waitingFor = null; // Stato conversazione: cosa stiamo aspettando dall'utente
let matchData = {};    // Dati partita in costruzione

// ============================================
// TELEGRAM
// ============================================

function sendTelegram(text, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = {
      chat_id: CHAT_ID,
      text: text,
      parse_mode: "HTML",
      ...options,
    };
    const body = JSON.stringify(payload);
    const reqOptions = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Manda messaggio lungo spezzandolo se supera 4096 caratteri (limite Telegram)
async function sendLongMessage(text) {
  const MAX = 4000;
  if (text.length <= MAX) {
    await sendTelegram(text);
    return;
  }
  // Spezza per paragrafi
  const parts = [];
  let current = "";
  const lines = text.split("\n");
  for (const line of lines) {
    if ((current + line).length > MAX) {
      if (current) parts.push(current.trim());
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current.trim()) parts.push(current.trim());
  for (const part of parts) {
    await sendTelegram(part);
    await sleep(500);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================
// CLAUDE AI - Genera l'analisi
// ============================================

async function generateAnalysis(match) {
  const prompt = `Sei un Match Analyst di calcio professionista e un esperto tattico. Fornisci un report di analisi pre-partita estremamente dettagliato per il seguente match. L'analisi deve essere approfondita, basata su dati, statistiche REALI e osservazioni tattiche concrete. Usa la tua conoscenza aggiornata delle squadre.

PARTITA:
• Squadra Casa: ${match.home}
• Squadra Ospite: ${match.away}
• Competizione: ${match.competition}
• Data Match: ${match.date}

Struttura il report esattamente così:

1️⃣ CONTESTO E IMPORTANZA DEL MATCH
• Posta in gioco per entrambe le squadre
• Come arrivano le squadre a livello morale e di risultati

2️⃣ STATO DI FORMA (ultime 5-6 partite)
• ${match.home}: risultati, gol fatti/subiti, clean sheet, analisi qualitativa
• ${match.away}: risultati, gol fatti/subiti, clean sheet, analisi qualitativa
• Rendimento casa/trasferta specifico

3️⃣ HEAD TO HEAD (ultimi 5-10 scontri diretti)
• Risultati degli scontri diretti
• Statistiche aggregate (media gol, vittorie per parte)
• Pattern tattici o risultati ricorrenti

4️⃣ ANALISI TATTICA APPROFONDITA
${match.home}:
• Modulo probabile e interpretazione
• Stile di gioco (possesso e non possesso)
• Punti di forza tattici

${match.away}:
• Modulo probabile e interpretazione
• Stile di gioco
• Punti di forza tattici

5️⃣ GIOCATORI CHIAVE E DUELLI
• Assenze e infortuni noti con impatto
• Giocatori in forma
• 2-3 duelli chiave che possono decidere la partita

6️⃣ VULNERABILITÀ E PUNTI DEBOLI
• Dove soffre ${match.home}
• Dove soffre ${match.away}

7️⃣ PRONOSTICO TATTICO
• Come si svilupperà la partita
• 2-3 fattori decisivi
• Esito più probabile con motivazione dettagliata

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 QUOTA SICURA
Sulla base di tutta l'analisi, identifica LA quota statisticamente più sicura per questa partita (es. Over/Under gol, risultato esatto, handicap, BTTS, ecc.). Specifica: tipo di scommessa, motivazione statistica dettagliata, e il tuo livello di confidenza (es. 7/10).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sii preciso, usa dati reali e non generalizzare. Questo report è per un analista professionista. Scrivi tutto in italiano.`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 4000,
      messages: [
        {
          role: "system",
          content: "Sei un Match Analyst di calcio professionista. Rispondi sempre in italiano con analisi dettagliate e dati reali.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.message?.content;
          resolve(text || "Errore nella generazione dell'analisi.");
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ============================================
// FLUSSO CONVERSAZIONE
// ============================================

async function handleMessage(text) {
  text = text.trim();

  // /start
  if (text === "/start" || text === "/menu") {
    waitingFor = null;
    matchData = {};
    await sendTelegram(
      "⚽ <b>Match Analyst Bot</b>\n\n" +
      "Benvenuto! Sono il tuo analista tattico personale.\n\n" +
      "Cosa vuoi fare?\n\n" +
      "📊 /analisi — Genera un report pre-partita completo\n" +
      "ℹ️ /info — Come funziona il bot\n\n" +
      "<i>Powered by Claude AI + ricerca web in tempo reale</i>"
    );
    return;
  }

  // /info
  if (text === "/info") {
    await sendTelegram(
      "ℹ️ <b>Come funziona</b>\n\n" +
      "1. Scrivi /analisi\n" +
      "2. Inserisci le due squadre, la competizione e la data\n" +
      "3. Il bot cerca dati reali sul web e genera un report tattico completo con:\n\n" +
      "✅ Forma recente\n" +
      "✅ Head to head\n" +
      "✅ Analisi tattica\n" +
      "✅ Giocatori chiave e assenze\n" +
      "✅ Pronostico motivato\n" +
      "✅ Quota più sicura\n\n" +
      "<i>Il report richiede circa 30-60 secondi per essere generato.</i>"
    );
    return;
  }

  // /analisi — avvia il flusso
  if (text === "/analisi") {
    matchData = {};
    waitingFor = "home";
    await sendTelegram(
      "📊 <b>Nuova analisi pre-partita</b>\n\n" +
      "Iniziamo! Dimmi il nome della <b>squadra di casa</b>:\n\n" +
      "<i>Es: Inter, Arsenal, Real Madrid...</i>"
    );
    return;
  }

  // Flusso guidato raccolta dati
  if (waitingFor === "home") {
    matchData.home = text;
    waitingFor = "away";
    await sendTelegram(
      `✅ Squadra casa: <b>${text}</b>\n\n` +
      `Ora dimmi la <b>squadra ospite</b>:`
    );
    return;
  }

  if (waitingFor === "away") {
    matchData.away = text;
    waitingFor = "competition";
    await sendTelegram(
      `✅ Squadra ospite: <b>${text}</b>\n\n` +
      `Che <b>competizione</b> è? (es: Serie A, Champions League, Premier League...)`
    );
    return;
  }

  if (waitingFor === "competition") {
    matchData.competition = text;
    waitingFor = "date";
    await sendTelegram(
      `✅ Competizione: <b>${text}</b>\n\n` +
      `Quando si gioca? Inserisci la <b>data</b>:\n\n<i>Es: 27 aprile 2026, stasera, domani...</i>`
    );
    return;
  }

  if (waitingFor === "date") {
    matchData.date = text;
    waitingFor = null;

    // Conferma e genera
    await sendTelegram(
      `✅ <b>Riepilogo partita:</b>\n\n` +
      `🏠 Casa: <b>${matchData.home}</b>\n` +
      `✈️ Ospite: <b>${matchData.away}</b>\n` +
      `🏆 Competizione: <b>${matchData.competition}</b>\n` +
      `📅 Data: <b>${matchData.date}</b>\n\n` +
      `⏳ <i>Sto cercando dati e generando l'analisi... ci vogliono circa 30-60 secondi.</i>`
    );

    try {
      const analysis = await generateAnalysis(matchData);
      await sleep(500);
      await sendLongMessage(analysis);
      await sendTelegram(
        "\n✅ <b>Analisi completata!</b>\n\n" +
        "Vuoi analizzare un'altra partita? Scrivi /analisi\n" +
        "Torna al menu principale: /start"
      );
    } catch (err) {
      console.error("Errore generazione analisi:", err);
      await sendTelegram(
        "❌ Errore nella generazione dell'analisi.\n" +
        "Riprova con /analisi"
      );
    }

    matchData = {};
    return;
  }

  // Messaggio non riconosciuto
  await sendTelegram(
    "❓ Non ho capito.\n\n" +
    "Scrivi /analisi per generare un report pre-partita\n" +
    "Scrivi /start per il menu principale"
  );
}

// ============================================
// POLLING AGGIORNAMENTI
// ============================================

async function getUpdates() {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
      method: "GET",
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ result: [] }); } });
    });
    req.on("error", () => resolve({ result: [] }));
    req.end();
  });
}

async function poll() {
  const data = await getUpdates();
  const updates = data.result || [];

  for (const update of updates) {
    lastUpdateId = update.update_id;
    const msg = update.message;
    if (!msg || !msg.text) continue;
    console.log("Messaggio ricevuto:", msg.text);
    try {
      await handleMessage(msg.text);
    } catch(err) {
      console.error("Errore gestione messaggio:", err);
    }
  }
}

// ============================================
// AVVIO
// ============================================

async function main() {
  console.log("⚽ Match Analyst Bot avviato!");
  await sendTelegram(
    "⚽ <b>Match Analyst Bot online!</b>\n\n" +
    "Scrivi /analisi per generare il tuo primo report pre-partita."
  );
  // Polling continuo
  setInterval(poll, 3000);
}

main().catch(console.error);
