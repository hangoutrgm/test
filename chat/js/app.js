import { auth, db } from '../../js/firebase-config.js';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, updateProfile } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { get, onValue, push, query, ref, set, update, limitToLast } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';

const $ = (id) => document.getElementById(id);
const state = { user: null, users: {}, inbox: {}, activeThreadId: null, activePeerId: null, stopMessages: null, signUp: false };
const fallbackAvatar = (seed = 'hangout') => `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(seed)}&backgroundColor=transparent`;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));
}

function avatarUrl(user = {}) {
  const url = String(user.pic || user.photoURL || '');
  return /^(https?:|data:image\/)/i.test(url) ? url : fallbackAvatar(user.uid || user.name || 'hangout');
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

function renderConversations() {
  const list = $('conversation-list');
  const term = $('conversation-search').value.trim().toLowerCase();
  const items = Object.entries(state.inbox)
    .map(([id, item]) => ({ id, ...item }))
    .filter((item) => {
      const person = state.users[item.peerId] || {};
      return !term || `${person.name || ''} ${item.lastMessage || ''}`.toLowerCase().includes(term);
    })
    .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));

  if (!state.user) { list.innerHTML = ''; return; }
  if (!items.length) {
    list.innerHTML = '<p class="list-empty">No conversations yet. Tap the compose button to say hello.</p>';
    return;
  }
  list.innerHTML = items.map((item) => {
    const peer = state.users[item.peerId] || { uid: item.peerId, name: 'Hangout member' };
    const active = item.id === state.activeThreadId ? ' selected' : '';
    const preview = item.lastSenderId === state.user.uid ? `You: ${item.lastMessage || ''}` : (item.lastMessage || 'Start chatting');
    return `<button class="conversation${active}" data-thread="${escapeHtml(item.id)}" data-peer="${escapeHtml(item.peerId)}">
      <img class="avatar" src="${escapeHtml(avatarUrl(peer))}" alt="">
      <span class="conversation-copy"><span class="conversation-top"><span class="conversation-name">${escapeHtml(peer.name || 'Hangout member')}</span><span class="conversation-time">${formatTime(item.lastTimestamp)}</span></span><span class="conversation-preview"><span>${escapeHtml(preview)}</span></span></span>
    </button>`;
  }).join('');
  list.querySelectorAll('.conversation').forEach((button) => button.addEventListener('click', () => openThread(button.dataset.thread, button.dataset.peer)));
}

function renderPeople() {
  const list = $('people-list');
  const term = $('people-search').value.trim().toLowerCase();
  const people = Object.values(state.users)
    .filter((person) => person.uid && person.uid !== state.user?.uid && (!term || `${person.name || ''}`.toLowerCase().includes(term)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (!people.length) { list.innerHTML = '<p class="list-empty">No matching members found.</p>'; return; }
  list.innerHTML = people.map((person) => `<button class="person" data-user="${escapeHtml(person.uid)}"><img class="avatar" src="${escapeHtml(avatarUrl(person))}" alt=""><span class="person-copy"><span class="person-name">${escapeHtml(person.name || 'Hangout member')}</span><span class="person-status">${person.isBanned ? 'Unavailable' : 'Message member'}</span></span></button>`).join('');
  list.querySelectorAll('.person').forEach((button) => button.addEventListener('click', () => startConversation(button.dataset.user)));
}

function updateChatHeader() {
  const peer = state.users[state.activePeerId] || { uid: state.activePeerId, name: 'Hangout member' };
  $('chat-avatar').src = avatarUrl(peer);
  $('chat-avatar').alt = peer.name || 'Member';
  $('chat-name').textContent = peer.name || 'Hangout member';
  $('chat-status').textContent = peer.isBanned ? 'Unavailable' : 'Hangout member';
}

function renderMessages(messages) {
  const list = $('message-list');
  const rows = Object.values(messages || {}).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (!rows.length) { list.innerHTML = '<p class="list-empty messages-empty">No messages yet. Say hello!</p>'; return; }
  list.innerHTML = rows.map((message) => {
    const mine = message.senderId === state.user?.uid;
    return `<div class="message-row${mine ? ' me' : ''}"><div><div class="message-bubble">${escapeHtml(message.text || '')}</div><div class="message-time">${formatTime(message.timestamp)}</div></div></div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

function openThread(threadId, peerId) {
  if (!state.user) return showAuth();
  state.activeThreadId = threadId;
  state.activePeerId = peerId;
  $('empty-state').classList.add('hidden');
  $('active-chat').classList.remove('hidden');
  updateChatHeader();
  renderConversations();
  if (state.stopMessages) state.stopMessages();
  state.stopMessages = onValue(query(ref(db, `chatMessages/${threadId}`), limitToLast(100)), (snapshot) => renderMessages(snapshot.val()));
  $('message-input').focus();
}

async function startConversation(peerId) {
  if (!state.user) return showAuth();
  const peer = state.users[peerId];
  if (!peer || peer.isBanned) return showToast('This member is unavailable.');
  const threadId = `dm_${[state.user.uid, peerId].sort().join('_')}`;
  const threadRef = ref(db, `chatThreads/${threadId}`);
  const snapshot = await get(threadRef);
  const now = Date.now();
  if (!snapshot.exists()) {
    await set(threadRef, { members: { [state.user.uid]: true, [peerId]: true }, createdAt: now, lastMessage: 'Start a conversation', lastTimestamp: now, lastSenderId: state.user.uid });
  }
  const summary = { peerId, lastMessage: snapshot.exists() ? snapshot.val().lastMessage || 'Start a conversation' : 'Start a conversation', lastTimestamp: snapshot.exists() ? snapshot.val().lastTimestamp || now : now, lastSenderId: snapshot.exists() ? snapshot.val().lastSenderId || state.user.uid : state.user.uid };
  const peerSummary = { ...summary, peerId: state.user.uid };
  await update(ref(db), { [`chatInboxes/${state.user.uid}/${threadId}`]: summary, [`chatInboxes/${peerId}/${threadId}`]: peerSummary });
  $('people-dialog').close();
  openThread(threadId, peerId);
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.user || !state.activeThreadId || !state.activePeerId) return;
  const input = $('message-input');
  const text = input.value.trim();
  if (!text) return;
  const button = $('send-button');
  button.disabled = true;
  const timestamp = Date.now();
  try {
    await push(ref(db, `chatMessages/${state.activeThreadId}`), { senderId: state.user.uid, text, timestamp });
    await update(ref(db), {
      [`chatThreads/${state.activeThreadId}/lastMessage`]: text,
      [`chatThreads/${state.activeThreadId}/lastTimestamp`]: timestamp,
      [`chatThreads/${state.activeThreadId}/lastSenderId`]: state.user.uid,
      [`chatInboxes/${state.user.uid}/${state.activeThreadId}/lastMessage`]: text,
      [`chatInboxes/${state.user.uid}/${state.activeThreadId}/lastTimestamp`]: timestamp,
      [`chatInboxes/${state.user.uid}/${state.activeThreadId}/lastSenderId`]: state.user.uid,
      [`chatInboxes/${state.activePeerId}/${state.activeThreadId}/lastMessage`]: text,
      [`chatInboxes/${state.activePeerId}/${state.activeThreadId}/lastTimestamp`]: timestamp,
      [`chatInboxes/${state.activePeerId}/${state.activeThreadId}/lastSenderId`]: state.user.uid
    });
    input.value = '';
    input.style.height = '';
  } catch (error) { showToast(`Could not send: ${error.message.replace('Firebase: ', '')}`); }
  button.disabled = false;
}

function showAuth() { $('auth-dialog').showModal(); }
function syncAuthUi() { $('signed-out-card').classList.toggle('hidden', Boolean(state.user)); renderConversations(); }

onValue(ref(db, 'users'), (snapshot) => {
  const rawUsers = snapshot.val() || {};
  state.users = Object.fromEntries(Object.entries(rawUsers).map(([uid, profile]) => [uid, { ...(profile || {}), uid }]));
  renderConversations();
  renderPeople();
  if (state.activePeerId) updateChatHeader();
});

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  if (state.stopInbox) state.stopInbox();
  state.inbox = {};
  if (user) {
    const existing = state.users[user.uid] || {};
    if (!existing.name) await update(ref(db, `users/${user.uid}`), { uid: user.uid, name: user.displayName || `User_${Math.floor(Math.random() * 999)}`, pic: user.photoURL || fallbackAvatar(user.uid) });
    state.stopInbox = onValue(ref(db, `chatInboxes/${user.uid}`), (snapshot) => { state.inbox = snapshot.val() || {}; renderConversations(); });
  } else if (state.stopMessages) { state.stopMessages(); state.stopMessages = null; }
  syncAuthUi();
});

$('new-chat-button').addEventListener('click', () => state.user ? $('people-dialog').showModal() : showAuth());
$('empty-new-chat-button').addEventListener('click', () => state.user ? $('people-dialog').showModal() : showAuth());
$('show-auth-button').addEventListener('click', showAuth);
$('conversation-search').addEventListener('input', renderConversations);
$('people-search').addEventListener('input', renderPeople);
$('message-form').addEventListener('submit', sendMessage);
$('message-input').addEventListener('input', (event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`; });
$('message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('message-form').requestSubmit(); } });
$('mobile-back-button').addEventListener('click', () => { $('active-chat').classList.add('hidden'); $('empty-state').classList.remove('hidden'); });
$('close-auth-button').addEventListener('click', () => $('auth-dialog').close());
$('auth-toggle').addEventListener('click', () => { state.signUp = !state.signUp; $('auth-title').textContent = state.signUp ? 'Create account' : 'Sign in'; $('auth-submit').textContent = state.signUp ? 'Create account' : 'Sign in'; $('auth-toggle').textContent = state.signUp ? 'Already have an account? Sign in' : 'Need an account? Create one'; $('auth-password').autocomplete = state.signUp ? 'new-password' : 'current-password'; });
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('auth-email').value.trim(); const password = $('auth-password').value; const error = $('auth-error');
  error.classList.add('hidden');
  try {
    const result = state.signUp ? await createUserWithEmailAndPassword(auth, email, password) : await signInWithEmailAndPassword(auth, email, password);
    if (state.signUp) await updateProfile(result.user, { displayName: `User_${Math.floor(Math.random() * 999)}`, photoURL: fallbackAvatar(result.user.uid) });
    $('auth-dialog').close();
  } catch (err) { error.textContent = err.message.replace('Firebase: ', ''); error.classList.remove('hidden'); }
});
