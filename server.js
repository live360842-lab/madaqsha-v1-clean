const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const rooms = new Map();
const players = new Map();
const stats = new Map();
const BID_STEPS = [250, 500, 1000, 2000, 3000, 5000, 10000];
const BOT_NAMES = ['شاهين', 'راكان', 'نواف', 'سلمان', 'مازن', 'مهند'];
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7'];

function id(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

function clean(value, fallback = '') {
  return String(value || fallback).trim().slice(0, 80);
}

function roomCode() {
  let code;
  do code = Math.random().toString(36).slice(2, 7).toUpperCase();
  while (rooms.has(code));
  return code;
}

function avatar(name) {
  const n = encodeURIComponent((name || 'م').slice(0, 2));
  return `https://api.dicebear.com/7.x/initials/svg?seed=${n}&backgroundColor=8b6f2a&fontFamily=Tajawal`;
}

function ensureStats(player) {
  if (!stats.has(player.id)) {
    stats.set(player.id, {
      playerId: player.id,
      name: player.name,
      avatar: player.avatar,
      accountType: player.accountType,
      roomsJoined: 0,
      roomsCreated: 0,
      rounds: 0,
      wins: 0,
      losses: 0,
      netPoints: 0,
      highBalance: 0,
      recentRounds: [],
    });
  }
  return stats.get(player.id);
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    balance: p.balance,
    currentContribution: p.currentContribution || 0,
    role: p.role,
    isHost: p.isHost,
    isBot: p.isBot,
    botLevel: p.botLevel,
    status: p.status,
    connected: p.connected,
    folded: p.folded,
    cardCount: p.hand ? p.hand.length : 0,
  };
}

function makeDeck() {
  const cards = [];
  for (const suit of SUITS) {
    RANKS.forEach((rank, index) => cards.push({ id: id('card'), rank, suit, power: RANKS.length - index }));
  }
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function addEvent(room, text) {
  room.events.unshift({ id: id('evt'), text, at: new Date().toISOString() });
  room.events = room.events.slice(0, 80);
  room.lastEvent = text;
}

function serialize(room, viewerId) {
  return {
    code: room.code,
    name: room.name,
    isPublic: room.isPublic,
    inviteUrl: `/invite/${room.code}`,
    seats: room.seats,
    cardsPerPlayer: room.cardsPerPlayer,
    phase: room.phase,
    hostId: room.hostId,
    highestBid: room.highestBid,
    currentBid: room.currentBid,
    minBid: room.minBid,
    minRaise: room.minRaise,
    pot: room.pot,
    turnPlayerId: room.turnPlayerId,
    round: room.round,
    lastEvent: room.lastEvent,
    players: room.players.map(publicPlayer),
    spectators: room.spectators.map(publicPlayer),
    events: room.events,
    chat: room.chat,
    revealed: room.revealed,
    bidSteps: BID_STEPS,
    myHand: room.players.find((p) => p.id === viewerId)?.hand || [],
  };
}

function publicRooms() {
  return [...rooms.values()].filter((r) => r.isPublic).map((r) => ({
    code: r.code,
    name: r.name,
    seats: r.seats,
    players: r.players.length,
    phase: r.phase,
    minBid: r.minBid,
  }));
}

function leaderboard() {
  return [...stats.values()].sort((a, b) => b.netPoints - a.netPoints).slice(0, 20);
}

function emitRoom(room) {
  for (const player of [...room.players, ...room.spectators]) {
    if (player.socketId) io.to(player.socketId).emit('room:update', serialize(room, player.id));
  }
}

function createPlayer(raw, socketId) {
  const name = clean(raw.name, 'لاعب مداقشة');
  const p = {
    id: raw.id || id('p'),
    socketId,
    name,
    avatar: raw.avatar || avatar(name),
    accountType: raw.accountType || 'local',
    balance: Number(raw.balance || 50000),
    currentContribution: 0,
    role: 'لاعب',
    isHost: false,
    isBot: false,
    status: 'ينتظر',
    connected: true,
    folded: false,
    hand: [],
    roomCode: null,
  };
  players.set(p.id, p);
  const s = ensureStats(p);
  s.highBalance = Math.max(s.highBalance, p.balance);
  return p;
}

function createRoom(host, settings) {
  const code = roomCode();
  const room = {
    code,
    name: clean(settings.name, 'مجلس مداقشة'),
    isPublic: settings.type !== 'private',
    seats: Number(settings.seats || 4) === 6 ? 6 : 4,
    cardsPerPlayer: Number(settings.cardsPerPlayer || 4) === 8 ? 8 : 4,
    initialBalance: Number(settings.initialBalance || 50000),
    minBid: Number(settings.minBid || 250),
    minRaise: Number(settings.minRaise || 250),
    targetScore: Number(settings.targetScore || 100000),
    phase: 'waiting',
    hostId: host.id,
    highestBid: 0,
    currentBid: Number(settings.minBid || 250),
    pot: 0,
    turnPlayerId: null,
    round: 0,
    players: [],
    spectators: [],
    events: [],
    chat: [],
    revealed: null,
    lastEvent: 'تم إنشاء المجلس',
  };
  host.isHost = true;
  host.role = 'مدير';
  host.status = 'مدير';
  host.balance = room.initialBalance;
  host.roomCode = code;
  room.players.push(host);
  rooms.set(code, room);
  const s = ensureStats(host);
  s.roomsCreated += 1;
  s.roomsJoined += 1;
  s.highBalance = Math.max(s.highBalance, host.balance);
  addEvent(room, `أنشأ ${host.name} المجلس`);
  return room;
}

function joinRoom(code, player, spectator = false) {
  const room = rooms.get(clean(code).toUpperCase());
  if (!room) throw new Error('كود المجلس غير صحيح.');
  player.roomCode = room.code;
  player.balance = room.initialBalance;
  if (spectator) {
    if (!room.spectators.find((p) => p.id === player.id)) room.spectators.push(player);
    player.status = 'مشاهد';
    addEvent(room, `دخل ${player.name} كمشاهد`);
  } else {
    if (room.players.length >= room.seats) throw new Error('المجلس مكتمل.');
    if (!room.players.find((p) => p.id === player.id)) room.players.push(player);
    player.status = 'ينتظر';
    ensureStats(player).roomsJoined += 1;
    addEvent(room, `دخل ${player.name} المجلس`);
  }
  return room;
}

function addBot(room, actorId, level = 'medium') {
  if (room.hostId !== actorId) throw new Error('إضافة البوتات للمدير فقط.');
  if (room.players.length >= room.seats) throw new Error('كل المقاعد ممتلئة.');
  const name = `${BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]} بوت`;
  const bot = {
    id: id('bot'), socketId: null, name, avatar: avatar(name), accountType: 'bot', balance: room.initialBalance,
    currentContribution: 0, role: 'بوت', isHost: false, isBot: true, botLevel: level, status: 'بوت', connected: true, folded: false, hand: [], roomCode: room.code,
  };
  players.set(bot.id, bot);
  ensureStats(bot).roomsJoined += 1;
  room.players.push(bot);
  addEvent(room, `${name} جلس على الطاولة`);
}

function startRound(room, actorId) {
  if (room.hostId !== actorId) throw new Error('بدء الجولة للمدير فقط.');
  if (room.players.length < 1) throw new Error('لا يوجد لاعبون.');
  const deck = makeDeck();
  room.round += 1;
  room.phase = 'bidding';
  room.highestBid = 0;
  room.currentBid = room.minBid;
  room.pot = 0;
  room.revealed = null;
  room.players.forEach((p) => {
    p.hand = deck.splice(0, room.cardsPerPlayer);
    p.currentContribution = 0;
    p.folded = false;
    p.status = p.isBot ? 'بوت' : 'ينتظر';
  });
  room.turnPlayerId = room.players[0].id;
  room.players[0].status = 'دوره';
  addEvent(room, `بدأت الجولة ${room.round}`);
  scheduleBot(room);
}

function score(hand) {
  return hand.reduce((a, c) => a + c.power, 0);
}

function nextActive(room, currentId) {
  const active = room.players.filter((p) => !p.folded && p.balance > 0);
  if (!active.length) return null;
  const idx = active.findIndex((p) => p.id === currentId);
  return active[(idx + 1 + active.length) % active.length].id;
}

function bid(room, playerId, amount) {
  if (room.phase !== 'bidding') throw new Error('المزايدة غير متاحة الآن.');
  if (room.turnPlayerId !== playerId) throw new Error('ليس دورك الآن.');
  const p = room.players.find((x) => x.id === playerId);
  if (!p || p.folded) throw new Error('لا يمكنك المزايدة.');
  const value = Math.max(Number(amount || 0), room.highestBid ? room.highestBid + room.minRaise : room.minBid);
  const add = value - p.currentContribution;
  if (add > p.balance) throw new Error('الرصيد لا يكفي.');
  p.balance -= add;
  p.currentContribution = value;
  room.highestBid = Math.max(room.highestBid, value);
  room.currentBid = room.highestBid + room.minRaise;
  room.pot += add;
  addEvent(room, `${p.name} زايد إلى ${value}`);
  advance(room, playerId);
}

function fold(room, playerId) {
  if (room.phase !== 'bidding') throw new Error('الانسحاب غير متاح الآن.');
  if (room.turnPlayerId !== playerId) throw new Error('ليس دورك الآن.');
  const p = room.players.find((x) => x.id === playerId);
  if (!p) throw new Error('اللاعب غير موجود.');
  p.folded = true;
  p.status = 'منسحب';
  addEvent(room, `${p.name} انسحب`);
  advance(room, playerId);
}

function advance(room, playerId) {
  const active = room.players.filter((p) => !p.folded);
  if (active.length <= 1 || active.every((p) => p.currentContribution >= room.highestBid || p.balance <= 0)) return reveal(room);
  room.players.forEach((p) => { if (!p.folded) p.status = p.isBot ? 'بوت' : 'ينتظر'; });
  room.turnPlayerId = nextActive(room, playerId);
  const p = room.players.find((x) => x.id === room.turnPlayerId);
  if (p) p.status = 'دوره';
  scheduleBot(room);
}

function reveal(room) {
  room.phase = 'revealed';
  room.turnPlayerId = null;
  const contenders = room.players.filter((p) => !p.folded);
  const winner = (contenders.length ? contenders : room.players).sort((a, b) => score(b.hand) - score(a.hand))[0];
  winner.balance += room.pot;
  room.revealed = { winnerId: winner.id, winnerName: winner.name, pot: room.pot, score: score(winner.hand), hands: room.players.map((p) => ({ name: p.name, score: score(p.hand), contribution: p.currentContribution, hand: p.hand })) };
  room.players.forEach((p) => {
    const s = ensureStats(p); s.rounds += 1;
    const net = p.id === winner.id ? room.pot - p.currentContribution : -p.currentContribution;
    if (p.id === winner.id) s.wins += 1; else s.losses += 1;
    s.netPoints += net; s.highBalance = Math.max(s.highBalance, p.balance);
    s.recentRounds.unshift({ at: new Date().toISOString(), won: p.id === winner.id, net, balance: p.balance });
    s.recentRounds = s.recentRounds.slice(0, 10);
    p.status = p.id === winner.id ? 'فائز' : (p.folded ? 'منسحب' : 'خاسر');
  });
  addEvent(room, `انتهت الجولة وفاز ${winner.name}`);
}

function nextRound(room, actorId) {
  if (room.hostId !== actorId) throw new Error('الجولة الجديدة للمدير فقط.');
  room.phase = 'betweenRounds';
  room.highestBid = 0; room.currentBid = room.minBid; room.pot = 0; room.revealed = null; room.turnPlayerId = null;
  room.players.forEach((p) => { p.hand = []; p.currentContribution = 0; p.folded = false; p.status = p.isBot ? 'بوت' : 'ينتظر'; });
  addEvent(room, 'المجلس جاهز لجولة جديدة');
}

function scheduleBot(room) {
  const bot = room.players.find((p) => p.id === room.turnPlayerId && p.isBot);
  if (!bot) return;
  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh || fresh.phase !== 'bidding' || fresh.turnPlayerId !== bot.id) return;
    try {
      if (score(bot.hand) < 20 && fresh.highestBid > fresh.minBid) fold(fresh, bot.id);
      else bid(fresh, bot.id, Math.min(bot.balance + bot.currentContribution, fresh.currentBid));
      emitRoom(fresh);
      io.emit('rooms:list', publicRooms());
      io.emit('leaderboard:list', leaderboard());
    } catch (e) { addEvent(fresh, e.message); emitRoom(fresh); }
  }, bot.botLevel === 'strong' ? 900 : bot.botLevel === 'easy' ? 1600 : 1200);
}

app.get('/invite/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/public-rooms', (req, res) => res.json(publicRooms()));
app.get('/api/leaderboard', (req, res) => res.json(leaderboard()));

io.on('connection', (socket) => {
  socket.emit('rooms:list', publicRooms());
  socket.emit('leaderboard:list', leaderboard());

  socket.on('auth:local', (raw, reply) => {
    const p = createPlayer(raw || {}, socket.id);
    reply({ ok: true, player: publicPlayer(p), stats: ensureStats(p) });
  });

  socket.on('room:create', ({ playerId, settings }, reply) => {
    try { const room = createRoom(players.get(playerId), settings || {}); socket.join(room.code); reply({ ok: true, room: serialize(room, playerId) }); io.emit('rooms:list', publicRooms()); }
    catch (e) { reply({ ok: false, error: e.message }); }
  });

  socket.on('room:join', ({ playerId, code, spectator }, reply) => {
    try { const room = joinRoom(code, players.get(playerId), spectator); socket.join(room.code); reply({ ok: true, room: serialize(room, playerId) }); emitRoom(room); io.emit('rooms:list', publicRooms()); }
    catch (e) { reply({ ok: false, error: e.message }); }
  });

  socket.on('room:add-bot', ({ playerId, roomCode, level }, reply) => {
    try { const room = rooms.get(clean(roomCode).toUpperCase()); addBot(room, playerId, level); reply({ ok: true }); emitRoom(room); }
    catch (e) { reply({ ok: false, error: e.message }); }
  });

  socket.on('round:start', ({ playerId, roomCode }, reply) => {
    try { const room = rooms.get(clean(roomCode).toUpperCase()); startRound(room, playerId); reply({ ok: true }); emitRoom(room); }
    catch (e) { reply({ ok: false, error: e.message }); }
  });

  socket.on('round:next', ({ playerId, roomCode }, reply) => {
    try { const room = rooms.get(clean(roomCode).toUpperCase()); nextRound(room, playerId); reply({ ok: true }); emitRoom(room); }
    catch (e) { reply({ ok: false, error: e.message }); }
  });

  socket.on('bid:place', ({ playerId, roomCode, amount }, reply) => {
    try { const room = rooms.get(clean(roomCode).toUpperCase()); bid(room, playerId, amount); reply({ ok: true }); emitRoom(room); io.emit('leaderboard:list', leaderboard()); }
    catch (e) { reply({ ok: false, error: e.message }); }
  });

  socket.on('bid:fold', ({ playerId, roomCode }, reply) => {
    try { const room = rooms.get(clean(roomCode).toUpperCase()); fold(room, playerId); reply({ ok: true }); emitRoom(room); io.emit('leaderboard:list', leaderboard()); }
    catch (e) { reply({ ok: false, error: e.message }); }
  });

  socket.on('chat:send', ({ playerId, roomCode, text }, reply) => {
    try { const room = rooms.get(clean(roomCode).toUpperCase()); const p = players.get(playerId); room.chat.unshift({ id: id('msg'), name: p.name, text: clean(text).slice(0, 180), at: new Date().toISOString() }); room.chat = room.chat.slice(0, 80); reply({ ok: true }); emitRoom(room); }
    catch (e) { reply({ ok: false, error: e.message }); }
  });

  socket.on('profile:get', ({ playerId }, reply) => reply({ ok: stats.has(playerId), stats: stats.get(playerId) || null }));
});

server.listen(PORT, () => console.log(`Madaqsha running on ${PORT}`));
