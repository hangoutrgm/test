import { auth, db } from '../../js/firebase-config.js';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, updateProfile } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { get, limitToLast, onValue, push, query, ref, remove, runTransaction, set, update } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';

const $ = (id) => document.getElementById(id);
const state = { user: null, users: {}, inbox: {}, online: {}, activeThreadId: null, activePeerId: null, stopMessages: null, stopInbox: null, signUp: false, replyTo: null, pendingImageFile: null };
const reactions = { like: '👍', love: '❤️', laugh: '😂', wow: '😮', sad: '😢' };
const fallbackAvatar = (seed = 'hangout') => `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(seed)}&backgroundColor=transparent`;

function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char])); }
function avatarUrl(user = {}) { const url = String(user.pic || user.photoURL || ''); return /^(https?:|data:image\/)/i.test(url) ? url : fallbackAvatar(user.uid || user.name || 'hangout'); }
function formatTime(timestamp) { if (!timestamp) return ''; const date = new Date(timestamp); return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function showToast(message) { const toast = $('toast'); toast.textContent = message; toast.classList.remove('hidden'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3500); }
function isOnline(uid) { return Boolean(state.online[uid]); }

function renderConversations() {
  const list = $('conversation-list');
  const term = $('conversation-search').value.trim().toLowerCase();
  const items = Object.entries(state.inbox).map(([id, item]) => ({ id, ...item })).filter((item) => {
    const person = state.users[item.peerId] || {};
    return !term || `${person.name || ''} ${item.lastMessage || ''}`.toLowerCase().includes(term);
  }).sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  if (!state.user) { list.innerHTML = ''; return; }
  if (!items.length) { list.innerHTML = '<p class="list-empty">No conversations yet. Tap the compose button to say hello.</p>'; return; }
  list.innerHTML = items.map((item) => {
    const peer = state.users[item.peerId] || { uid: item.peerId, name: 'Hangout member' };
    const unread = Number(item.unreadCount || 0);
    const preview = item.lastSenderId === state.user.uid ? `You: ${item.lastMessage || ''}` : (item.lastMessage || 'Start chatting');
    return `<button class="conversation${item.id === state.activeThreadId ? ' selected' : ''}${unread ? ' unread' : ''}" data-thread="${escapeHtml(item.id)}" data-peer="${escapeHtml(item.peerId)}"><img class="avatar" src="${escapeHtml(avatarUrl(peer))}" alt=""><span class="conversation-copy"><span class="conversation-top"><span class="conversation-name">${escapeHtml(peer.name || 'Hangout member')}</span><span class="conversation-time">${formatTime(item.lastTimestamp)}</span></span><span class="conversation-preview"><span>${escapeHtml(preview)}</span>${unread ? `<b class="unread-badge">${unread > 99 ? '99+' : unread}</b>` : ''}</span></span></button>`;
  }).join('');
  list.querySelectorAll('.conversation').forEach((button) => button.addEventListener('click', () => openThread(button.dataset.thread, button.dataset.peer)));
}

function renderPeople() {
  const list = $('people-list');
  const term = $('people-search').value.trim().toLowerCase();
  const people = Object.values(state.users).filter((person) => person.uid && person.uid !== state.user?.uid && (!term || `${person.name || ''}`.toLowerCase().includes(term))).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (!people.length) { list.innerHTML = '<p class="list-empty">No matching members found.</p>'; return; }
  list.innerHTML = people.map((person) => `<button class="person" data-user="${escapeHtml(person.uid)}"><img class="avatar" src="${escapeHtml(avatarUrl(person))}" alt=""><span class="person-copy"><span class="person-name">${escapeHtml(person.name || 'Hangout member')}</span><span class="person-status"><i class="online-dot${isOnline(person.uid) ? ' online' : ''}"></i>${person.isBanned ? 'Unavailable' : isOnline(person.uid) ? 'Online' : 'Offline'}</span></span></button>`).join('');
  list.querySelectorAll('.person').forEach((button) => button.addEventListener('click', () => startConversation(button.dataset.user)));
}

function updateChatHeader() {
  const peer = state.users[state.activePeerId] || { uid: state.activePeerId, name: 'Hangout member' };
  $('chat-avatar').src = avatarUrl(peer); $('chat-avatar').alt = peer.name || 'Member'; $('chat-name').textContent = peer.name || 'Hangout member';
  $('chat-status').innerHTML = peer.isBanned ? 'Unavailable' : `<i class="online-dot${isOnline(state.activePeerId) ? ' online' : ''}"></i>${isOnline(state.activePeerId) ? 'Online' : 'Offline'}`;
}

function replyPreview(replyTo = {}) { return replyTo.text || (replyTo.hasImage ? 'Photo' : 'Message'); }

function renderMessages(rawMessages) {
  const list = $('message-list');
  const rows = Object.entries(rawMessages || {}).map(([id, message]) => ({ id, ...message })).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (!rows.length) { list.innerHTML = '<p class="list-empty messages-empty">No messages yet. Say hello!</p>'; return; }
  list.innerHTML = rows.map((message) => {
    const mine = message.senderId === state.user?.uid;
    const reactionSummary = Object.entries(message.reactions || {}).map(([type, people]) => Object.keys(people || {}).length ? `<span class="reaction-chip">${reactions[type] || ''} ${Object.keys(people).length}</span>` : '').join('');
    const reactionButtons = Object.entries(reactions).map(([type, emoji]) => `<button type="button" data-action="react" data-id="${escapeHtml(message.id)}" data-reaction="${type}" title="React ${type}">${emoji}</button>`).join('');
    const quote = message.replyTo ? `<div class="reply-quote">Reply to ${escapeHtml(state.users[message.replyTo.senderId]?.name || 'member')}: ${escapeHtml(replyPreview(message.replyTo))}</div>` : '';
    const image = message.image ? `<img class="message-image" src="${escapeHtml(message.image)}" alt="Shared photo">` : '';
    return `<div class="message-row${mine ? ' me' : ''}"><div><div class="message-bubble">${quote}${escapeHtml(message.text || '')}${image}</div><div class="message-meta"><div class="message-time">${formatTime(message.timestamp)}</div>${message.editedAt ? '<span class="edited-label">Edited</span>' : ''}</div><div class="reaction-summary">${reactionSummary}</div><div class="message-actions">${reactionButtons}<button type="button" data-action="reply" data-id="${escapeHtml(message.id)}">Reply</button>${mine ? `<button type="button" data-action="edit" data-id="${escapeHtml(message.id)}">Edit</button>` : ''}</div></div></div>`;
  }).join('');
  list.querySelectorAll('[data-action="react"]').forEach((button) => button.addEventListener('click', () => toggleReaction(button.dataset.id, button.dataset.reaction)));
  list.querySelectorAll('[data-action="reply"]').forEach((button) => button.addEventListener('click', () => setReply(rows.find((message) => message.id === button.dataset.id))));
  list.querySelectorAll('[data-action="edit"]').forEach((button) => button.addEventListener('click', () => editMessage(rows.find((message) => message.id === button.dataset.id))));
  list.scrollTop = list.scrollHeight;
}

async function markThreadRead(threadId = state.activeThreadId) {
  if (!state.user || !threadId || !state.inbox[threadId]?.unreadCount) return;
  try { await update(ref(db, `chatInboxes/${state.user.uid}/${threadId}`), { unreadCount: 0 }); } catch { /* Inbox stays readable even if a transient connection fails. */ }
}

function openThread(threadId, peerId) {
  if (!state.user) return showAuth();
  state.activeThreadId = threadId; state.activePeerId = peerId; $('empty-state').classList.add('hidden'); $('active-chat').classList.remove('hidden'); updateChatHeader(); renderConversations(); markThreadRead(threadId);
  if (state.stopMessages) state.stopMessages();
  state.stopMessages = onValue(query(ref(db, `chatMessages/${threadId}`), limitToLast(100)), (snapshot) => renderMessages(snapshot.val()));
  $('message-input').focus();
}

async function startConversation(peerId) {
  if (!state.user) return showAuth(); const peer = state.users[peerId]; if (!peer || peer.isBanned) return showToast('This member is unavailable.');
  const threadId = `dm_${[state.user.uid, peerId].sort().join('_')}`;
  try {
    const threadRef = ref(db, `chatThreads/${threadId}`); const snapshot = await get(threadRef); const now = Date.now();
    if (!snapshot.exists()) await set(threadRef, { members: { [state.user.uid]: true, [peerId]: true }, createdAt: now, lastMessage: 'Start a conversation', lastTimestamp: now, lastSenderId: state.user.uid });
    const thread = snapshot.val() || {}; const summary = { peerId, lastMessage: thread.lastMessage || 'Start a conversation', lastTimestamp: thread.lastTimestamp || now, lastSenderId: thread.lastSenderId || state.user.uid, unreadCount: 0 }; const peerSummary = { ...summary, peerId: state.user.uid };
    await update(ref(db), { [`chatInboxes/${state.user.uid}/${threadId}`]: summary, [`chatInboxes/${peerId}/${threadId}`]: peerSummary });
    $('people-dialog').close(); openThread(threadId, peerId);
  } catch (error) { console.error('Could not start conversation:', error); showToast(`Could not start chat: ${error.message.replace('Firebase: ', '')}`); }
}

function compressImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return Promise.reject(new Error('Choose a JPG, PNG, or WebP image.'));
  if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error('Choose an image smaller than 10 MB.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read that image.')); reader.onload = () => {
      const image = new Image(); image.onerror = () => reject(new Error('Could not process that image.')); image.onload = () => {
        const maxSide = 720; const scale = Math.min(1, maxSide / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); const output = canvas.toDataURL('image/jpeg', 0.55);
        if (output.length > 850000) reject(new Error('That image is still too large after compression. Try a smaller one.')); else resolve(output);
      }; image.src = reader.result;
    }; reader.readAsDataURL(file);
  });
}

async function useUploadQuota() {
  const day = new Date().toISOString().slice(0, 10); const result = await runTransaction(ref(db, `chatUploadQuota/${state.user.uid}/${day}`), (count) => (Number(count || 0) >= 3 ? undefined : Number(count || 0) + 1));
  if (!result.committed) throw new Error('Daily photo limit reached (3 uploads). Try again tomorrow.');
}

async function sendMessage(event) {
  event.preventDefault(); if (!state.user || !state.activeThreadId || !state.activePeerId) return;
  const input = $('message-input'); const text = input.value.trim(); const file = state.pendingImageFile; if (!text && !file) return;
  const button = $('send-button'); button.disabled = true;
  try {
    const image = file ? await compressImage(file) : null; if (image) await useUploadQuota();
    const timestamp = Date.now(); const payload = { senderId: state.user.uid, text, timestamp };
    if (image) payload.image = image;
    if (state.replyTo) payload.replyTo = { id: state.replyTo.id, senderId: state.replyTo.senderId, text: (state.replyTo.text || '').slice(0, 120), hasImage: Boolean(state.replyTo.image) };
    await push(ref(db, `chatMessages/${state.activeThreadId}`), payload);
    const preview = text || '📷 Photo';
    await update(ref(db), {
      [`chatThreads/${state.activeThreadId}/lastMessage`]: preview, [`chatThreads/${state.activeThreadId}/lastTimestamp`]: timestamp, [`chatThreads/${state.activeThreadId}/lastSenderId`]: state.user.uid,
      [`chatInboxes/${state.user.uid}/${state.activeThreadId}/lastMessage`]: preview, [`chatInboxes/${state.user.uid}/${state.activeThreadId}/lastTimestamp`]: timestamp, [`chatInboxes/${state.user.uid}/${state.activeThreadId}/lastSenderId`]: state.user.uid, [`chatInboxes/${state.user.uid}/${state.activeThreadId}/unreadCount`]: 0,
      [`chatInboxes/${state.activePeerId}/${state.activeThreadId}/lastMessage`]: preview, [`chatInboxes/${state.activePeerId}/${state.activeThreadId}/lastTimestamp`]: timestamp, [`chatInboxes/${state.activePeerId}/${state.activeThreadId}/lastSenderId`]: state.user.uid
    });
    await runTransaction(ref(db, `chatInboxes/${state.activePeerId}/${state.activeThreadId}/unreadCount`), (count) => Math.min(Number(count || 0) + 1, 99));
    input.value = ''; input.style.height = ''; $('image-input').value = ''; state.pendingImageFile = null; clearReply();
  } catch (error) { showToast(`Could not send: ${error.message.replace('Firebase: ', '')}`); }
  button.disabled = false;
}

async function toggleReaction(messageId, reaction) {
  if (!state.user || !state.activeThreadId) return; const path = `chatMessages/${state.activeThreadId}/${messageId}/reactions/${reaction}/${state.user.uid}`;
  try { const snap = await get(ref(db, path)); if (snap.exists()) await remove(ref(db, path)); else await set(ref(db, path), true); } catch (error) { showToast(`Could not react: ${error.message.replace('Firebase: ', '')}`); }
}

function setReply(message) {
  if (!message) return; state.replyTo = message; $('reply-banner-text').textContent = `Replying to ${state.users[message.senderId]?.name || 'member'}: ${replyPreview(message)}`; $('reply-banner').classList.remove('hidden'); $('message-input').focus();
}
function clearReply() { state.replyTo = null; $('reply-banner').classList.add('hidden'); }
async function editMessage(message) {
  if (!message || message.senderId !== state.user?.uid) return; const text = window.prompt('Edit your message:', message.text || ''); if (text === null) return; const nextText = text.trim(); if (!nextText && !message.image) return showToast('A message cannot be empty.');
  try { await update(ref(db), { [`chatMessages/${state.activeThreadId}/${message.id}/text`]: nextText, [`chatMessages/${state.activeThreadId}/${message.id}/editedAt`]: Date.now() }); } catch (error) { showToast(`Could not edit: ${error.message.replace('Firebase: ', '')}`); }
}

function showAuth() { $('auth-dialog').showModal(); }
function syncAuthUi() { $('signed-out-card').classList.toggle('hidden', Boolean(state.user)); renderConversations(); }

onValue(ref(db, 'users'), (snapshot) => { const raw = snapshot.val() || {}; state.users = Object.fromEntries(Object.entries(raw).map(([uid, profile]) => [uid, { ...(profile || {}), uid }])); renderConversations(); renderPeople(); if (state.activePeerId) updateChatHeader(); });
onValue(ref(db, 'presence'), (snapshot) => { state.online = snapshot.val() || {}; renderPeople(); if (state.activePeerId) updateChatHeader(); });
onAuthStateChanged(auth, async (user) => {
  state.user = user; if (state.stopInbox) state.stopInbox(); state.inbox = {};
  if (user) state.stopInbox = onValue(ref(db, `chatInboxes/${user.uid}`), (snapshot) => { state.inbox = snapshot.val() || {}; renderConversations(); markThreadRead(); });
  else if (state.stopMessages) { state.stopMessages(); state.stopMessages = null; }
  syncAuthUi();
});

$('new-chat-button').addEventListener('click', () => state.user ? $('people-dialog').showModal() : showAuth()); $('empty-new-chat-button').addEventListener('click', () => state.user ? $('people-dialog').showModal() : showAuth()); $('show-auth-button').addEventListener('click', showAuth);
$('conversation-search').addEventListener('input', renderConversations); $('people-search').addEventListener('input', renderPeople); $('message-form').addEventListener('submit', sendMessage);
$('message-input').addEventListener('input', (event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`; });
$('message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('message-form').requestSubmit(); } });
$('image-input').addEventListener('change', (event) => { const file = event.target.files[0]; state.pendingImageFile = file || null; if (file) showToast(`Photo ready: ${file.name}. Limit: 3 uploads daily.`); });
$('cancel-reply-button').addEventListener('click', clearReply); $('mobile-back-button').addEventListener('click', () => { $('active-chat').classList.add('hidden'); $('empty-state').classList.remove('hidden'); });
$('close-auth-button').addEventListener('click', () => $('auth-dialog').close());
$('auth-toggle').addEventListener('click', () => { state.signUp = !state.signUp; $('auth-title').textContent = state.signUp ? 'Create account' : 'Sign in'; $('auth-submit').textContent = state.signUp ? 'Create account' : 'Sign in'; $('auth-toggle').textContent = state.signUp ? 'Already have an account? Sign in' : 'Need an account? Create one'; $('auth-password').autocomplete = state.signUp ? 'new-password' : 'current-password'; });
$('auth-form').addEventListener('submit', async (event) => { event.preventDefault(); const email = $('auth-email').value.trim(); const password = $('auth-password').value; const error = $('auth-error'); error.classList.add('hidden'); try { const result = state.signUp ? await createUserWithEmailAndPassword(auth, email, password) : await signInWithEmailAndPassword(auth, email, password); if (state.signUp) { const name = `User_${Math.floor(Math.random() * 999)}`; const pic = fallbackAvatar(result.user.uid); await updateProfile(result.user, { displayName: name, photoURL: pic }); await update(ref(db, `users/${result.user.uid}`), { uid: result.user.uid, name, pic }); } $('auth-dialog').close(); } catch (err) { error.textContent = err.message.replace('Firebase: ', ''); error.classList.remove('hidden'); } });
