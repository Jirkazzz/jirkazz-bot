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

// Tokeny pro odesilani zprav (volitelne pro cteni, povinne pro psani)
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

// --- Funkce pro odesilani zpravy do Kick chatu jako Jirkazz ---
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

// --- Pripojeni k Kick chatu pres Pusher ---
const pusher = new Pusher(PUSHER_KEY, { 
                              cluster: PUSHER_CLUSTER, 
                forceTLS: true
});

const channel = pusher.subscribe(`chatrooms.${CHATROOM_ID}.v2`);

channel.bind('pusher:subscription_succeeded', () => {
                console.log("OK Bot je pripojen k Kick chatu jirkazz!");
});

channel.bind('pusher:subscription_error', (err) => {
                console.error("[X] Chyba pripojeni k Pusher:", err);
});

// --- Zpracovani kazde zpravy v chatu ---
// KDYZ NEKDO NAPISE, POVAZUJEME STREAM ZA ONLINE
let isStreamOnlineCache = false;
let lastMessageTime = 0;

channel.bind('App\\Events\\ChatMessageEvent', async (data) => {
                try {
                                    const kickId = data.sender.id;
                                    const username = data.sender.username;
                                    const content = data.content.trim();

                    // Zaznamename aktivitu uzivatele
                    activeUsers.set(kickId, { username, lastSeen: Date.now() });

                    // Zprava v chatu = stream je pravdepodobne online
                    lastMessageTime = Date.now();
                                    if (!isStreamOnlineCache) {
                                                            isStreamOnlineCache = true;
                                                            console.log("[TV] Chat ozil! Prepinam bota do ONLINE rezimu (rozdavani bodu zapnuto).");
                                    }

                    console.log(`[CHAT] ${username}: ${content}`);

                    // --- Prikaz !points ---
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

                    // --- Admin prikazy pro zapnuti/vypnuti bodu ---
                    if (username.toLowerCase() === 'jirkazz' && content === '!zapnout') {
                                            isStreamOnlineCache = true;
                                            await sendKickMessage("Rozdavani bodu bylo ZAPNUTO! (Kazdych 5 minut dostanou aktivni divaci 5 bodu)");
                    }
                                    if (username.toLowerCase() === 'jirkazz' && content === '!vypnout') {
                                                            isStreamOnlineCache = false;
                                                            await sendKickMessage("Rozdavani bodu bylo VYPNUTO!");
                                    }
                } catch (err) {
                                    console.error("[X] Chyba pri zpracovani zpravy:", err.message);
                }
});

// --- Kazdych 5 minut: pricteme body aktivnim divakum ---
setInterval(async () => {
                try {
                                    // Zkontrolovat, jestli chat neumrel (vypnuty stream)
                    // Pokud 15 minut nikdo nenapsal, povazujeme stream za offline
                    if (isStreamOnlineCache && (Date.now() - lastMessageTime > 15 * 60 * 1000)) {
                                            isStreamOnlineCache = false;
                                            console.log("[TV] Chat je uz 15 minut mrtvy. Prepinam bota do OFFLINE rezimu.");
                    }

                    if (!isStreamOnlineCache) {
                                            console.log("[TV] " + new Date().toLocaleTimeString() + " - Stream je OFFLINE. Body se nerozdavaji.");
                                            // I kdyz je offline, mazeme stare neaktivni uzivatele
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
                console.log(`[HEART] Status: Bezi | Aktivni v mape: ${activeUsers.size}`);
}, 60 * 1000);

// --- Dummy HTTP Server pro Render.com (aby vedel, ze bot bezi) ---
const http = require('http');
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Kick bot bezi a nasloucha na portu ' + PORT);
}).listen(PORT, () => {
                console.log(`[WEB] Falesny webserver bezi na portu ${PORT} (pro Render health check)`);
});
