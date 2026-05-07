require('dotenv').config({ path: __dirname + '/../.env.local' });
require('dotenv').config({ path: __dirname + '/../.env' }); // Fallback
const { Pusher } = require('pusher-js');
const { neon } = require('@neondatabase/serverless');
const WebSocket = require('ws');

// Nutne pro beh Pusheru v Node.js
global.WebSocket = WebSocket;

// Kontrola kritickych promennych hned na startu
if (!process.env.DATABASE_URL) {
    console.error("[X] CHYBA: DATABASE_URL neni nastavena v prostredi!");
    process.exit(1);
}

// Pripojeni k databazi
const sql = neon(process.env.DATABASE_URL);

// Kick nastaveni
const PUSHER_KEY = '32cbd69e4b950bf97679';
const PUSHER_CLUSTER = 'us2';
const CHATROOM_ID = 21467043; // jirkazz
const CHANNEL_ID = 22736940;  // Kick ID uctu jirkazz

// Tokeny pro odesilani zprav
const BEARER = process.env.KICK_BEARER_TOKEN;
const CSRF   = process.env.KICK_CSRF_TOKEN;
const COOKIES = process.env.KICK_COOKIES;

console.log("----------------------------------------");
console.log("[BOT] Jirkazz Kick Bot se spousti...");
console.log("DATABASE_URL:", "OK Nastavena");
console.log("KICK_TOKENS:", BEARER && CSRF && COOKIES ? "OK (Bot muze psat)" : "[!] CHYBI (Bot bude jen cist)");
console.log("----------------------------------------");

// Sledovani aktivity: kickId -> { username, lastSeen }
const activeUsers = new Map();

// Stav streamu - body se rozdavaji POUZE kdyz je true
let isStreamOnlineCache = false;

// --- Funkce pro odesilani zpravy do Kick chatu ---
async function sendKickMessage(message) {
    if (!BEARER || !CSRF || !COOKIES) {
        console.log("[!] Zprava nebyla odeslana (chybi tokeny):", message);
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
            console.error("[X] Nepodarilo se odeslat zpravu, status:", res.status);
        }
    } catch (err) {
        console.error("[X] Chyba pri odesilani zpravy:", err.message);
    }
}

// --- Pripojeni k Pusher ---
const pusher = new Pusher(PUSHER_KEY, {
    cluster: PUSHER_CLUSTER,
    forceTLS: true
});

// Chat kanal - pro cteni zprav
const chatChannel = pusher.subscribe(`chatrooms.${CHATROOM_ID}.v2`);

// Kanal kanalu - pro detekci streamu ON/OFF
const streamChannel = pusher.subscribe(`channel.${CHANNEL_ID}`);

chatChannel.bind('pusher:subscription_succeeded', () => {
    console.log("OK Bot je pripojen k chatu jirkazz!");
});

chatChannel.bind('pusher:subscription_error', (err) => {
    console.error("[X] Chyba pripojeni k chat kanalu:", err);
});

streamChannel.bind('pusher:subscription_succeeded', () => {
    console.log("OK Bot nasloucha na stream kanalu jirkazz!");
});

streamChannel.bind('pusher:subscription_error', (err) => {
    console.error("[X] Chyba pripojeni ke stream kanalu:", err);
});

// --- Automaticka detekce zapnuti/vypnuti streamu ---
streamChannel.bind('App\\Events\\StreamerIsLive', (data) => {
    if (!isStreamOnlineCache) {
        isStreamOnlineCache = true;
        console.log("[TV] STREAM JE ONLINE - rozdavani bodu ZAPNUTO.");
    }
});

streamChannel.bind('App\\Events\\StreamerIsOffline', (data) => {
    if (isStreamOnlineCache) {
        isStreamOnlineCache = false;
        console.log("[TV] STREAM JE OFFLINE - rozdavani bodu ZASTAVENO.");
    }
});

// --- Zpracovani zprav v chatu ---
chatChannel.bind('App\\Events\\ChatMessageEvent', async (data) => {
    try {
        const kickId = data.sender.id;
        const username = data.sender.username;
        const content = data.content.trim();

        // Zaznamenat aktivitu uzivatele (jen pro ucel nasledneho pridavani bodu)
        activeUsers.set(kickId, { username, lastSeen: Date.now() });

        console.log(`[CHAT] ${username}: ${content}`);

        // --- Prikaz !points / !body ---
        if (content === '!points' || content === '!body') {
            const rows = await sql`SELECT points FROM users WHERE kick_id = ${kickId}`;
            const points = rows[0] ? rows[0].points : null;

            if (points === null) {
                await sendKickMessage(`@${username} Jeste nemas ucet na jirkazz.com! Prihlas se pres Kick na webu a body se ti zacnou pricitat.`);
            } else {
                await sendKickMessage(`@${username} mas ${points} bodu. [GEM]`);
            }
        }

        // --- Prikaz !shop ---
        if (content === '!shop') {
            await sendKickMessage(`@${username} Shop se skiny najdes na https://jirkazz.com/shop [SHOP]`);
        }

        // --- Admin prikazy (zalozni rucni ovladani) ---
        if (username.toLowerCase() === 'jirkazz' && content === '!zapnout') {
            isStreamOnlineCache = true;
            await sendKickMessage("Rozdavani bodu bylo ZAPNUTO rucne! (Kazdych 5 minut dostanou aktivni divaci 5 bodu)");
            console.log("[ADMIN] !zapnout - body zapnuty rucne.");
        }
        if (username.toLowerCase() === 'jirkazz' && content === '!vypnout') {
            isStreamOnlineCache = false;
            await sendKickMessage("Rozdavani bodu bylo VYPNUTO rucne!");
            console.log("[ADMIN] !vypnout - body vypnuty rucne.");
        }
    } catch (err) {
        console.error("[X] Chyba pri zpracovani zpravy:", err.message);
    }
});

// --- Kazdych 5 minut: pricist body aktivnim divakum ---
setInterval(async () => {
    try {
        if (!isStreamOnlineCache) {
            console.log("[TV] " + new Date().toLocaleTimeString() + " - Stream OFFLINE. Body se nerozdavaji.");
            // Cisteni stare mapy
            const now = Date.now();
            for (const [kickId, data] of activeUsers.entries()) {
                if (now - data.lastSeen > 6 * 60 * 1000) activeUsers.delete(kickId);
            }
            return;
        }

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
            console.log("[WAIT] " + new Date().toLocaleTimeString() + " - Zadni aktivni divaci.");
            return;
        }

        console.log(`[WAIT] Rozdavam 5 bodu ${eligible.length} divakum...`);
        let updated = 0;

        for (const { kickId, username } of eligible) {
            const rows = await sql`SELECT points FROM users WHERE kick_id = ${kickId}`;
            if (rows.length > 0) {
                const newPoints = rows[0].points + 5;
                await sql`UPDATE users SET points = ${newPoints} WHERE kick_id = ${kickId}`;
                updated++;
            }
        }
        console.log(`OK Pricteno ${updated} uzivatelum.`);
    } catch (err) {
        console.error("[X] Kriticka chyba pri rozdavani bodu:", err.message);
    }
}, 5 * 60 * 1000);

// Health check log
setInterval(() => {
    console.log(`[HEART] Bezi | Stream: ${isStreamOnlineCache ? 'ONLINE' : 'OFFLINE'} | Aktivni: ${activeUsers.size}`);
}, 60 * 1000);

// --- HTTP Server pro Render.com health check ---
const http = require('http');
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Kick bot bezi | Stream: ${isStreamOnlineCache ? 'ONLINE' : 'OFFLINE'}`);
}).listen(PORT, () => {
    console.log(`[WEB] Webserver bezi na portu ${PORT} (pro Render health check)`);
});
