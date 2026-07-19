// Host accounts: scrypt-hashed passwords in users.json, in-memory sessions.
// ponytail: JSON file + in-memory sessions — right size for a handful of hosts
// on one machine. Move to a DB + persistent/expiring sessions only at real scale.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const FILE = new URL('./users.json', import.meta.url);
let users = {};
try { if (existsSync(FILE)) users = JSON.parse(readFileSync(FILE, 'utf8')); } catch {}
const save = () => writeFileSync(FILE, JSON.stringify(users, null, 2));

function hashPw(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [s, h] = stored.split(':');
  const dk = scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const hb = Buffer.from(h, 'hex');
  return dk.length === hb.length && timingSafeEqual(dk, hb);
}

export function register(username, password, ip = null) {
  username = String(username || '').trim();
  if (username.length < 3 || username.length > 20) throw new Error('아이디는 3~20자로');
  if (String(password || '').length < 4) throw new Error('비밀번호는 4자 이상으로');
  if (users[username]) throw new Error('이미 있는 아이디야');
  if (ip && Object.values(users).some((u) => u.ip === ip))
    throw new Error('이 네트워크에서는 이미 계정을 만들었어 (IP당 1개)');
  users[username] = { hash: hashPw(password), ip };
  save();
}

const sessions = new Map(); // token -> username
export function login(username, password) {
  username = String(username || '').trim();
  const u = users[username];
  if (!u || !checkPw(password, u.hash)) throw new Error('아이디 또는 비밀번호가 틀렸어');
  const token = randomBytes(24).toString('hex');
  sessions.set(token, username);
  return token;
}
export const userOf = (token) => sessions.get(token) || null;
export const logout = (token) => sessions.delete(token);

// ---- 로그인 무차별 대입 방지: IP당 WINDOW 안에 MAX회 실패하면 잠금 ----
const MAX_FAILS = 5, WINDOW_MS = 10 * 60 * 1000;
const fails = new Map(); // ip -> {count, first}
export function loginAllowed(ip) {
  const f = fails.get(ip);
  if (!f) return true;
  if (Date.now() - f.first > WINDOW_MS) { fails.delete(ip); return true; }
  return f.count < MAX_FAILS;
}
export function recordFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) fails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}
export const clearFails = (ip) => fails.delete(ip);
