// Known Words management page

let _words = [];
let _filter = '';

const listEl    = document.getElementById('list-container');
const countEl   = document.getElementById('count-label');
const searchEl  = document.getElementById('search');
const clearBtn  = document.getElementById('clear-all-btn');
const exportBtn = document.getElementById('export-btn');

async function _load() {
  const { mc_user_known = [] } = await chrome.storage.local.get('mc_user_known');
  _words = [...mc_user_known].sort((a, b) => a.localeCompare(b, 'ja'));
  _render();
}

function _render() {
  const q = _filter.trim().toLowerCase();
  const visible = q ? _words.filter(w => w.toLowerCase().includes(q)) : _words;

  countEl.textContent = _words.length
    ? `${_words.length} word${_words.length === 1 ? '' : 's'}`
    : '';
  clearBtn.disabled = _words.length === 0;
  exportBtn.disabled = _words.length === 0;

  if (_words.length === 0) {
    listEl.innerHTML = `<div class="empty">
      <strong>No words yet</strong>
      Click <em>"+ Set as Known"</em> in any word tooltip<br>while hovering over Japanese text.
    </div>`;
    return;
  }

  if (visible.length === 0) {
    listEl.innerHTML = `<div class="no-match">No words match "<strong>${_esc(q)}</strong>"</div>`;
    return;
  }

  listEl.innerHTML = `<div class="word-list">${
    visible.map(w => `
      <div class="word-row" data-word="${_esc(w)}">
        <span class="word-text">${_esc(w)}</span>
        <span class="word-tag">user</span>
        <button class="btn-remove" data-word="${_esc(w)}" title="Remove">×</button>
      </div>`).join('')
  }</div>`;

  listEl.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => _remove(btn.dataset.word));
  });
}

async function _remove(word) {
  _words = _words.filter(w => w !== word);
  await chrome.storage.local.set({ mc_user_known: _words });
  _render();
}

clearBtn.addEventListener('click', async () => {
  if (!_words.length) return;
  if (!confirm(`Remove all ${_words.length} user-marked known words?`)) return;
  _words = [];
  await chrome.storage.local.set({ mc_user_known: [] });
  _render();
});

exportBtn.addEventListener('click', () => {
  if (!_words.length) return;
  const csv = 'word\n' + _words.map(w => `"${w.replace(/"/g, '""')}"`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'known_words.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

searchEl.addEventListener('input', () => {
  _filter = searchEl.value;
  _render();
});

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

_load();
