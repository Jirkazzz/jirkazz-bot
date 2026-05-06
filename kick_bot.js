require('dotenv').config({ path: __dirname + '/../.env.local' });
require('dotenv').config({ path: __dirname + '/../.env' }); // Fallback
const { Pusher } = require('pusher-js');
const { neon } = require('@neondatabase/serverless');
const WebSocket = require('ws');

// Nutné pro běh Pusheru v Node.js
global.WebSocket = WebSocket;

// Kontrola kritických proměnných hned na startu
if (!process.env.DATABASE_URL) {
    console.error("❌ CHYBA: DATABASE_URL není nastavena v prostředí!");
    process.exit(1);
}

// Připojení k databázi
const sql = neon(process.env.DATABASE_URL);

// Kick nastavení
const PUSHER_KEY = '32cbd69e4b950bf97679';
const PUSHER_CLUSTER = 'us2';
const CHATROOM_ID = 21467043; // jirkazz

// Tokeny pro odesílání zpráv (volitelné pro čtení, povinné pro psaní)
const BEARER = process.env.KICK_BEARER_TOKEN;
const CSRF   = process.env.KICK_CSRF_TOKEN;
const COOKIES = process.env.KICK_COOKIES;

console.log("----------------------------------------");
console.log("🤖 Jirkazz Kick Bot se spouští...");
console.log("DATABASE_URL:", "✅ Nastavena");
console.log("KICK_TOKENS:", BEARER && CSRF && COOKIES ? "✅ OK (Bot může psát)" : "⚠️ CHYBÍ (Bot bude jen číst)");
console.log("----------------------------------------");

// Sledování aktivity: kickId -> { username, lastSeen }
const activeUsers = new Map();

// --- Funkce pro odesílání zprávy do Kick chatu jako Jirkazz ---
async function sendKickMessage(message) {
    if (!BEARER || !CSRF || !COOKIES) {
        console.log("⚠️ Zpráva nebyla odeslána (chybí tokeny):", message);
        return;
    }
    try {
        const res = await fetch(`https://kick.com/api/v2/messages/send/${CHATROOM_ID}`, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'authorization': `Bearer ${BEARER}`,
                'x-csrf-token': CSRF,
                'content-type': 'application/json',
                'cookie': COOKIES,
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify({ content: message, type: 'message' })
        });
        if (!res.ok) {
            console.error("❌ Nepodařilo se odeslat zprávu, status:", res.status);
        }
    } catch (err) {
        console.error("❌ Chyba při odesílání zprávy:", err.message);
    }
}

// --- Připojení k Kick chatu přes Pusher ---
// V Node.js verzi 8+ pusher-js funguje, ale ošetříme případné pády spojení
const pusher = new Pusher(PUSHER_KEY, { 
    cluster: PUSHER_CLUSTER, 
    forceTLS: true
});

const channel = pusher.subscribe(`chatrooms.${CHATROOM_ID}.v2`);

channel.bind('pusher:subscription_succeeded', () => {
    console.log("✅ Bot je připojen k Kick chatu jirkazz!");
});

channel.bind('pusher:subscription_error', (err) => {
    console.error("❌ Chyba připojení k Pusher:", err);
});

// --- Zpracování každé zprávy v chatu ---
channel.bind('App\\Events\\ChatMessageEvent', async (data) => {
    try {
        const kickId = data.sender.id;
        const username = data.sender.username;
        const content = data.content.trim();

        // Zaznamenáme aktivitu uživatele
        activeUsers.set(kickId, { username, lastSeen: Date.now() });

        console.log(`[CHAT] ${username}: ${content}`);

        // --- Příkaz !points ---
        if (content === '!points' || content === '!body') {
            const rows = await sql`SELECT points FROM users WHERE kick_id = ${kickId}`;
            const points = rows[0] ? rows[0].points : null;

            if (points === null) {
                await sendKickMessage(`@${username} Ještě nemáš účet na jirkazz.com! Přihlas se přes Kick na webu a body se ti začnou přičítat.`);
            } else {
                await sendKickMessage(`@${username} máš ${points} bodů. 💎`);
            }
        }

        // --- Příkaz !shop ---
        if (content === '!shop') {
            await sendKickMessage(`@${username} Shop se skiny najdeš na https://jirkazz.com/shop 🛒`);
        }
    } catch (err) {
        console.error("❌ Chyba při zpracování zprávy:", err.message);
    }
});

// --- Každých 5 minut: přičteme body aktivním divákům ---
setInterval(async () => {
    try {
        const now = Date.now();
        const eligible = [];

        for (const [kickId, data] of activeUsers.entries()) {
            if (now - data.lastSeen < 6 * 60 * 1000) {
                eligible.push({ kickId, username: data.username });
            } else {
                activeUsers.delete(kickId);
            }
        }

        if (eligible.length === 0) {
            console.log("⏳ " + new Date().toLocaleTimeString() + " - Žádní aktivní diváci.");
            return;
        }

        console.log(`⏳ Rozdávám 5 bodů ${eligible.length} divákům...`);
        let updated = 0;
        
        for (const { kickId, username } of eligible) {
            const rows = await sql`SELECT points FROM users WHERE kick_id = ${kickId}`;
            if (rows.length > 0) {
                const newPoints = rows[0].points + 5;
                await sql`UPDATE users SET points = ${newPoints} WHERE kick_id = ${kickId}`;
                updated++;
            }
        }
        console.log(`✅ Přičteno ${updated} uživatelům.`);
    } catch (err) {
        console.error("❌ Kritická chyba při rozdávání bodů:", err.message);
    }
}, 5 * 60 * 1000);

// Health check log
setInterval(() => {
    console.log(`💓 Status: Běží | Aktivní v mapě: ${activeUsers.size}`);
}, 60 * 1000);

// --- Dummy HTTP Server pro Render.com (aby věděl, že bot běží) ---
const http = require('http');
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Kick bot bezi a nasloucha na portu ' + PORT);
}).listen(PORT, () => {
    console.log(`🌐 Falešný webserver běží na portu ${PORT} (pro Render health check)`);
});
