// Self-check: play scripted hands, assert chip conservation and legal flow.
import { Table } from './poker.js';
import assert from 'assert';

// deterministic RNG
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function total(t) { return t.players.reduce((a, p) => a + p.chips, 0) + (t.hand?.pot || 0); }

// --- 3-player hand, everyone checks/calls to showdown ---
{
  const t = new Table({ smallBlind: 10, bigBlind: 20, startingChips: 1000 });
  t.addPlayer('a', 'Alice');
  t.addPlayer('b', 'Bob');
  t.addPlayer('c', 'Cara');
  const start = total(t);
  t.startHand(seeded(42));

  // preflop: UTG calls, button calls, SB calls, BB checks
  let guard = 0;
  while (t.hand.street !== 'showdown' && guard++ < 100) {
    const h = t.hand;
    const seat = h.seats[h.toAct];
    const toCall = h.currentBet - seat.bet;
    t.act(seat.id, toCall > 0 ? { type: 'call' } : { type: 'check' });
  }
  assert.strictEqual(t.hand.street, 'showdown', 'reached showdown');
  assert.strictEqual(t.hand.board.length, 5, '5 board cards');
  assert.ok(t.hand.winners, 'has winners');
  assert.strictEqual(total(t), start, 'chips conserved');
  console.log('✓ 3p check-down →', t.hand.winners.results.map(r => `${r.name}+${r.amount}`).join(', '));
}

// --- fold wins immediately ---
{
  const t = new Table({ smallBlind: 10, bigBlind: 20, startingChips: 1000 });
  t.addPlayer('a', 'Alice');
  t.addPlayer('b', 'Bob');
  t.startHand(seeded(7));
  // heads-up preflop: button/SB acts first
  const first = t.hand.seats[t.hand.toAct].id;
  t.act(first, { type: 'fold' });
  assert.ok(t.hand.winners, 'fold ended hand');
  assert.strictEqual(total(t), 2000, 'chips conserved after fold');
  console.log('✓ heads-up fold →', t.hand.winners.results.map(r => `${r.name}+${r.amount}`).join(', '));
}

// --- raise reopens action ---
{
  const t = new Table({ smallBlind: 10, bigBlind: 20, startingChips: 1000 });
  t.addPlayer('a', 'A'); t.addPlayer('b', 'B'); t.addPlayer('c', 'C');
  t.startHand(seeded(99));
  const h = t.hand;
  const utg = h.seats[h.toAct].id;
  t.act(utg, { type: 'raise', amount: 60 });
  assert.strictEqual(h.currentBet, 60, 'raise set currentBet');
  assert.ok(h.seats.filter(s => !s.folded && !s.allIn).some(s => !s.acted), 'action reopened');
  console.log('✓ raise reopens action');
}

// --- host-controlled mode: hostAct drives the current player ---
{
  const t = new Table({ smallBlind: 10, bigBlind: 20, startingChips: 1000, controlMode: 'host' });
  t.addPlayer('a', 'A'); t.addPlayer('b', 'B'); t.addPlayer('c', 'C');
  t.startHand(seeded(3));
  let guard = 0;
  while (t.hand.street !== 'showdown' && guard++ < 100) {
    const h = t.hand;
    const seat = h.seats[h.toAct];
    const toCall = h.currentBet - seat.bet;
    t.hostAct(toCall > 0 ? { type: 'call' } : { type: 'check' }); // host presses for whoever's turn
  }
  assert.strictEqual(t.hand.street, 'showdown', 'host mode reached showdown');
  assert.strictEqual(t.players.reduce((s, p) => s + p.chips, 0), 3000, 'chips conserved (host mode)');
  console.log('✓ host-mode check-down →', t.hand.winners.results.map(r => `${r.name}+${r.amount}`).join(', '));
}

// --- setBlinds: allowed between hands, blocked mid-hand, validated ---
{
  const t = new Table({ smallBlind: 10, bigBlind: 20, startingChips: 1000 });
  t.addPlayer('a', 'A'); t.addPlayer('b', 'B');
  t.setBlinds(50, 100); // between hands: ok
  assert.strictEqual(t.bigBlind, 100, 'blinds updated between hands');
  t.startHand(seeded(1));
  assert.throws(() => t.setBlinds(100, 200), /핸드 진행 중/, 'blocked mid-hand');
  assert.throws(() => new Table().setBlinds(50, 40), /빅블라인드/, 'bb must exceed sb');
  console.log('✓ setBlinds 검증 (핸드 사이만, bb>sb)');
}

// --- auth: hash roundtrip, wrong password rejected, dup blocked ---
{
  const { register, login } = await import('./auth.js');
  const fs = await import('fs');
  const F = new URL('./users.json', import.meta.url);
  const purge = () => { try { const u = JSON.parse(fs.readFileSync(F, 'utf8')); delete u.zzz_selfcheck;
    fs.writeFileSync(F, JSON.stringify(u, null, 2)); } catch {} };
  purge();
  register('zzz_selfcheck', 'pw1234');
  const raw = JSON.parse(fs.readFileSync(F, 'utf8')).zzz_selfcheck.hash;
  assert.ok(!raw.includes('pw1234'), 'password not stored in plaintext');
  assert.ok(login('zzz_selfcheck', 'pw1234'), 'correct password logs in');
  assert.throws(() => login('zzz_selfcheck', 'wrong'), /틀렸/, 'wrong password rejected');
  assert.throws(() => register('zzz_selfcheck', 'pw1234'), /이미 있는/, 'duplicate blocked');
  assert.throws(() => register('ab', 'pw1234'), /3~20/, 'short username rejected');
  purge();
  console.log('✓ auth (해시 저장·오답 거부·중복 차단)');
}

console.log('\n모든 self-check 통과');
