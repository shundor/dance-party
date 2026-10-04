import crypto from "node:crypto";
import { createDanceParty, lanUrl, mdnsHost } from "./app.js";

const env = process.env;
const port = Number(env.PORT) || 3000;

let adminPin = env.ADMIN_PIN?.trim();
if (!adminPin) {
  adminPin = String(crypto.randomInt(1000, 10000));
  console.warn(`ADMIN_PIN not set; using generated PIN ${adminPin} for this run.`);
}
let tvKey = env.TV_KEY?.trim();
if (!tvKey) {
  tvKey = crypto.randomBytes(8).toString("hex");
  console.warn("TV_KEY not set; using a generated key for this run.");
}

// Hostname other devices use for the TV page. TV_HOST overrides it (e.g. 192-168-1-121.nip.io).
const tvHost = env.TV_HOST?.trim().replace(/^https?:\/\//, "").replace(/[:/].*$/, "") || mdnsHost();

const party = createDanceParty({
  port,
  adminPin,
  tvKey,
  youtubeApiKey: env.YOUTUBE_API_KEY?.trim() || undefined,
  guestQueueLimit: Number(env.GUEST_QUEUE_LIMIT) || 3,
  dbPath: env.DB_PATH || "data/dance-party.db",
  roomCode: env.ROOM_CODE?.trim() || undefined,
  publicUrl: env.PUBLIC_URL?.trim().replace(/\/$/, "") || undefined,
  tvHost,
});

party.httpServer.listen(port, "0.0.0.0", () => {
  const base = env.PUBLIC_URL?.trim() || lanUrl(port);
  console.log(`\n🪩  Dance Party! is running`);
  console.log(`   Room code: ${party.auth.roomCode}`);
  console.log(`   Phones:    ${base}`);
  console.log(`   Admins:    ${base}/admin  (name + admin PIN, no room code)`);
  console.log(`   Queue:     ${base}/queue  (read-only, no sign-in)`);
  console.log(`   History:   ${base}/history  (every song played)`);
  const tvPath = `/tv?key=${encodeURIComponent(tvKey!)}`;
  console.log(`   TV player: http://localhost:${port}${tvPath}  (this computer)`);
  if (tvHost) console.log(`              http://${tvHost}:${port}${tvPath}  (any other device)`);
  else console.log(`              Other devices: set TV_HOST; YouTube blocks some videos on IP addresses like ${base}`);
  console.log(`   Search:    ${env.YOUTUBE_API_KEY ? "enabled" : "disabled (set YOUTUBE_API_KEY)"}\n`);
});

const shutdown = () => party.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
