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

export function register(username, password) {
  username = String(username || '').trim();
  if (username.length < 3 || username.length > 20) throw new Error('아이디는 3~20자로');
  if (String(password || '').length < 4) throw new Error('비밀번호는 4자 이상으로');
  if (users[username]) throw new Error('이미 있는 아이디야');
  users[username] = { hash: hashPw(password) };
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
