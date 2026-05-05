require('dotenv').config();
const { Pusher } = require('pusher-js');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

const PUSHER_KEY = 'eb1d5f283081a78b932c';
const PUSHER_CLUSTER = 'us2';
const CHATROOM_ID = 21467043;

const BEARER = process.env.KICK_BEARER_TOKEN;
const CSRF   = process.env.KICK_CSRF_TOKEN;
const COOKIES = process.env.KICK_COOKIES;

console.log("Bot starting...");
console.log("DB:", process.env.DATABASE_URL ? "OK" : "MISSING");
console.log("Bearer:", BEARER ? "OK" : "MISSING");

const activeUsers = new Map();

async function sendKickMessage(message) {
      if (!BEARER || !CSRF || !COOKIES) return;
      try {
                await fetch(`https://kick.com/api/v2/messages/send/${CHATROOM_ID}`, {
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
      } catch (err) {
                console.error('Send error:', err.message);
      }
}

const pusher = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER, forceTLS: true });
const channel = pusher.subscribe(`chatrooms.${CHATROOM_ID}.v2`);

channel.bind('pusher:subscription_succeeded', () => {
      console.log("Connected to Kick chat!");
});

channel.bind('App\\Events\\ChatMessageEvent', async (data) => {
      const kickId = data.sender.id;
      const username = data.sender.username;
      const content = data.content.trim();

                 activeUsers.set(kickId, { username, lastSeen: Date.now() });
      console.log(`[CHAT] ${username}: ${content}`);

                 if (content === '!points' || content === '!body') {
                           try {
                                         const rows = await sql`SELECT points FROM users WHERE kick_id = ${kickId}`;
                                         const points = rows[0] ? rows[0].points : null;
                                         if (points === null) {
                                                           await sendKickMessage(`@${username} Jeste nemas ucet na jirkazz.com! Prihlasuj se pres Kick na https://jirkazz.com`);
                                         } else {
                                                           await sendKickMessage(`@${username} mas ${points} bodu. Nakupuj skiny na https://jirkazz.com/shop`);
                                         }
                           } catch (err) {
                                         console.error('DB error:', err.message);
                           }
                 }

                 if (content === '!shop') {
                           await sendKickMessage(`@${username} Shop je na https://jirkazz.com/shop`);
                 }

                 if (content === '!top') {
                           try {
                                         const rows = await sql`SELECT name, points FROM users ORDER BY points DESC LIMIT 3`;
                                         if (rows.length > 0) {
                                                           const medals = ['1.', '2.', '3.'];
                                                           const list = rows.map((r, i) => `${medals[i]} ${r.name}: ${r.points}`).join(' | ');
                                                           await sendKickMessage(`TOP 3 jirkazz.com -> ${list}`);
                                         }
                           } catch (err) {
                                         console.error('DB error:', err.message);
                           }
                 }
});

setInterval(async () => {
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
                          console.log("No active users, skipping points.");
                          return;
                }

                console.log(`Giving 5 points to ${eligible.length} users...`);
      for (const { kickId, username } of eligible) {
                try {
                              const rows = await sql`SELECT points FROM users WHERE kick_id = ${kickId}`;
                              if (rows[0] !== undefined) {
                                                await sql`UPDATE users SET points = points + 5 WHERE kick_id = ${kickId}`;
                                                console.log(`+5 points to ${username}`);
                              }
                } catch (err) {
                              console.error(`Error for ${username}:`, err.message);
                }
      }
}, 5 * 60 * 1000);

setInterval(() => {
      console.log(`Keepalive - active users: ${activeUsers.size}`);
}, 30 * 1000);
