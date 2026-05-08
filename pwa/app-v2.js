/**
 * Kymacache PWA — app.js
 * Vanilla JS, ES modules, no build step required
 */

// ── Config ────────────────────────────────────────────────────────────────────
// FIX (security): credentials are no longer hardcoded in source.
//
// At deploy time, Cloudflare Pages (or your static host) injects a small
// <script> block into index.html BEFORE this file loads, e.g.:
//
//   <script>
//     window.KYMACACHE_CONFIG = {
//       apiBase:      "https://kymacache-worker.yourname.workers.dev",
//       supabaseUrl:  "https://yourproject.supabase.co",
//       supabaseKey:  "your-anon-key",   // anon key only — RLS guards the data
//     };
//   </script>
//
// For Cloudflare Pages: set these as environment variables and use a
// _worker.js or Pages Functions transform to inject them at build time.
// For local dev: add a <script> block to index.html with localhost values
// (the file is in .gitignore so it never reaches the repo).
//
// The anon key IS safe to ship to browsers as long as RLS policies are
// correctly configured — it cannot bypass Row Level Security.
// What must NEVER be in client code: the service_role key.

const _cfg        = window.KYMACACHE_CONFIG ?? {};
const API_BASE    = _cfg.apiBase    ?? (
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:8787'
    : null   // detected at runtime — show config error if null
);
const SUPABASE_URL = _cfg.supabaseUrl ?? null;
const SUPABASE_KEY = _cfg.supabaseKey ?? null;

let supabase = null;

// ── State ─────────────────────────────────────────────────────────────────────
let user = null;
let currentTab = 'text';
let currentFilter = { status: 'active', type: null, label: null, collection: null };
let currentView = 'list';   // 'list' | 'grid'
let feedOffset = 0;
let isFeedLoading = false;
let searchDebounceId = null;
let allLabels = new Set();
let collections = [];
let selectedEntries = new Set();
let isSelectionMode = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[init] App loading...');

  // Guard: show helpful config error if credentials not injected yet
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    document.getElementById('app').innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;padding:24px;background:var(--bg);">
        <div style="max-width:500px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:40px;text-align:center;">
          <div style="font-size:40px;margin-bottom:16px;">⚙️</div>
          <h2 style="margin-bottom:12px;color:var(--text);">Config Required</h2>
          <p style="color:var(--muted);margin-bottom:24px;line-height:1.6;">Add your credentials to <code style="background:var(--bg);padding:2px 6px;border-radius:4px;">index.html</code> before the app script tag:</p>
          <pre style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:left;font-size:12px;overflow-x:auto;color:var(--text);">&lt;script&gt;
window.KYMACACHE_CONFIG = {
  apiBase:     "https://your-worker.workers.dev",
  supabaseUrl: "https://xxx.supabase.co",
  supabaseKey: "your-anon-key"
};
&lt;/script&gt;</pre>
          <p style="color:var(--muted);font-size:13px;margin-top:16px;">See <strong>DEPLOY.md</strong> for full setup instructions.</p>
        </div>
      </div>`;
    return;
  }

  // Wait up to 5s for Supabase CDN script
  let retries = 0;
  while (!window.supabase && retries < 50) {
    await new Promise(r => setTimeout(r, 100));
    retries++;
  }

  if (window.supabase) {
    console.log('[init] Supabase script found.');
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  } else {
    console.error('[init] Supabase script NOT found after 5s.');
    // Show inline error — don't alert() which blocks the thread
    const overlay = document.getElementById('auth-overlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      const card = overlay.querySelector('.auth-card');
      if (card) card.insertAdjacentHTML('beforeend', '<p style="color:#e74c3c;margin-top:16px;font-size:13px;">⚠️ Supabase library failed to load. Check your internet or disable ad-blocker.</p>');
    }
  }

  // Always bind UI — even if supabase failed, the DOM listeners must attach
  initAuth();
  bindSidebar();
  bindSearch();
  bindCapture();
  bindViewToggle();
  bindLoadMore();
  bindBulkActions();
  bindCollections();
  registerServiceWorker();

  // Initial feed load and collections load happen after auth check inside initAuth → updateUser
  // Do NOT call loadCollections() or loadFeed() here — they require a valid session token.
});

// ── Auth ──────────────────────────────────────────────────────────────────────
async function initAuth() {
  // Always bind the auth form — even if supabase failed to load
  const authForm = document.getElementById('auth-form');
  if (authForm) authForm.addEventListener('submit', handleAuthSubmit);

  const toggleLink = document.getElementById('auth-toggle-link');
  if (toggleLink) toggleLink.addEventListener('click', e => {
    e.preventDefault();
    const title = document.getElementById('auth-title');
    const submit = document.getElementById('auth-submit');
    if (submit.textContent === 'Sign In') {
      title.textContent = 'Create account';
      submit.textContent = 'Sign Up';
      toggleLink.textContent = 'Sign In';
    } else {
      title.textContent = 'Welcome back';
      submit.textContent = 'Sign In';
      toggleLink.textContent = 'Sign Up';
    }
  });

  const googleBtn = document.getElementById('google-auth-btn');
  if (googleBtn) googleBtn.addEventListener('click', () => {
    if (!supabase) { toast('Supabase not loaded — check config', 'error'); return; }
    console.log('[auth] Google clicked');
    supabase.auth.signInWithOAuth({ provider: 'google' });
  });

  const profileBtn = document.getElementById('user-profile');
  if (profileBtn) profileBtn.addEventListener('click', async () => {
    if (confirm('Sign out?') && supabase) await supabase.auth.signOut();
  });

  if (!supabase) {
    // No supabase — show the auth overlay so user sees the form (with the CDN error above it)
    updateUser(null);
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  console.log('[auth] Initial session:', session ? 'Found' : 'Not found');
  updateUser(session?.user);

  supabase.auth.onAuthStateChange((event, session) => {
    console.log('[auth] State change:', event, session ? 'Session active' : 'No session');
    updateUser(session?.user);
  });
}

function updateUser(newUser) {
  user = newUser;
  
  // Handle public sharing links: /entries/:id — works for both authenticated and anonymous users
  const path = window.location.pathname;
  const entryIdMatch = path.match(/\/entries\/([a-f0-9-]{36})/);

  if (entryIdMatch && !user) {
    $('auth-overlay').classList.add('hidden');
    loadPublicEntry(entryIdMatch[1]);
    return;
  }

  if (entryIdMatch && user) {
    // Authenticated user opened a share link — show that entry in context
    $('auth-overlay').classList.add('hidden');
    $('app').classList.remove('blurred');
    $('user-avatar').textContent = user.email[0].toUpperCase();
    loadPublicEntry(entryIdMatch[1]);
    loadCollections();
    return;
  }

  if (!user) {
    $('auth-overlay').classList.remove('hidden');
    // $('app').classList.add('blurred'); // Disabled for visibility
  } else {
    $('auth-overlay').classList.add('hidden');
    $('app').classList.remove('blurred');
    $('user-avatar').textContent = user.email[0].toUpperCase();
    loadFeed(true);
    loadCollections();
  }
}

async function loadPublicEntry(id) {
  try {
    const entry = await apiFetch(`/entries/${id}`);
    $('entries-list').innerHTML = '';
    appendEntryCard(entry);
    $('feed-title').textContent = 'Public Entry';
    $('sidebar').classList.add('hidden');
    $('main-header').classList.add('hidden');
  } catch (err) {
    toast('Public entry not found or access denied', 'error');
    $('auth-overlay').classList.remove('hidden');
  }
}

function bindBulkActions() {
  const bulkBtn = $('bulk-select-btn');
  if (bulkBtn) bulkBtn.onclick = toggleSelectionMode;
  
  const cancelBtn = $('cancel-selection');
  if (cancelBtn) cancelBtn.onclick = toggleSelectionMode;
  
  const deleteBtn = $('bulk-delete-btn');
  if (deleteBtn) deleteBtn.onclick = handleBulkDelete;
  
  const pinBtn = $('bulk-pin-btn');
  if (pinBtn) pinBtn.onclick = handleBulkPin;
  
  const moveBtn = $('bulk-move-btn');
  if (moveBtn) moveBtn.onclick = handleBulkMove;
}

function toggleSelectionMode() {
  isSelectionMode = !isSelectionMode;
  selectedEntries.clear();
  $('selection-bar').classList.toggle('hidden', !isSelectionMode);
  $('bulk-select-btn').classList.toggle('active', isSelectionMode);
  updateSelectionUI();
  $$('.entry-card').forEach(card => card.classList.remove('selected'));
}

function updateSelectionUI() {
  $('selection-count').textContent = `${selectedEntries.size} selected`;
}

async function handleBulkDelete() {
  if (selectedEntries.size === 0) return;
  if (!confirm(`Delete ${selectedEntries.size} entries?`)) return;
  try {
    await apiPost('/entries/bulk', { action: 'delete', ids: Array.from(selectedEntries) });
    toast('Entries deleted', 'success');
    toggleSelectionMode();
    loadFeed(true);
  } catch (err) { toast(err.message, 'error'); }
}

async function handleBulkPin() {
  if (selectedEntries.size === 0) return;
  try {
    // FIX: Use action:'pin' which is now handled by the backend entries.js bulk route.
    // Previously this sent action:'update' which the backend didn't recognise → silent fail.
    await apiPost('/entries/bulk', { action: 'pin', ids: Array.from(selectedEntries), data: { is_pinned: true } });
    toast('Entries pinned', 'success');
    toggleSelectionMode();
    loadFeed(true);
  } catch (err) { toast(err.message, 'error'); }
}

async function handleBulkMove() {
  if (selectedEntries.size === 0) return;
  // FIX: Replace prompt() with proper collection picker modal.
  showCollectionPicker(async (colId) => {
    try {
      await apiPost('/entries/bulk', { action: 'move', ids: Array.from(selectedEntries), data: { collection_id: colId } });
      toast('Entries moved', 'success');
      toggleSelectionMode();
      loadFeed(true);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// FIX: Proper collection picker modal — replaces the old prompt() placeholder.
function showCollectionPicker(onSelect) {
  // Remove any existing modal
  document.getElementById('collection-picker-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'collection-picker-modal';
  modal.className = 'capture-overlay';
  modal.style.cssText = 'display:flex; z-index:1000;';

  const hasCollections = collections.length > 0;

  modal.innerHTML = `
    <div class="capture-panel" style="max-width:400px; width:100%;">
      <div class="capture-header">
        <h3>Move to Collection</h3>
        <button class="close-btn" id="picker-close">&times;</button>
      </div>
      <div class="tab-content active" style="padding:16px;">
        ${hasCollections ? `
          <p style="font-size:13px; color:var(--muted); margin-bottom:12px;">Choose a collection:</p>
          <div id="picker-list" style="display:flex; flex-direction:column; gap:8px; max-height:300px; overflow-y:auto;">
            ${collections.map(col => `
              <button class="nav-item picker-col-btn" data-col-id="${escHtml(col.id)}" style="justify-content:flex-start; padding:12px; border-radius:8px; border:1px solid var(--border); background:var(--surface); width:100%; text-align:left;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                <span>${escHtml(col.name)}</span>
              </button>
            `).join('')}
          </div>
        ` : `<p style="color:var(--muted); text-align:center; padding:24px 0;">No collections yet. Create one from the sidebar first.</p>`}
      </div>
      ${hasCollections ? `<div class="capture-footer" style="padding:12px 16px;"><span style="font-size:12px; color:var(--muted);">${selectedEntries.size} entr${selectedEntries.size === 1 ? 'y' : 'ies'} selected</span></div>` : ''}
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#picker-close').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  modal.querySelectorAll('.picker-col-btn').forEach(btn => {
    btn.onclick = () => {
      const colId = btn.dataset.colId;
      modal.remove();
      onSelect(colId);
    };
  });
}

async function loadCollections() {
  if (!user) return;
  try {
    collections = await apiFetch('/collections');
    renderCollectionsNav();
  } catch (err) { console.warn('Failed to load collections', err); }
}

function renderCollectionsNav() {
  const list = $('collections-nav-list');
  list.innerHTML = '';
  collections.forEach(col => {
    const btn = document.createElement('button');
    btn.className = `nav-item${currentFilter.collection === col.id ? ' active' : ''}`;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>${escHtml(col.name)}</span>`;
    btn.onclick = () => {
      currentFilter = { status: 'active', type: null, label: null, collection: col.id };
      $('feed-title').textContent = col.name;
      loadFeed(true);
    };
    list.appendChild(btn);
  });
}

function bindCollections() {
  $('new-collection-btn').onclick = async () => {
    const name = prompt('Collection name:');
    if (!name) return;
    try {
      await apiPost('/collections', { name });
      loadCollections();
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = $('auth-email').value;
  const password = $('auth-password').value;
  const isSignUp = $('auth-submit').textContent === 'Sign Up';

  console.log('[auth] Submitting...', { email, isSignUp });

  if (!supabase) {
    toast('Supabase not initialized. Check your URL/Key.', 'error');
    return;
  }

  try {
    const { error, data } = isSignUp
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });

    if (error) throw error;
    console.log('[auth] Success:', data);
    if (isSignUp) toast('Check your email for confirmation!', 'success');
  } catch (err) {
    console.error('[auth] Error:', err);
    toast(err.message, 'error');
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function bindSidebar() {
  $$('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      $$('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      const filter = item.dataset.filter;
      const type = item.dataset.type;

      if (filter === 'active' || filter === 'starred') {
        currentFilter = { status: filter, type: null, label: null, collection: null };
        $('feed-title').textContent = filter === 'starred' ? 'Starred' : 'All Entries';
      } else if (item.id === 'trash-nav-item') {
        currentFilter = { status: 'trashed', type: null, label: null, collection: null };
        $('feed-title').textContent = 'Trash';
      } else if (type) {
        currentFilter = { status: 'active', type, label: null, collection: null };
        $('feed-title').textContent = type.charAt(0).toUpperCase() + type.slice(1) + 's';
      }

      loadFeed(true);
      $('feed-view').classList.remove('hidden');
      $('family-admin-view').classList.add('hidden');
      if (window.innerWidth <= 768) $('sidebar').classList.remove('open');
    });
  });

  $('family-admin-btn').addEventListener('click', () => {
    $$('.nav-item').forEach(i => i.classList.remove('active'));
    $('family-admin-btn').classList.add('active');
    $('feed-view').classList.add('hidden');
    $('family-admin-view').classList.remove('hidden');
    loadFamilyMembers();
  });

  $('compose-btn').addEventListener('click', () => {
    $('capture-overlay').classList.remove('hidden');
  });

  $('invite-member-btn').addEventListener('click', () => $('invite-overlay').classList.remove('hidden'));
  $('invite-close').addEventListener('click', () => $('invite-overlay').classList.add('hidden'));
  $('send-invite-btn').addEventListener('click', handleSendInvite);
}

async function loadFamilyMembers() {
  const list = $('member-list');
  list.innerHTML = '<div class="loading-state">Loading members…</div>';
  try {
    const members = await apiFetch('/family/members');
    list.innerHTML = '';
    members.forEach(member => {
      const el = document.createElement('div');
      el.className = 'member-item';
      el.style = 'display:flex; align-items:center; justify-content:space-between; padding:12px; border-bottom:1px solid var(--border);';
      el.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="avatar">${(member.display_name || member.email)[0].toUpperCase()}</div>
          <div>
            <div style="font-weight:600">${escHtml(member.display_name || 'Pending Member')}</div>
            <div style="font-size:12px; color:var(--muted)">${escHtml(member.email)} • ${member.role}</div>
          </div>
        </div>
        ${member.role !== 'owner' ? `<button class="delete-btn" onclick="removeMember('${member.id}')">Remove</button>` : ''}
      `;
      list.appendChild(el);
    });
  } catch (err) {
    list.innerHTML = '<div class="empty-state">Error loading members.</div>';
  }
}

async function removeMember(memberId) {
  if (!confirm('Are you sure you want to remove this member?')) return;
  try {
    await apiFetch(`/family/members/${memberId}`, { method: 'DELETE' });
    toast('Member removed', 'success');
    loadFamilyMembers();
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.removeMember = removeMember;

async function handleSendInvite() {
  const email = $('invite-email').value.trim();
  const role = $('invite-role').value;
  if (!email) return;

  try {
    await apiPost('/family/invite', { email, role });
    toast('Invitation sent!', 'success');
    $('invite-overlay').classList.add('hidden');
    $('invite-email').value = '';
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Capture ───────────────────────────────────────────────────────────────────
function bindCapture() {
  $('capture-close').addEventListener('click', () => $('capture-overlay').classList.add('hidden'));

  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`[data-content="${tab.dataset.tab}"]`).classList.add('active');
      currentTab = tab.dataset.tab;
    });
  });

  const drop = $('file-drop');
  const input = $('file-input');
  const name = $('file-name');

  input.addEventListener('change', () => {
    const count = input.files.length;
    name.textContent = count > 1 ? `${count} files` : (input.files[0]?.name ?? '');
  });

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dragging');
    if (e.dataTransfer.files.length) {
      input.files = e.dataTransfer.files;
      name.textContent = input.files.length > 1 ? `${input.files.length} files` : input.files[0].name;
    }
  });

  $('capture-btn').addEventListener('click', handleCapture);
}

async function handleCapture() {
  const btn = $('capture-btn');
  const editId = btn.dataset.editId;
  btn.disabled = true;
  setStatus(editId ? 'Updating…' : 'Saving…');

  try {
    if (editId) {
      const content = currentTab === 'text' ? $('text-input').value.trim() : $('url-input').value.trim();
      if (!content) throw new Error('Empty content');
      await apiPatch(`/entries/${editId}`, { content });
    } else if (currentTab === 'file') {
      const files = Array.from($('file-input').files);
      const note = $('file-note').value.trim();
      for (const file of files) {
        const uploaded = await uploadFile(file);
        await apiPost('/entries', {
          content: note || file.name,
          content_type: file.type.startsWith('image/') ? 'image' : 'file',
          file_url: uploaded.file_url,
          file_key: uploaded.file_key,
          ai_metadata: { b2_file_id: uploaded.file_id }
        });
      }
    } else {
      const content = currentTab === 'text' ? $('text-input').value.trim() : $('url-input').value.trim();
      const type = currentTab === 'text' ? 'text' : 'url';
      if (!content) throw new Error('Empty content');
      await apiPost('/entries', { content, content_type: type });
    }

    toast(editId ? 'Updated!' : 'Saved!', 'success');
    clearCapture();
    $('capture-overlay').classList.add('hidden');
    loadFeed(true);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    setStatus('');
  }
}

function clearCapture() {
  $('text-input').value = '';
  $('url-input').value = '';
  $('url-note').value = '';
  $('file-input').value = '';
  $('file-name').textContent = '';
  $('file-note').value = '';
  
  const btn = $('capture-btn');
  delete btn.dataset.editId;
  btn.innerHTML = '<span>Save</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
}

function setStatus(msg) { $('capture-status').textContent = msg; }

async function uploadFile(file) {
  const session = await supabase?.auth.getSession();
  const token = session?.data?.session?.access_token;
  const form = new FormData();
  form.append('file', file);
  form.append('mime_type', file.type);
  const res = await fetch(`${API_BASE}/file`, { 
    method: 'POST', 
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    body: form 
  });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}

// ── Feed ──────────────────────────────────────────────────────────────────────
async function loadFeed(reset = false) {
  if (isFeedLoading || !user) return;
  isFeedLoading = true;

  if (reset) {
    feedOffset = 0;
    $('entries-list').innerHTML = '<div class="loading-state">Loading…</div>';
  }

  try {
    let url = `/entries?limit=20&offset=${feedOffset}`;
    if (currentFilter.status === 'starred') {
      url += `&is_starred=true&status=eq.active`;
    } else {
      url += `&status=eq.${currentFilter.status}`;
    }
    
    if (currentFilter.type) url += `&content_type=eq.${currentFilter.type}`;
    if (currentFilter.label) url += `&ai_labels=cs.{${currentFilter.label}}`;
    if (currentFilter.collection) url += `&collection_id=eq.${currentFilter.collection}`;

    const data = await apiFetch(url);
    if (reset) $('entries-list').innerHTML = '';

    if (data.length === 0 && reset) {
      $('entries-list').innerHTML = '<div class="empty-state">No entries found.</div>';
    } else {
      data.forEach(entry => appendEntryCard(entry));
      feedOffset += data.length;
      $('load-more').classList.toggle('hidden', data.length < 20);
    }
    renderLabelNav(data);
  } catch (err) {
    console.error(err);
    $('entries-list').innerHTML = '<div class="empty-state">Error loading feed.</div>';
  } finally {
    isFeedLoading = false;
  }
}

function renderLabelNav(entries) {
  entries.forEach(e => (e.ai_labels || []).forEach(l => allLabels.add(l)));
  const list = $('label-nav-list');
  list.innerHTML = '';
  [...allLabels].sort().forEach(label => {
    const btn = document.createElement('button');
    btn.className = `nav-item${currentFilter.label === label ? ' active' : ''}`;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg><span>${label}</span>`;
    btn.onclick = () => {
      currentFilter.label = currentFilter.label === label ? null : label;
      loadFeed(true);
    };
    list.appendChild(btn);
  });
}

function appendEntryCard(entry) {
  $('entries-list').appendChild(buildEntryCard(entry));
}

function buildEntryCard(entry) {
  const card = document.createElement('div');
  card.className = `entry-card ${selectedEntries.has(entry.id) ? 'selected' : ''}`;
  card.dataset.id = entry.id;

  const thumb = (entry.file_url && entry.content_type === 'image')
    ? `<img class="entry-file-thumb" src="${escHtml(entry.file_url)}" alt="" loading="lazy">`
    : '';

  const labels = (entry.ai_labels || []).map(l => `<span class="entry-label">${escHtml(l)}</span>`).join('');
  const summary = entry.ai_summary ? `<div class="entry-summary">${escHtml(entry.ai_summary)}</div>` : '';
  
  const contentFallback = entry.content_type === 'image' ? '📷 Image attachment'
    : entry.content_type === 'file' ? '📎 File attachment'
    : entry.content_type === 'url'  ? (entry.source || '🔗 Link')
    : entry.ai_summary              ? null  // summary div below will show it
    : '(no content)';
  const content = entry.content || contentFallback;

  const pinnedIcon = entry.is_pinned ? `<div class="pin-indicator" title="Pinned"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="M16.5 9.4L7.5 4.21"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/><circle cx="18.5" cy="15.5" r="2.5"/><path d="M18.5 18v3"/></svg></div>` : '';

  card.innerHTML = `
    ${pinnedIcon}
    ${thumb}
    <div class="entry-main">
      <div class="entry-content">${escHtml(content)}</div>
      ${summary}
      <div class="entry-footer">
        <div class="entry-labels">${labels}</div>
        <div class="entry-time">${formatRelative(entry.created_at)}</div>
      </div>
    </div>
    <div class="entry-actions">
      <button class="action-btn pin-btn ${entry.is_pinned ? 'pinned' : ''}" title="Pin/Unpin">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="M16.5 9.4L7.5 4.21"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/><circle cx="18.5" cy="15.5" r="2.5"/><path d="M18.5 18v3"/></svg>
      </button>
      <button class="action-btn star-btn ${entry.is_starred ? 'pinned' : ''}" title="Star/Unstar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      </button>
      <button class="action-btn edit-btn" title="Edit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
      </button>
      <button class="action-btn share-btn" title="Share">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
      </button>
    </div>
  `;

  card.onclick = (e) => {
    if (isSelectionMode) {
      if (selectedEntries.has(entry.id)) {
        selectedEntries.delete(entry.id);
        card.classList.remove('selected');
      } else {
        selectedEntries.add(entry.id);
        card.classList.add('selected');
      }
      updateSelectionUI();
      return;
    }
    
    const actionBtn = e.target.closest('.action-btn');
    if (actionBtn) {
      e.stopPropagation();
      if (actionBtn.classList.contains('pin-btn')) handlePin(entry);
      if (actionBtn.classList.contains('star-btn')) handleStar(entry);
      if (actionBtn.classList.contains('edit-btn')) handleEdit(entry);
      if (actionBtn.classList.contains('share-btn')) handleShare(entry);
      return;
    }

    console.log('Open entry', entry.id);
  };

  return card;
}

async function handlePin(entry) {
  try {
    const is_pinned = !entry.is_pinned;
    await apiPatch(`/entries/${entry.id}`, { is_pinned });
    loadFeed(true);
  } catch (err) { toast(err.message, 'error'); }
}

async function handleStar(entry) {
  try {
    const is_starred = !entry.is_starred;
    await apiPatch(`/entries/${entry.id}`, { is_starred });
    loadFeed(true);
  } catch (err) { toast(err.message, 'error'); }
}

function handleEdit(entry) {
  $('text-input').value = entry.content;
  $('capture-overlay').classList.remove('hidden');
  // Need to track that we are editing
  $('capture-btn').dataset.editId = entry.id;
  $('capture-btn').innerHTML = '<span>Update</span>';
}

async function handleShare(entry) {
  try {
    // Set to public first
    await apiPatch(`/entries/${entry.id}`, { sharing_scope: 'public' });
    const shareUrl = `${window.location.origin}/entries/${entry.id}`; // Handled by updateUser() SPA routing → loadPublicEntry()
    await navigator.clipboard.writeText(shareUrl);
    toast('Public link copied to clipboard!', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function apiPatch(path, data) {
  const session = await supabase?.auth.getSession();
  const token = session?.data?.session?.access_token;
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : ''
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Patch failed');
  return res.json();
}

// ── Search ────────────────────────────────────────────────────────────────────
function bindSearch() {
  const input = $('search-input');
  input.addEventListener('input', () => {
    clearTimeout(searchDebounceId);
    const q = input.value.trim();
    if (!q) { $('search-results').classList.add('hidden'); return; }
    searchDebounceId = setTimeout(async () => {
      try {
        const data = await apiFetch(`/search?q=${encodeURIComponent(q)}&limit=5`);
        renderSearchResults(data.results || []);
      } catch { renderSearchResults([]); }
    }, 300);
  });
}

function renderSearchResults(results) {
  const el = $('search-results');
  el.innerHTML = '';
  el.classList.toggle('hidden', results.length === 0);
  results.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.innerHTML = `<div class="sr-content">${escHtml(entry.content || entry.ai_summary)}</div>`;
    item.onclick = () => {
      el.classList.add('hidden');
      document.querySelector(`[data-id="${entry.id}"]`)?.scrollIntoView({ behavior: 'smooth' });
    };
    el.appendChild(item);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function bindViewToggle() {
  const btn = $('view-toggle');
  const updateIcon = () => {
    btn.innerHTML = currentView === 'list'
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
  };
  updateIcon();
  btn.onclick = () => {
    currentView = currentView === 'list' ? 'grid' : 'list';
    $('entries-list').className = `entries-list ${currentView}-view`;
    updateIcon();
  };
}

function bindLoadMore() { $('load-more').onclick = () => loadFeed(); }

async function apiFetch(path, options = {}) {
  // Get current session token
  let sessionResult = await supabase?.auth.getSession();
  let token = sessionResult?.data?.session?.access_token;

  // If no token but supabase is available, attempt a session refresh
  if (!token && supabase) {
    const refreshed = await supabase.auth.refreshSession();
    token = refreshed?.data?.session?.access_token ?? null;
  }

  console.log(`[apiFetch] ${path}`, { hasToken: !!token });

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    }
  });

  // On 401, try one token refresh and retry before failing
  if (res.status === 401 && supabase) {
    console.warn('[apiFetch] 401 on', path, '— refreshing session and retrying');
    const refreshed = await supabase.auth.refreshSession();
    const newToken = refreshed?.data?.session?.access_token;
    if (!newToken) {
      // Session is truly gone — sign user out and show login
      updateUser(null);
      throw new Error('Session expired — please sign in again');
    }
    const retry = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        'Authorization': `Bearer ${newToken}`
      }
    });
    if (!retry.ok) throw new Error('Fetch failed');
    return retry.json();
  }

  if (!res.ok) throw new Error('Fetch failed');
  return res.json();
}

async function apiPost(path, data) {
  let sessionResult = await supabase?.auth.getSession();
  let token = sessionResult?.data?.session?.access_token;
  if (!token && supabase) {
    const refreshed = await supabase.auth.refreshSession();
    token = refreshed?.data?.session?.access_token ?? null;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Post failed');
  return res.json();
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[sw] Registered:', reg.scope);
    } catch (err) {
      console.error('[sw] Registration failed:', err);
    }
  }
}
