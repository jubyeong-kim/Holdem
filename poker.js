// Texas Hold'em engine: one Table = one game room.
// ponytail: main-pot only, no side pots. Multiway all-ins pay the whole pot to
// the best eligible hand (over-pays short stacks). Add side-pot splitting when
// real chip accounting matters.
import pkg from 'pokersolver';
const { Hand } = pkg;

const RANKS = '23456789TJQKA'.split('');
const SUITS = 'hdcs'.split('');

function freshDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  return d;
}

// Fisher–Yates with an injectable RNG (Math.random by default).
function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];

export class Table {
  constructor({ smallBlind = 10, bigBlind = 20, startingChips = 1000, controlMode = 'guest' } = {}) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.startingChips = startingChips;
    this.controlMode = controlMode; // 'guest' = each player acts; 'host' = host phone drives

    this.players = []; // {id, name, chips, connected}
    this.button = -1;
    this.hand = null; // active hand state, or null between hands
    this.log = [];
  }

  addPlayer(id, name) {
    let p = this.players.find((x) => x.id === id);
    if (p) { p.connected = true; p.name = name || p.name; return p; }
    p = { id, name, chips: this.startingChips, connected: true };
    this.players.push(p);
    return p;
  }

  setConnected(id, v) {
    const p = this.players.find((x) => x.id === id);
    if (p) p.connected = v;
  }

  seatedForHand() {
    return this.players.filter((p) => p.chips > 0);
  }

  // ---- hand lifecycle ----------------------------------------------------
  startHand(rng = Math.random) {
    const seated = this.seatedForHand();
    if (seated.length < 2) throw new Error('플레이어가 2명 이상이어야 시작할 수 있어');

    this.button = this.nextOccupied(this.button, seated);
    const deck = shuffle(freshDeck(), rng);

    const h = {
      deck,
      board: [],
      street: 'preflop',
      pot: 0,
      currentBet: 0,
      minRaise: this.bigBlind,
      seats: seated.map((p) => ({
        id: p.id,
        hole: [deck.pop(), deck.pop()],
        bet: 0,       // chips in this street
        committed: 0, // chips in this hand
        folded: false,
        allIn: false,
        acted: false,
      })),
      toAct: 0,
      lastAggressor: null,
      winners: null,
    };
    // seat index of the button player (this.button indexes this.players)
    h.buttonSeat = h.seats.findIndex((s) => s.id === this.players[this.button].id);
    if (h.buttonSeat < 0) h.buttonSeat = 0;
    this.hand = h;

    const n = h.seats.length;
    const btn = h.buttonSeat;
    const sbSeat = n === 2 ? btn : (btn + 1) % n;
    const bbSeat = n === 2 ? (btn + 1) % n : (btn + 2) % n;
    this.postBlind(h, sbSeat, this.smallBlind);
    this.postBlind(h, bbSeat, this.bigBlind);
    h.currentBet = this.bigBlind;
    h.minRaise = this.bigBlind;
    h.toAct = this.nextActor(h, bbSeat); // UTG (heads-up: SB/button acts first preflop)
    this.log.push(`새 핸드 시작 (버튼: ${this.seatName(h, btn)})`);
    return h;
  }

  buttonIdx(h) { return h.buttonSeat; }

  postBlind(h, seatIdx, amount) {
    const seat = h.seats[seatIdx];
    const p = this.player(seat.id);
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    seat.bet += pay;
    seat.committed += pay;
    h.pot += pay;
    if (p.chips === 0) seat.allIn = true;
  }

  // ---- actions -----------------------------------------------------------
  // action: {type: 'fold'|'check'|'call'|'raise', amount?} amount = raise-to total
  act(playerId, action) {
    const h = this.hand;
    if (!h || h.street === 'showdown') throw new Error('진행 중인 핸드가 없어');
    const seat = h.seats[h.toAct];
    if (seat.id !== playerId) throw new Error('네 차례가 아니야');

    const p = this.player(seat.id);
    const toCall = h.currentBet - seat.bet;

    switch (action.type) {
      case 'fold':
        seat.folded = true;
        break;
      case 'check':
        if (toCall > 0) throw new Error('체크할 수 없어, 콜 금액이 있어');
        break;
      case 'call': {
        const pay = Math.min(toCall, p.chips);
        this.moveChips(h, seat, p, pay);
        break;
      }
      case 'raise': {
        const target = action.amount;
        const maxTotal = seat.bet + p.chips;
        if (target > maxTotal) throw new Error('칩이 부족해');
        const isAllIn = target === maxTotal;
        const minLegal = h.currentBet + h.minRaise;
        if (!isAllIn && target < minLegal)
          throw new Error(`최소 ${minLegal}까지 레이즈해야 해`);
        if (target <= h.currentBet) throw new Error('현재 벳보다 커야 해');
        const raiseBy = target - h.currentBet;
        this.moveChips(h, seat, p, target - seat.bet);
        if (raiseBy >= h.minRaise) h.minRaise = raiseBy;
        h.currentBet = target;
        h.lastAggressor = h.toAct;
        // a real raise reopens the action
        for (const s of h.seats) if (!s.folded && !s.allIn) s.acted = false;
        break;
      }
      default:
        throw new Error('알 수 없는 액션');
    }
    seat.acted = true;
    this.log.push(`${this.seatName(h, h.toAct)}: ${this.describe(action, toCall)}`);
    this.advance(h);
    return h;
  }

  // change stakes; only allowed between hands
  setBlinds(sb, bb) {
    if (this.hand && this.hand.street !== 'showdown') throw new Error('핸드 진행 중엔 판돈을 못 바꿔');
    if (!(sb > 0) || !(bb > sb)) throw new Error('빅블라인드는 스몰블라인드보다 커야 해');
    this.smallBlind = sb; this.bigBlind = bb;
  }

  // host-controlled mode: apply an action to whoever is currently to act
  hostAct(action) {
    const h = this.hand;
    if (!h || h.street === 'showdown') throw new Error('진행 중인 핸드가 없어');
    return this.act(h.seats[h.toAct].id, action);
  }

  moveChips(h, seat, p, amount) {
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    seat.bet += pay;
    seat.committed += pay;
    h.pot += pay;
    if (p.chips === 0) seat.allIn = true;
  }

  // Move play forward: next actor, end of street, or showdown.
  advance(h) {
    const live = h.seats.filter((s) => !s.folded);
    if (live.length === 1) { this.awardPot(h, live); return; }

    if (this.bettingClosed(h)) {
      this.nextStreet(h);
      return;
    }
    h.toAct = this.nextActor(h, h.toAct);
  }

  bettingClosed(h) {
    const contenders = h.seats.filter((s) => !s.folded && !s.allIn);
    // everyone still able to act has matched the bet and acted at least once
    if (contenders.some((s) => !s.acted || s.bet !== h.currentBet)) return false;
    return true;
  }

  nextStreet(h) {
    for (const s of h.seats) { s.bet = 0; s.acted = false; }
    h.currentBet = 0;
    h.minRaise = this.bigBlind;
    h.lastAggressor = null;

    const idx = STREETS.indexOf(h.street);
    const next = STREETS[idx + 1];
    h.street = next;
    if (next === 'flop') h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop());
    else if (next === 'turn' || next === 'river') h.board.push(h.deck.pop());

    // if only one player can still act, deal out to showdown
    const canAct = h.seats.filter((s) => !s.folded && !s.allIn);
    if (next === 'showdown') { this.showdown(h); return; }
    if (canAct.length <= 1) { this.nextStreet(h); return; }

    // first to act after button (heads-up: button acts first? no—SB/button acts first only preflop)
    h.toAct = this.nextActor(h, this.buttonIdx(h));
    this.log.push(`--- ${next} --- 보드: ${h.board.join(' ')}`);
  }

  showdown(h) {
    const live = h.seats.filter((s) => !s.folded);
    if (live.length === 1) { this.awardPot(h, live); return; }
    const scored = live.map((s) => ({
      seat: s,
      hand: Hand.solve([...s.hole, ...h.board]),
    }));
    const winners = Hand.winners(scored.map((x) => x.hand));
    const winSeats = scored.filter((x) => winners.includes(x.hand)).map((x) => x.seat);
    this.awardPot(h, winSeats, scored);
  }

  awardPot(h, winSeats, scored) {
    const share = Math.floor(h.pot / winSeats.length);
    let remainder = h.pot - share * winSeats.length;
    const results = [];
    for (const s of winSeats) {
      const p = this.player(s.id);
      let amt = share;
      if (remainder > 0) { amt += 1; remainder -= 1; } // odd chip to first winner(s)
      p.chips += amt;
      results.push({ id: s.id, name: p.name, amount: amt });
    }
    h.pot = 0;
    h.street = 'showdown';
    h.winners = {
      seats: winSeats.map((s) => s.id),
      results,
      // reveal hole cards at showdown (not on fold-win)
      reveal: scored ? scored.map((x) => ({ id: x.seat.id, hole: x.seat.hole, desc: x.hand.descr })) : null,
    };
    this.log.push(`핸드 종료: ${results.map((r) => `${r.name} +${r.amount}`).join(', ')}`);
  }

  // ---- seat/index helpers ------------------------------------------------
  nextActor(h, fromIdx) {
    const n = h.seats.length;
    for (let i = 1; i <= n; i++) {
      const idx = (fromIdx + i) % n;
      const s = h.seats[idx];
      if (!s.folded && !s.allIn) return idx;
    }
    return fromIdx;
  }

  nextOccupied(fromButton, seated) {
    if (this.button < 0) return this.players.indexOf(seated[0]);
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (fromButton + i) % n;
      if (this.players[idx].chips > 0) return idx;
    }
    return fromButton;
  }

  player(id) { return this.players.find((p) => p.id === id); }
  seatName(h, idx) { return this.player(h.seats[idx].id)?.name ?? '?'; }
  describe(a, toCall) {
    if (a.type === 'fold') return '폴드';
    if (a.type === 'check') return '체크';
    if (a.type === 'call') return `콜 ${toCall}`;
    return `레이즈 to ${a.amount}`;
  }

  // ---- view for clients --------------------------------------------------
  // forId: include that player's hole cards; host view omits all hole cards
  // unless revealed at showdown.
  view(forId = null) {
    const h = this.hand;
    const base = {
      code: this.code,
      controlMode: this.controlMode,
      qr: this.qr,               // {join, control} data-URI PNGs (set by server)
      urls: this.urls,           // {join, control} plain URLs (set by server)
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, chips: p.chips, connected: p.connected,
      })),
      log: this.log.slice(-12),
      inHand: !!h && h.street !== 'showdown',
    };
    if (!h) return { ...base, hand: null };

    const reveal = h.winners?.reveal || [];
    const seats = h.seats.map((s, i) => {
      const revealed = reveal.find((r) => r.id === s.id);
      const showHole = s.id === forId || revealed;
      return {
        id: s.id,
        name: this.player(s.id)?.name,
        bet: s.bet,
        committed: s.committed,
        folded: s.folded,
        allIn: s.allIn,
        isButton: i === this.buttonIdx(h),
        toAct: i === h.toAct && h.street !== 'showdown',
        hole: showHole ? s.hole : (s.folded ? null : ['??', '??']),
        handDesc: revealed?.desc || null,
      };
    });

    const me = h.seats.find((s) => s.id === forId);
    const toCall = me ? h.currentBet - me.bet : 0;
    return {
      ...base,
      hand: {
        street: h.street,
        board: h.board,
        pot: h.pot,
        currentBet: h.currentBet,
        minRaise: h.minRaise,
        toActId: h.street !== 'showdown' ? h.seats[h.toAct].id : null,
        seats,
        winners: h.winners,
      },
      me: me ? {
        toCall: Math.max(0, toCall),
        chips: this.player(forId).chips,
        canCheck: toCall <= 0,
        yourTurn: h.seats[h.toAct]?.id === forId && h.street !== 'showdown',
      } : null,
    };
  }
}
