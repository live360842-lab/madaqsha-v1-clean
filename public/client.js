const socket = io();
let currentPlayer = JSON.parse(localStorage.getItem('madaqsha.player') || 'null');
let currentRoom = null;
let selectedBid = 250;
let activeTab = 'chat';

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function call(event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function money(n) {
  return Number(n || 0).toLocaleString('ar-SA');
}

function phaseName(phase) {
  return { waiting: 'قبل بدء المجلس', betweenRounds: 'بين الجولات', bidding: 'المزايدة', negotiation: 'التفاوض', revealed: 'كشف الجولة' }[phase] || phase;
}

function setLoggedIn(player) {
  currentPlayer = player;
  localStorage.setItem('madaqsha.player', JSON.stringify(player));
  $('profileBtn').disabled = false;
  $('logoutBtn').disabled = false;
  toast(`مرحبًا ${player.name}`);
}

async function login(type) {
  const name = $('playerName').value.trim() || (type === 'google' ? 'لاعب Google' : 'لاعب مداقشة');
  const res = await call('auth:local', { id: currentPlayer?.id, name, accountType: type });
  if (!res.ok) return toast(res.error);
  setLoggedIn(res.player);
}

function requireLogin() {
  if (!currentPlayer) {
    toast('سجل الدخول أولًا.');
    return false;
  }
  return true;
}

async function createRoom() {
  if (!requireLogin()) return;
  const settings = {
    name: $('roomName').value,
    type: $('roomType').value,
    seats: Number($('roomSeats').value),
    cardsPerPlayer: Number($('cardsPerPlayer').value),
    initialBalance: Number($('initialBalance').value),
    minBid: Number($('minBid').value),
    minRaise: Number($('minRaise').value),
  };
  const res = await call('room:create', { playerId: currentPlayer.id, settings });
  if (!res.ok) return toast(res.error);
  showGame(res.room);
}

async function joinRoom(spectator = false, codeOverride = null) {
  if (!requireLogin()) return;
  const code = codeOverride || $('joinCode').value.trim();
  if (!code) return toast('أدخل كود المجلس.');
  const res = await call('room:join', { playerId: currentPlayer.id, code, spectator });
  if (!res.ok) return toast(res.error);
  showGame(res.room);
}

function showGame(room) {
  currentRoom = room;
  selectedBid = Math.max(room.currentBid || room.minBid || 250, 250);
  $('loginScreen').hidden = true;
  $('gameScreen').hidden = false;
  renderRoom();
}

function slots(room) {
  const all = [...room.players];
  while (all.length < room.seats) all.push(null);
  const cls4 = ['bottom', 'top', 'right', 'left'];
  const cls6 = ['bottom', 'top', 'right', 'left', 'upper-right', 'upper-left'];
  return all.slice(0, room.seats).map((p, i) => ({ player: p, pos: (room.seats === 6 ? cls6 : cls4)[i] }));
}

function cardBacks(count) {
  return `<div class="mini-cards">${Array.from({ length: Math.min(count || 0, 4) }).map(() => '<span></span>').join('')}</div>`;
}

function renderSeats() {
  $('seatLayer').innerHTML = slots(currentRoom).map(({ player, pos }) => {
    if (!player) return `<article class="seat ${pos} empty"><div class="avatar">+</div><strong>مقعد متاح</strong><small>بانتظار لاعب</small>${cardBacks(0)}</article>`;
    return `<article class="seat ${pos} ${player.id === currentPlayer?.id ? 'me' : ''} ${player.folded ? 'folded' : ''}">
      <img class="avatar" src="${player.avatar}" alt="" />
      <strong>${player.name}</strong>
      <small>${money(player.balance)} نقطة</small>
      <span class="seat-badge">${player.isHost ? 'مدير' : player.isBot ? 'بوت' : player.status || 'ينتظر'}</span>
      <em>مساهمة: ${money(player.currentContribution)}</em>
      ${currentRoom.phase === 'waiting' || currentRoom.phase === 'betweenRounds' ? '' : cardBacks(player.cardCount)}
    </article>`;
  }).join('');
}

function renderCenter() {
  const turn = currentRoom.players.find((p) => p.id === currentRoom.turnPlayerId);
  $('roomMeta').textContent = ` | ${currentRoom.code} | ${currentRoom.isPublic ? 'عام' : 'خاص'} | ${phaseName(currentRoom.phase)}`;
  $('tableCenter').innerHTML = `
    <h2>${phaseName(currentRoom.phase)}</h2>
    <p>${currentRoom.lastEvent || 'بدأ المجلس'}</p>
    <div class="center-stats">
      <span>أعلى مزايدة<br><b>${money(currentRoom.highestBid)}</b></span>
      <span>الجائزة<br><b>${money(currentRoom.pot)}</b></span>
      <span>الدور<br><b>${turn ? turn.name : '—'}</b></span>
    </div>`;
}

function renderHand() {
  const hand = currentRoom.phase === 'bidding' || currentRoom.phase === 'revealed' ? currentRoom.myHand : [];
  $('myHand').innerHTML = hand.map((c, i) => `<div class="card" style="--i:${i};--n:${hand.length}"><b>${c.rank}</b><span>${c.suit}</span></div>`).join('');
}

function renderBidLadder() {
  const show = currentRoom.phase === 'bidding';
  $('bidLadder').hidden = !show;
  if (!show) return;
  $('bidLadder').innerHTML = currentRoom.bidSteps.map((v) => `<button class="${selectedBid === v ? 'active' : ''}" data-bid="${v}">${money(v)}</button>`).join('');
}

function renderDecision() {
  const isHost = currentRoom.hostId === currentPlayer?.id;
  const isMyTurn = currentRoom.turnPlayerId === currentPlayer?.id;
  if (currentRoom.phase === 'waiting') {
    $('decisionPanel').innerHTML = `<h3>قبل بدء المجلس</h3><p>بانتظار بدء المجلس. المقاعد تظهر حتى لو كانت فارغة.</p><div class="actions">${isHost ? '<button id="startRound" class="primary">بدء المجلس</button><button id="addBot">إضافة بوت</button>' : '<button disabled>بانتظار المدير</button>'}</div>`;
  } else if (currentRoom.phase === 'betweenRounds') {
    $('decisionPanel').innerHTML = `<h3>بين الجولات</h3><p>اللاعبون يستعدون للجولة التالية.</p><div class="actions">${isHost ? '<button id="startRound" class="primary">بدء الجولة</button>' : '<button disabled>بانتظار المدير</button>'}</div>`;
  } else if (currentRoom.phase === 'bidding') {
    const turn = currentRoom.players.find((p) => p.id === currentRoom.turnPlayerId);
    $('decisionPanel').innerHTML = isMyTurn
      ? `<h3>دورك في المزايدة</h3><div class="bid-row"><button id="foldBtn" class="danger">انسحب</button><output>${money(selectedBid)}</output><button id="bidBtn" class="primary">مساومة ${money(selectedBid)}</button><button id="allInBtn">رأس المال كامل</button></div>`
      : `<h3>أثناء المزايدة</h3><p>الدور على ${turn ? turn.name : 'لاعب آخر'}.</p><button disabled>أزرار المزايدة معطلة</button>`;
  } else if (currentRoom.phase === 'revealed') {
    $('decisionPanel').innerHTML = `<h3>نتيجة الجولة</h3><p>الفائز: <b>${currentRoom.revealed?.winnerName || '—'}</b> | الجائزة: ${money(currentRoom.revealed?.pot)}</p><div class="actions">${isHost ? '<button id="nextRound" class="primary">جولة جديدة</button>' : ''}<button id="openReport">عرض التقرير</button></div>`;
  }
}

function renderDrawer() {
  const tab = activeTab;
  const content = $('drawerContent');
  if (!currentRoom) return;
  if (tab === 'chat') {
    content.innerHTML = `<div class="chat-box"><input id="chatInput" placeholder="اكتب رسالة" /><button id="sendChat">إرسال</button></div>${currentRoom.chat.map((m) => `<p><b>${m.name}:</b> ${m.text}</p>`).join('') || '<p>لا توجد رسائل.</p>'}`;
  } else if (tab === 'events') {
    content.innerHTML = currentRoom.events.map((e) => `<p>${e.text}</p>`).join('') || '<p>لا توجد أحداث.</p>';
  } else if (tab === 'rank') {
    content.innerHTML = currentRoom.players.map((p) => `<p>${p.name} — ${money(p.balance)} نقطة</p>`).join('');
  } else if (tab === 'queue') {
    content.innerHTML = currentRoom.players.length < currentRoom.seats ? `<p>${currentRoom.seats - currentRoom.players.length} مقاعد متاحة.</p>` : '<p>المجلس مكتمل.</p>';
  } else if (tab === 'admin') {
    content.innerHTML = currentRoom.hostId === currentPlayer?.id ? '<button id="drawerAddBot" class="primary">إضافة بوت متوسط</button>' : '<p>أدوات الإدارة للمدير فقط.</p>';
  } else {
    const r = currentRoom.revealed;
    content.innerHTML = r ? `<h3>تقرير الجولة</h3><p>الفائز: ${r.winnerName}</p>${r.hands.map((h) => `<p>${h.name}: قوة ${h.score} | مساهمة ${money(h.contribution)}</p>`).join('')}` : '<p>لا يوجد تقرير بعد.</p>';
  }
}

function renderRoom() {
  renderSeats();
  renderCenter();
  renderHand();
  renderBidLadder();
  renderDecision();
  renderDrawer();
}

async function addBot(level = 'medium') {
  const res = await call('room:add-bot', { playerId: currentPlayer.id, roomCode: currentRoom.code, level });
  if (!res.ok) toast(res.error);
}

async function startRound() {
  const res = await call('round:start', { playerId: currentPlayer.id, roomCode: currentRoom.code });
  if (!res.ok) toast(res.error);
}

async function nextRound() {
  const res = await call('round:next', { playerId: currentPlayer.id, roomCode: currentRoom.code });
  if (!res.ok) toast(res.error);
}

socket.on('room:update', (room) => showGame(room));
socket.on('rooms:list', (list) => {
  $('publicRooms').innerHTML = list.length ? list.map((r) => `<button class="list-item" data-room="${r.code}"><b>${r.name}</b><span>${r.code} — ${r.players}/${r.seats}</span></button>`).join('') : 'لا توجد غرف عامة بعد.';
});
socket.on('leaderboard:list', (list) => {
  $('leaderboard').innerHTML = list.length ? list.map((p, i) => `<div class="list-item"><b>${i + 1}. ${p.name}</b><span>${money(p.netPoints)} نقطة</span></div>`).join('') : 'لا توجد نتائج بعد.';
});

document.addEventListener('click', async (e) => {
  const id = e.target.id;
  if (id === 'localLoginBtn') login('local');
  if (id === 'googleLoginBtn') login('google');
  if (id === 'logoutBtn') { localStorage.removeItem('madaqsha.player'); currentPlayer = null; location.reload(); }
  if (id === 'createRoomBtn') createRoom();
  if (id === 'joinRoomBtn') joinRoom(false);
  if (id === 'spectateBtn') joinRoom(true);
  if (e.target.dataset.room) joinRoom(false, e.target.dataset.room);
  if (id === 'menuBtn') { $('sideDrawer').hidden = false; renderDrawer(); }
  if (id === 'closeDrawerBtn') $('sideDrawer').hidden = true;
  if (id === 'addBot' || id === 'drawerAddBot') addBot('medium');
  if (id === 'startRound') startRound();
  if (id === 'nextRound') nextRound();
  if (id === 'openReport') { activeTab = 'report'; $('sideDrawer').hidden = false; renderDrawer(); }
  if (id === 'foldBtn') { const res = await call('bid:fold', { playerId: currentPlayer.id, roomCode: currentRoom.code }); if (!res.ok) toast(res.error); }
  if (id === 'bidBtn') { const res = await call('bid:place', { playerId: currentPlayer.id, roomCode: currentRoom.code, amount: selectedBid }); if (!res.ok) toast(res.error); }
  if (id === 'allInBtn') { const me = currentRoom.players.find((p) => p.id === currentPlayer.id); const res = await call('bid:place', { playerId: currentPlayer.id, roomCode: currentRoom.code, amount: me.balance + me.currentContribution }); if (!res.ok) toast(res.error); }
  if (e.target.dataset.bid) { selectedBid = Math.max(Number(e.target.dataset.bid), currentRoom.currentBid || currentRoom.minBid); renderRoom(); }
  if (e.target.dataset.tab) { activeTab = e.target.dataset.tab; document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab)); renderDrawer(); }
  if (id === 'sendChat') { const input = $('chatInput'); const res = await call('chat:send', { playerId: currentPlayer.id, roomCode: currentRoom.code, text: input.value }); if (!res.ok) toast(res.error); input.value = ''; }
});

if (currentPlayer) setLoggedIn(currentPlayer);
const invite = location.pathname.match(/\/invite\/([A-Z0-9]+)/i);
if (invite && currentPlayer) joinRoom(false, invite[1]);
