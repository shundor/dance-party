import crypto from "node:crypto";
import { DB, getMeta, setMeta } from "./db.js";

export type Role = "admin" | "guest";

export interface Session {
  token: string;
  name: string;
  role: Role;
}

export const NAME_MAX = 12;
// No I/O to avoid confusion with 1/0 on a TV across the room.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

export function normalizeCode(code: unknown): string {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

export function sanitizeName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
    .trimEnd();
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export class JoinError extends Error {}

export class Auth {
  constructor(
    private db: DB,
    private adminPin: string,
    fixedCode?: string,
  ) {
    const fixed = normalizeCode(fixedCode);
    if (fixed) {
      if (!/^[A-Z]{4}$/.test(fixed)) throw new Error("ROOM_CODE must be 4 letters");
      setMeta(db, "room_code", fixed);
    } else if (!getMeta(db, "room_code")) {
      setMeta(db, "room_code", generateRoomCode());
    }
  }

  get roomCode(): string {
    return getMeta(this.db, "room_code")!;
  }

  /** Admin sign-in from the direct /admin link: the PIN replaces the room code. */
  joinAdmin(name: unknown, pin: unknown): Session {
    if (typeof pin !== "string" || pin.trim() === "") throw new JoinError("Please enter the admin PIN.");
    return this.join(this.roomCode, name, pin);
  }

  join(code: unknown, name: unknown, pin?: unknown): Session {
    if (normalizeCode(code) !== this.roomCode) throw new JoinError("That room code doesn't exist.");
    const cleanName = sanitizeName(name);
    if (!cleanName) throw new JoinError("Please enter your name.");
    let role: Role = "guest";
    if (typeof pin === "string" && pin.trim() !== "") {
      if (!safeEqual(pin.trim(), this.adminPin)) throw new JoinError("Incorrect admin PIN.");
      role = "admin";
    }
    const token = crypto.randomBytes(24).toString("base64url");
    this.db
      .prepare("INSERT INTO sessions (token, name, role, room_code, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(token, cleanName, role, this.roomCode, Date.now());
    return { token, name: cleanName, role };
  }

  get(token: unknown): Session | undefined {
    if (typeof token !== "string" || !token) return undefined;
    const row = this.db
      .prepare("SELECT token, name, role FROM sessions WHERE token = ? AND room_code = ?")
      .get(token, this.roomCode) as Session | undefined;
    return row;
  }

  /** Generates a new room code; all existing sessions become invalid. */
  rotateCode(): string {
    let code = generateRoomCode();
    while (code === this.roomCode) code = generateRoomCode();
    setMeta(this.db, "room_code", code);
    this.db.prepare("DELETE FROM sessions").run();
    return code;
  }
}
