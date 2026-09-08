(function() {
    var stream = document.getElementById('chat-stream');
    var emptyEl = document.getElementById('chat-empty');
    var form = document.getElementById('composer');
    var input = document.getElementById('message-input');
    var sendBtn = document.getElementById('send-btn');
    var sendLoader = document.getElementById('send-loader');
    var sendArrow = document.getElementById('send-arrow');
    var clearBtn = document.getElementById('clear-btn');
    var composerWrap = document.getElementById('composer');
    var progressBarWrap = document.getElementById('progress-bar-wrap');
    var progressEmoji = document.getElementById('progress-emoji');
    var progressLabel = document.getElementById('progress-label');
    var progressStatus = document.getElementById('progress-status');
    var charCountEl = document.getElementById('char-count');
    var exportBtn = document.querySelector('.export-btn');
    var clearBtnH = document.querySelector('.clear-btn');
    var uploadBtn = document.getElementById('upload-btn');
    var fileInput = document.getElementById('file-input');
    var attachmentPreview = document.getElementById('attachment-preview');
    var sidebarToggleBtn = document.getElementById('sidebar-toggle');
    var sidebarEl = document.getElementById('session-sidebar');
    var sidebarCloseBtn = document.getElementById('sidebar-close');
    var sidebarBackdrop = document.getElementById('sidebar-backdrop');
    var newChatBtn = document.getElementById('new-chat-btn');
    var sessionListEl = document.getElementById('session-list');
    var sessionCountEl = document.getElementById('session-count');

    var scriptEl = document.currentScript || (function() {
        var allScripts = document.getElementsByTagName('script');
        return allScripts[allScripts.length - 1];
    })();
    var API_URL = (scriptEl && scriptEl.src) ? String(scriptEl.src).replace(/[?#].*$/, '').replace(/[^/]*$/, 'api.php') : 'api.php';

    if (input) input.focus();

    // ===== CLIENT ERROR CAPTURE: kirim error JS ke server log =====
    var clientLogQueue = [];
    var clientLogSending = false;
    function clientLog(level, message, extra) {
        clientLogQueue.push({
            level: level,
            message: String(message || '').slice(0, 500),
            url: location.pathname.slice(0, 80),
            extra: extra || null
        });
        if (clientLogQueue.length > 30) clientLogQueue.shift();
        setTimeout(clientLogFlush, 300);
    }
    function clientLogFlush() {
        if (clientLogSending || !clientLogQueue.length) return;
        clientLogSending = true;
        var batch = clientLogQueue.splice(0, 10);
        fetch(API_URL + '?action=client_log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch: batch }),
            keepalive: true
        }).then(function() { clientLogSending = false; clientLogFlush(); })
          .catch(function() { clientLogSending = false; });
    }
    window.addEventListener('error', function(e) {
        clientLog('error', (e.message || 'JS error'), {
            line: e.lineno || 0,
            col: e.colno || 0,
            stack: (e.error && e.error.stack ? String(e.error.stack) : '').slice(0, 400),
            src: (e.filename || '').slice(0, 120)
        });
    });
    window.addEventListener('unhandledrejection', function(e) {
        var r = e.reason;
        clientLog('error', 'unhandledrejection: ' + (r && r.message ? r.message : String(r)).slice(0, 300), {
            stack: (r && r.stack ? String(r.stack) : '').slice(0, 400)
        });
    });
    if (navigator.serviceWorker) {
        navigator.serviceWorker.ready.then(function(reg) {
            clientLog('info', 'SW active: ' + (reg.active ? (reg.active.scriptURL || '?') : '?'), null);
        }).catch(function() {});
    }
    window.__clientLog = clientLog;

    var messages = [];
    var busy = false;
    var STORE_KEY = 'debz_sessions_v8';
    var LEGACY_KEY = 'debz_chat_history_v7';
    var sessions = [];
    var activeSessionId = null;
    var MAX_CHARS = Number.MAX_SAFE_INTEGER;
    var abortController = null;
    window.lastToolProgress = {};
    var selectedFiles = [];

    var hljsObserver = new MutationObserver(function(mutations) {
        if (typeof hljs !== 'undefined') {
            mutations.forEach(function(mutation) {
                if (mutation.addedNodes.length) {
                    var newBlocks = stream.querySelectorAll('pre code:not(.hljs)');
                    newBlocks.forEach(function(block) {
                        hljs.highlightElement(block);
                    });
                }
            });
        }
    });
    if (stream) hljsObserver.observe(stream, { childList: true, subtree: true });

    function showToast(text, duration) {
        duration = duration || 2000;
        var t = document.getElementById('toast');
        if (!t) return;
        t.textContent = text;
        t.classList.add('show');
        setTimeout(function() { t.classList.remove('show'); }, duration);
    }

    function cleanTitle(text) {
        var t = String(text)
            .replace(/<div[\s\S]*?<\/div>/g, '')
            .replace(/[#*`>_~\[\]()]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (t.length > 38) t = t.slice(0, 38) + '…';
        return t || 'Chat Baru';
    }

    function saveStore() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify({ activeId: activeSessionId, sessions: sessions }));
        } catch(e) {
            showToast('Storage penuh! Hapus session lama biar muat.');
        }
    }

    function createSession(title) {
        var s = {
            id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            title: title || 'Chat Baru',
            titleSet: !!title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: []
        };
        sessions.unshift(s);
        activeSessionId = s.id;
        saveStore();
        return s;
    }

    function getSession(id) {
        for (var i = 0; i < sessions.length; i++) {
            if (sessions[i].id === id) return sessions[i];
        }
        return null;
    }

    function activeSession() {
        var s = getSession(activeSessionId);
        if (!s) {
            if (sessions.length) {
                activeSessionId = sessions[0].id;
                s = sessions[0];
            } else {
                s = createSession(null);
            }
        }
        return s;
    }

    function loadStore() {
        var store = null;
        try {
            var raw = localStorage.getItem(STORE_KEY);
            if (raw) store = JSON.parse(raw);
        } catch(e) {}

        if (store && Array.isArray(store.sessions)) {
            sessions = store.sessions.filter(function(s) {
                return s && s.id && Array.isArray(s.messages);
            });
            if (store.activeId && getSession(store.activeId)) {
                activeSessionId = store.activeId;
            } else if (sessions.length) {
                activeSessionId = sessions[0].id;
            }
        }

        if (!sessions.length) {
            var legacy = [];
            try {
                var lraw = localStorage.getItem(LEGACY_KEY);
                if (lraw) legacy = JSON.parse(lraw) || [];
            } catch(e) {}
            if (Array.isArray(legacy) && legacy.length) {
                var firstUser = null;
                legacy.forEach(function(m) {
                    if (!firstUser && m && m.role === 'user' && m.content) firstUser = m.content;
                });
                var s = createSession(firstUser ? cleanTitle(firstUser) : 'Chat Lama');
                s.messages = legacy.filter(function(m) {
                    if (!m || !m.role) return false;
                    if (m.role === 'assistant' && (!m.content || !m.content.trim())) return false;
                    return true;
                });
                s.titleSet = true;
                s.createdAt = (s.messages[0] && s.messages[0].timestamp) || Date.now();
                s.updatedAt = (s.messages[s.messages.length - 1] && s.messages[s.messages.length - 1].timestamp) || Date.now();
                activeSessionId = s.id;
                saveStore();
                try { localStorage.removeItem(LEGACY_KEY); } catch(e) {}
            }
        }

        if (!sessions.length) createSession(null);
    }

    function resetTypewriter() {
        if (typeTimeout) clearTimeout(typeTimeout);
        typeLineIdx = 0;
        typeCharIdx = 0;
        currentSpan = null;
        if (typingContainer) typingContainer.innerHTML = '';
        if (emptyEl) {
            emptyEl.style.display = 'flex';
            if (stream && emptyEl.parentNode !== stream) stream.appendChild(emptyEl);
            if (typingContainer) typeTimeout = setTimeout(runTypewriter, 300);
        }
    }

    function renderStoredContent(role, content) {
        var c = String(content || '');
        if (role === 'assistant') {
            var fences = (c.match(/```/g) || []).length;
            if (fences % 2 !== 0) c += '\n```';
            return md(c);
        }
        return c.replace(/<div style="width: 70px;[\s\S]*?<\/div>/g, '<div style="background: rgba(0,0,0,0.2); padding: 4px 8px; border-radius: 4px; font-size: 11px;">🖼️ gambar</div>');
    }

    // 💭 Reasoning box — kolapsible, nempel di atas konten bubble assistant.
    // Dipake buat: (1) live stream (event type=reasoning), (2) reload session
    // (reasoning_details tersimpan di message object, ikut localStorage).
    function renderRDBox(host, items) {
        if (!host || !items || !items.length) return;
        var total = 0, txt = '';
        items.forEach(function(it) {
            txt += (it.text || '');
            total += (it.text || '').length + (it.data || '').length;
        });
        var box = host.querySelector('details.rd-box');
        if (!box) {
            box = document.createElement('details');
            box.className = 'rd-box';
            host.insertBefore(box, host.firstChild);
        }
        var wasOpen = box.open;
        box.innerHTML = '<summary>💭 Mikir — ' + total + ' chars (reasoning internal)</summary>'
            + '<div class="rd-body">' + escapeHTML(txt.length > 6000 ? txt.slice(0, 6000) + '\n…' : txt) + '</div>';
        box.open = wasOpen;
    }

    function loadSessionView() {
        var s = activeSession();
        var cleaned = s.messages.filter(function(m) {
            if (!m || !m.role) return false;
            if (m.role === 'assistant' && (!m.content || !m.content.trim())) return false;
            return true;
        });
        if (cleaned.length !== s.messages.length) {
            s.messages = cleaned;
            saveStore();
        }
        messages = s.messages;
        if (stream) stream.innerHTML = '';
        if (messages.length) {
            messages.forEach(function(m) {
                renderMessage(m.role, renderStoredContent(m.role, m.content), false, false, m.timestamp);
                if (m.role === 'assistant' && m.reasoning_details && m.reasoning_details.length) {
                    var lastMsg = stream.lastChild;
                    if (lastMsg) renderRDBox(lastMsg.querySelector('.msg-text'), m.reasoning_details);
                }
            });
            applyHighlighting();
            scrollDown(true);
        } else {
            resetTypewriter();
        }
    }

    function formatRelTime(ts) {
        if (!ts) return 'baru aja';
        var diff = Date.now() - ts;
        var mnt = Math.floor(diff / 60000);
        if (mnt < 1) return 'baru aja';
        if (mnt < 60) return mnt + ' menit lalu';
        var hr = Math.floor(mnt / 60);
        if (hr < 24) return hr + ' jam lalu';
        var dy = Math.floor(hr / 24);
        if (dy < 30) return dy + ' hari lalu';
        return new Date(ts).toLocaleDateString('id-ID');
    }

    function renderSessionList() {
        if (sessionCountEl) sessionCountEl.textContent = sessions.length + ' session' + (sessions.length === 1 ? '' : 's');
        if (!sessionListEl) return;
        if (!sessions.length) {
            sessionListEl.innerHTML = '<div class="session-empty">Belum ada session</div>';
            return;
        }
        var sorted = sessions.slice().sort(function(a, b) {
            return (b.updatedAt || 0) - (a.updatedAt || 0);
        });
        var html = '';
        sorted.forEach(function(s) {
            var count = (s.messages || []).length;
            var isActive = s.id === activeSessionId;
            html += '<div class="session-item' + (isActive ? ' active' : '') + '" data-id="' + s.id + '" title="' + escapeHTML(s.title) + '">'
                + '<div class="session-icon">' + (count ? '💬' : '✨') + '</div>'
                + '<div class="session-info">'
                + '<div class="session-title">' + escapeHTML(s.title) + '</div>'
                + '<div class="session-meta">' + count + ' pesan · ' + formatRelTime(s.updatedAt || s.createdAt) + '</div>'
                + '</div>'
                + '<button type="button" class="session-del" data-del="' + s.id + '" title="Hapus session ini"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
                + '</div>';
        });
        sessionListEl.innerHTML = html;
    }

    function openSidebar() {
        if (sidebarEl) sidebarEl.classList.add('open');
        if (sidebarBackdrop) sidebarBackdrop.classList.add('show');
        renderSessionList();
    }

    function closeSidebar() {
        if (sidebarEl) sidebarEl.classList.remove('open');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('show');
    }

    function switchSession(id) {
        if (busy) {
            showToast('Tungguin Debz kelar jawab dulu..');
            return;
        }
        if (editBackup) cancelEdit(true); // restore dulu biar session yang diedit gak nyangkut kepotong
        var s = getSession(id);
        if (!s) return;
        if (s.id === activeSessionId) { closeSidebar(); return; }
        activeSessionId = s.id;
        saveStore();
        loadSessionView();
        renderSessionList();
        closeSidebar();
    }

    function deleteSession(id) {
        var s = getSession(id);
        if (!s) return;
        if (busy && id === activeSessionId) {
            showToast('Tungguin Debz kelar jawab dulu..');
            return;
        }
        if (!confirm('Hapus session "' + s.title + '"? Semua chat di dalamnya bakal ilang permanen.')) return;
        var wasActive = (id === activeSessionId);
        sessions = sessions.filter(function(x) { return x.id !== id; });
        if (wasActive) {
            if (sessions.length) {
                activeSessionId = sessions[0].id;
            } else {
                activeSessionId = null;
                createSession(null);
            }
            saveStore();
            loadSessionView();
        } else {
            saveStore();
        }
        renderSessionList();
        showToast('Session dihapus!');
    }

    function newChat() {
        if (busy) {
            showToast('Tungguin Debz kelar jawab dulu..');
            return;
        }
        if (editBackup) cancelEdit(true); // restore dulu sebelum pindah context
        var cur = activeSession();
        if (cur && cur.messages.length === 0) {
            closeSidebar();
            showToast('Udah di chat kosong nih');
            return;
        }
        createSession(null);
        loadSessionView();
        renderSessionList();
        closeSidebar();
        if (window.innerWidth > 600 && input) input.focus();
    }

    function exportChat() {
        if (!messages.length) {
            showToast('Belum ada chat untuk di-export');
            return;
        }
        var markdownData = '# Chat Export - Debz AI\n\n';
        messages.forEach(function(m) {
            var role = m.role === 'user' ? '**You**' : '**Debz AI**';
            markdownData += role + ':\n' + m.content + '\n\n---\n\n';
        });
        var blob = new Blob([markdownData], { type: 'text/markdown' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'debz-chat-' + new Date().toISOString().slice(0,10) + '.md';
        a.click();
        URL.revokeObjectURL(a.href);
        showToast('Chat exported!');
    }

    if (exportBtn) exportBtn.addEventListener('click', exportChat);
    document.querySelectorAll('.export-btn').forEach(function(b) {
        if (b !== exportBtn) b.addEventListener('click', exportChat);
    });

    function clearAllChats() {
        editBackup = null; // chat mau dibersihin — backup edit gak relevan lagi
        if (composerWrap) composerWrap.classList.remove('editing');
        var s = activeSession();
        if (s) {
            s.messages = [];
            s.title = 'Chat Baru';
            s.titleSet = false;
            messages = s.messages;
        }
        saveStore();
        if (stream) stream.innerHTML = '';
        resetTypewriter();
        renderSessionList();
        showToast('Chat cleared!');
    }

    document.querySelectorAll('.clear-btn').forEach(function(b) {
        b.addEventListener('click', function() {
            if (busy) { showToast('Tungguin Debz kelar jawab dulu..'); return; }
            if (confirm('Yakin mau hapus semua chat di session ini?')) clearAllChats();
        });
    });

    if (sidebarToggleBtn) sidebarToggleBtn.addEventListener('click', openSidebar);
    if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', closeSidebar);
    if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', closeSidebar);
    if (newChatBtn) newChatBtn.addEventListener('click', newChat);

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (termOpen) { closeTerm(); return; }
            closeSidebar();
            if (editBackup) cancelEdit();
        }
    });

    if (sessionListEl) {
        sessionListEl.addEventListener('click', function(e) {
            var target = e.target || e.srcElement;
            if (!target || !target.closest) return;
            var delBtn = target.closest('.session-del');
            if (delBtn) {
                e.stopPropagation();
                deleteSession(delBtn.getAttribute('data-del'));
                return;
            }
            var item = target.closest('.session-item');
            if (item) switchSession(item.getAttribute('data-id'));
        });
    }

    if (sidebarEl) {
        var touchStartX = null;
        sidebarEl.addEventListener('touchstart', function(e) {
            if (!e.touches || !e.touches.length) return;
            touchStartX = e.touches[0].clientX;
        }, { passive: true });
        sidebarEl.addEventListener('touchend', function(e) {
            if (touchStartX === null) return;
            if (!e.changedTouches || !e.changedTouches.length) { touchStartX = null; return; }
            var dx = e.changedTouches[0].clientX - touchStartX;
            if (dx < -50) closeSidebar();
            touchStartX = null;
        }, { passive: true });
    }

    function showProgress(emoji, label) {
        if (!progressBarWrap) return;
        if (progressStatus) {
            progressStatus.style.display = 'none'; 
        }
        progressEmoji.textContent = emoji || '⏳';
        progressLabel.textContent = label || 'Processing...';
        progressBarWrap.classList.add('active');
        progressBarWrap.style.marginBottom = '0px';
        scrollDown();
    }

    function hideProgress() {
        if (progressBarWrap) progressBarWrap.classList.remove('active');
    }

    var activeApprovalEl = null;
    var bubbleTextRef = null;
    var approvalCards = [];
    var approvalSession = false; // Allow Session aktif → gak nanya lagi selama tab ini hidup

    // Card approval udah dijawab → buang dari UI + dari daftar re-append stream end
    function removeApprovalCard(card) {
        if (!card) return;
        if (card.parentNode) card.parentNode.removeChild(card);
        approvalCards = approvalCards.filter(function(c) { return c !== card; });
        if (activeApprovalEl === card) activeApprovalEl = null;
    }

    function approvalChoiceMeta(choice) {
        switch (choice) {
            case 'once':    return { label: 'Allow Once',    emoji: '▶️', cls: 'allow' };
            case 'session': return { label: 'Allow Session', emoji: '🕐', cls: 'allow' };
            case 'always':  return { label: 'Allow All',     emoji: '♾️', cls: 'allow' };
            case 'deny':    return { label: 'Reject',        emoji: '⛔', cls: 'deny' };
            default:        return { label: choice, emoji: '•', cls: '' };
        }
    }

    function showApprovalCard(data) {
        if (!bubbleTextRef) return;
        var runId = data.run_id || '';
        var command = data.command || '(perintah tidak tersedia)';
        var reason = data.reason || '';
        var choices = Array.isArray(data.choices) && data.choices.length ? data.choices : ['once', 'session', 'always', 'deny'];

        var card = document.createElement('div');
        card.className = 'approval-card';
        card.setAttribute('data-run-id', runId);

        var head = document.createElement('div');
        head.className = 'approval-head';
        head.innerHTML = '<span class="approval-icon">🔐</span><span class="approval-title">Approval Diperlukan</span><span class="approval-badge">MENUNGGU KEPUTUSAN LU</span>';

        var cmdPre = document.createElement('div');
        cmdPre.className = 'approval-cmd';
        cmdPre.textContent = command;

        card.appendChild(head);
        card.appendChild(cmdPre);

        if (reason) {
            var reasonDiv = document.createElement('div');
            reasonDiv.className = 'approval-reason';
            reasonDiv.textContent = reason;
            card.appendChild(reasonDiv);
        }

        var btns = document.createElement('div');
        btns.className = 'approval-buttons';
        choices.forEach(function(c) {
            var meta = approvalChoiceMeta(c);
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'approval-btn ' + meta.cls;
            b.setAttribute('data-choice', c);
            b.innerHTML = '<span class="approval-btn-emoji">' + meta.emoji + '</span>' + meta.label;
            b.addEventListener('click', function() { resolveApproval(card, runId, c, b); });
            btns.appendChild(b);
        });
        card.appendChild(btns);

        var hint = document.createElement('div');
        hint.className = 'approval-hint';
        hint.textContent = 'Agent nunggu keputusan lu — stream tetap hidup selama menunggu.';
        card.appendChild(hint);

        bubbleTextRef.appendChild(card);
        approvalCards.push(card);
        activeApprovalEl = card;
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        showProgress('⏳', 'Nunggu');
    }

    function resolveApproval(card, runId, choice, btn) {
        if (card.classList.contains('resolved')) return;
        card.classList.add('resolved');
        card.querySelectorAll('.approval-btn').forEach(function(b) { b.disabled = true; });
        if (btn) btn.classList.add('picked');

        fetch(API_URL + '?action=approval', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ run_id: runId, choice: choice })
        }).then(function(r) { return r.json(); }).then(function(res) {
            var ok = res && (res.success === true || res.resolved === 1 || res.resolved > 0 || res.choice);
            var meta = approvalChoiceMeta(choice);
            if (ok) {
                if (choice === 'session') approvalSession = true;
                removeApprovalCard(card); // keputusan terkirim → card langsung hilang dari UI
                if (choice === 'deny') {
                    showProgress('⛔', 'Ditolak — agent lanjut...');
                } else {
                    showProgress('✅', 'Terima: ' + meta.label + ' — agent lanjut...');
                }
                showToast((choice === 'deny' ? '⛔ ' : '✓ ') + meta.label, 1800);
            } else {
                var note = document.createElement('div');
                note.className = 'approval-note err';
                note.textContent = '⚠️ Gagal: ' + (res && res.error ? res.error : 'coba lagi');
                card.appendChild(note);
                card.classList.remove('resolved');
                card.querySelectorAll('.approval-btn').forEach(function(b) { b.disabled = false; });
            }
        }).catch(function(e) {
            var note = document.createElement('div');
            note.className = 'approval-note err';
            note.textContent = '⚠️ Gagal kirim: ' + (e && e.message ? e.message : e);
            card.appendChild(note);
            card.classList.remove('resolved');
            card.querySelectorAll('.approval-btn').forEach(function(b) { b.disabled = false; });
        });
    }

    function markApprovalDone(choice, runId, auto) {
        if (auto) {
            termLog('info', '🔓 auto-approve (' + (choice || '?') + ') — allow-all/session aktif');
            return;
        }
        var card = null;
        if (runId) {
            for (var i = 0; i < approvalCards.length; i++) {
                if (approvalCards[i].getAttribute('data-run-id') === runId) { card = approvalCards[i]; break; }
            }
        }
        if (!card) card = activeApprovalEl;
        removeApprovalCard(card);
    }

    var lastProgressKey = '';
    var tokenCounter = document.createElement('span');
    tokenCounter.className = 'token-count';
    tokenCounter.textContent = '0 tokens';
    if (progressBarWrap) {
        progressBarWrap.appendChild(tokenCounter);
    }

    var elapsedSpan = document.createElement('span');
    elapsedSpan.className = 'progress-elapsed';
    elapsedSpan.textContent = '';
    if (progressBarWrap) {
        progressBarWrap.appendChild(elapsedSpan);
    }
    var elapsedTimer = null;

    function startElapsed() {
        stopElapsed();
        var t0 = Date.now();
        if (elapsedSpan) elapsedSpan.textContent = '· 0s';
        elapsedTimer = setInterval(function() {
            if (!elapsedSpan) return;
            var s = Math.floor((Date.now() - t0) / 1000);
            elapsedSpan.textContent = '· ' + s + 's';
        }, 1000);
    }

    function stopElapsed() {
        if (elapsedTimer) clearInterval(elapsedTimer);
        elapsedTimer = null;
        if (elapsedSpan) elapsedSpan.textContent = '';
    }

    // ===== TERMINAL LIVE (Console >_) =====
    var termModal = document.getElementById('term-modal');
    var termBackdrop = document.getElementById('term-backdrop');
    var termBtn = document.getElementById('term-btn');
    var termBody = document.getElementById('term-body');
    var termMeta = document.getElementById('term-meta');
    var termClearBtn = document.getElementById('term-clear');
    var termCloseBtn = document.getElementById('term-close');
    var termBuf = [];
    var termOpen = false;
    var TERM_MAX = 400;

    function termFmtTime(ts) {
        var d = new Date(ts);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    }

    function termMakeLine(item) {
        var line = document.createElement('div');
        line.className = 'term-line term-' + (item.kind || 'info');
        var ts = document.createElement('span');
        ts.className = 'term-ts';
        ts.textContent = termFmtTime(item.t) + ' ';
        var tx = document.createElement('span');
        tx.className = 'term-tx';
        tx.textContent = item.text;
        line.appendChild(ts);
        line.appendChild(tx);
        return line;
    }

    function termLog(kind, text) {
        if (!text) return;
        var item = { t: Date.now(), kind: kind || 'info', text: String(text) };
        termBuf.push(item);
        if (termBuf.length > TERM_MAX) termBuf.shift();
        if (!termOpen || !termBody) return;
        var nearBottom = termBody.scrollHeight - termBody.scrollTop - termBody.clientHeight < 80;
        termBody.appendChild(termMakeLine(item));
        while (termBody.children.length > TERM_MAX) termBody.removeChild(termBody.firstChild);
        if (nearBottom) termBody.scrollTop = termBody.scrollHeight;
    }

    function termRenderAll() {
        if (!termBody) return;
        termBody.innerHTML = '';
        var frag = document.createDocumentFragment();
        for (var i = 0; i < termBuf.length; i++) frag.appendChild(termMakeLine(termBuf[i]));
        termBody.appendChild(frag);
        termBody.scrollTop = termBody.scrollHeight;
    }

    function termSetLive(on, meta) {
        if (termModal) termModal.classList.toggle('live', !!on);
        if (termMeta) termMeta.textContent = meta || (on ? 'running' : 'idle');
    }

    function openTerm() {
        if (!termModal) return;
        termOpen = true;
        termModal.hidden = false;
        if (termBackdrop) termBackdrop.hidden = false;
        termRenderAll();
    }

    function closeTerm() {
        termOpen = false;
        if (termModal) termModal.hidden = true;
        if (termBackdrop) termBackdrop.hidden = true;
    }

    if (termBtn) termBtn.addEventListener('click', function() { termOpen ? closeTerm() : openTerm(); });
    if (termCloseBtn) termCloseBtn.addEventListener('click', closeTerm);
    if (termClearBtn) termClearBtn.addEventListener('click', function() { termBuf = []; if (termBody) termBody.innerHTML = ''; });
    if (termBackdrop) termBackdrop.addEventListener('click', closeTerm);
    // ===== /TERMINAL LIVE =====

    var kaBeaconTimer = null;
    var kaStreamId = null;

    function startKeepaliveBeacon() {
        stopKeepaliveBeacon();
        if (!kaStreamId) return;
        function ping() {
            try { fetch(API_URL + '?action=ka&run_id=' + encodeURIComponent(kaStreamId), { method: 'GET', keepalive: true, cache: 'no-store' }).catch(function(){}); } catch(e) {}
        }
        ping();
        kaBeaconTimer = setInterval(ping, 10000);
    }

    function stopKeepaliveBeacon() {
        if (kaBeaconTimer) clearInterval(kaBeaconTimer);
        kaBeaconTimer = null;
    }

    var tokenCount = 0;

    function updateProgressFromGlobal() {
        var p = window.lastToolProgress;
        if (p && p.label) {
            var key = p.emoji + '|' + p.label + '|' + p.status;
            if (key !== lastProgressKey) {
                lastProgressKey = key;
                showProgress(p.emoji, p.label);
            }
        }
    }

    var typingLines = ["Inisialisasi sistem otak buatan... ⚙️", "Koneksi server berhasil ✅", "Lagi nungguin lu ngetik nih 🥺", "Mau curhat, Gibah, Coding? Sabi lah 💤"];
    var typingContainer = document.getElementById('typing-container');
    var typeLineIdx = 0;
    var typeCharIdx = 0;
    var typeTimeout = null;
    var currentSpan = null;
    var cursorSpan = document.createElement('span');
    cursorSpan.className = 'cursor-blink';
    var currentChars = [];

    function runTypewriter() {
        if (!emptyEl || emptyEl.style.display === 'none') return;
        if (typeLineIdx < typingLines.length) {
            if (typeCharIdx === 0) {
                currentChars = [...typingLines[typeLineIdx]];
                currentSpan = document.createElement('span');
                currentSpan.className = 'typewriter-text';
                if(typingContainer) {
                    typingContainer.appendChild(currentSpan);
                    typingContainer.appendChild(cursorSpan);
                }
            }
            if (typeCharIdx < currentChars.length) {
                currentSpan.innerHTML += currentChars[typeCharIdx];
                typeCharIdx++;
                typeTimeout = setTimeout(runTypewriter, 40);
            } else {
                typeLineIdx++;
                typeCharIdx = 0;
                typeTimeout = setTimeout(runTypewriter, 800);
            }
        } else {
            if(cursorSpan && cursorSpan.parentNode) cursorSpan.remove();
        }
    }

    if (emptyEl && typingContainer) typeTimeout = setTimeout(runTypewriter, 300);

    window.copyCode = function(btn) {
        var pre = btn.closest('.code-wrapper').querySelector('pre');
        var code = pre ? pre.innerText : '';
        copyToClipboard(code).then(function() {
            btn.textContent = '✓ Copied';
            btn.classList.add('copied');
            setTimeout(function() {
                btn.textContent = 'Copy';
                btn.classList.remove('copied');
            }, 2000);
        }).catch(function() {
            btn.textContent = '✗ Gagal';
            setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
        });
    };

    function applyHighlighting() {
        if (typeof hljs !== 'undefined') {
            document.querySelectorAll('pre code:not(.hljs)').forEach(function(block) {
                hljs.highlightElement(block);
            });
        }
    }

    loadStore();
    loadSessionView();

    // Shortcut PWA "Chat Baru" (manifest shortcuts → ./?new=1)
    if (/[?&]new=1\b/.test(window.location.search)) {
        try { window.history.replaceState(null, '', window.location.pathname); } catch(e) {}
        var curS = activeSession();
        if (curS && curS.messages.length) {
            createSession(null);
            loadSessionView();
            renderSessionList();
        }
    }

    function persist() {
        var s = activeSession();
        if (s) {
            s.updatedAt = Date.now();
            if (!s.titleSet) {
                var firstUser = null;
                for (var i = 0; i < s.messages.length; i++) {
                    if (s.messages[i].role === 'user' && s.messages[i].content) {
                        firstUser = s.messages[i].content;
                        break;
                    }
                }
                if (firstUser) {
                    s.title = cleanTitle(firstUser);
                    s.titleSet = true;
                }
            }
        }
        saveStore();
        renderSessionList();
    }

    function md(text){
        if (!text) return '';
        var s = text.replace(/\[\d+\.\d+:\d+\.\d+\]\s*/g, '');
        var codeBlocks = [];

        var ITEM_RE = /^[ \t]*(?:\d+\.|[-*]) /;
        var BULLET_RE = /^[ \t]*[-*] /;
        var NUM_RE = /^[ \t]*\d+\. /;
        var _lines = s.split('\n');
        var _out = [];
        for (var _i = 0; _i < _lines.length; _i++) {
            var _ln = _lines[_i];
            if (/^[ \t]*$/.test(_ln)) {
                var _j = _i + 1;
                while (_j < _lines.length && /^[ \t]*$/.test(_lines[_j])) _j++;
                if (_j < _lines.length && _out.length && ITEM_RE.test(_lines[_j]) && ITEM_RE.test(_out[_out.length - 1])) {
                    var _pt = NUM_RE.test(_out[_out.length - 1]) ? 'n' : (BULLET_RE.test(_out[_out.length - 1]) ? 'b' : 'x');
                    var _nt = NUM_RE.test(_lines[_j]) ? 'n' : (BULLET_RE.test(_lines[_j]) ? 'b' : 'x');
                    if (_pt === _nt && _pt !== 'x') continue;
                }
            }
            _out.push(_ln);
        }
        s = _out.join('\n');
        
        s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, function(match, lang, code) {
            lang = lang || 'text';
            var idx = codeBlocks.length;
            var escapedCode = escapeHTML(code.replace(/^\n+|\n+$/g,''));
            codeBlocks.push('<div class="code-wrapper"><div class="code-header"><span>' + escapeHTML(lang) + '</span><button class="copy-btn" onclick="copyCode(this)">Copy</button></div><pre><code class="language-' + escapeHTML(lang) + '">' + escapedCode + '</code></pre></div>');
            return '\x00CB' + idx + '\x00';
        });

        var inlineCodes = [];
        s = s.replace(/`([^`\n]+)`/g, function(match, code) {
            var idx = inlineCodes.length;
            inlineCodes.push('<code>' + escapeHTML(code) + '</code>');
            return '\x00IC' + idx + '\x00';
        });

        s = escapeHTML(s);
        s = s.replace(/^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)*)/gm, function(match, header, sep, body) {
            var headers = header.split('|').filter(function(c){ return c.trim(); });
            var rows = body.trim().split('\n');
            var html = '<table><thead><tr>';
            headers.forEach(function(h) { html += '<th>' + h.trim() + '</th>'; });
            html += '</tr></thead><tbody>';
            rows.forEach(function(row) {
                var cells = row.split('|').filter(function(c){ return c.trim(); });
                html += '<tr>';
                cells.forEach(function(c) { html += '<td>' + c.trim() + '</td>'; });
                html += '</tr>';
            });
            html += '</tbody></table>';
            return html;
        });

        s = s.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
        s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
        s = s.replace(/^---+$/gm, '<hr>');
        s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
        s = s.replace(/<\/blockquote>\n<blockquote>/g, '<br>');
        s = s.replace(/^ {2,4}[\-\*] (.+)$/gm, '<li class="sub">$1</li>');
        s = s.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
        s = s.replace(/((?:<li(?: class="sub")?>.*?<\/li>\n?)+)/g, function(m) { return '<ul>' + m.replace(/\n/g, '') + '</ul>'; });
        s = s.replace(/<\/ul>(?=[ \t]*\d+\. )/g, '<\/ul>\n');
        s = s.replace(/^ {2,4}\d+\. (.+)$/gm, '<li class="olsub">$1</li>');
        s = s.replace(/^\d+\. (.+)$/gm, '<li class="ol">$1</li>');
        s = s.replace(/((?:<li class="ol(?:sub)?">.*?<\/li>\n?)+)/g, function(m) { return '<ol>' + m.replace(/\n/g, '') + '</ol>'; });
        s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
        s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
        s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        s = s.replace(/\n\n+/g, '</p><p>');
        s = s.replace(/\n/g, '<br>');

        s = s.replace(/(<\/(?:ul|ol|blockquote|h1|h2|h3|h4|hr)>)<br>/g, '$1');
        s = s.replace(/<br><(ul|ol|blockquote|h1|h2|h3|h4|hr)/g, '<$1');
        s = s.replace(/<\/p><p>(<(?:ul|ol|blockquote|h1|h2|h3|h4|hr))/g, '$1');
        s = s.replace(/(<\/(?:ul|ol|blockquote|h1|h2|h3|h4|table)>)<\/p><p>/g, '$1');

        /* ----- Bersihkan <br> nyangkut di dalam list items ----- */
        s = s.replace(/<br>\s*<\/li>/g, '<\/li>');
        s = s.replace(/<li(?: class="[^"]*")?>\s*<br>/g, function(m){ return m.replace(/<br>/g, ''); });
        s = s.replace(/<br>\s*<\/(?:ul|ol)>/g, function(m){ return m.replace(/<br>/g, ''); });

        inlineCodes.forEach(function(code, idx) { s = s.replace('\x00IC' + idx + '\x00', code); });
        codeBlocks.forEach(function(block, idx) { s = s.replace('\x00CB' + idx + '\x00', block); });

        if (!s.startsWith('<')) s = '<p>' + s + '</p>';
        else if (s.indexOf('</p><p>') !== -1 && !s.startsWith('<p')) s = '<p>' + s;
        return s;
    }

    function escapeHTML(str){
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    function checkOverflow(wrap) {
        var textDiv = wrap.querySelector('.msg-text');
        var toggleBtn = wrap.querySelector('.expand-toggle');
        if (!textDiv || !toggleBtn) return;
        textDiv.classList.remove('collapsed');
        if (textDiv.scrollHeight > 300) {
            textDiv.classList.add('collapsed');
            toggleBtn.style.display = 'inline-flex';
            toggleBtn.classList.remove('expanded');
            toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg> Show more';
        } else {
            toggleBtn.style.display = 'none';
        }
    }

    function formatTime(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }

    function renderMessage(role, htmlContent, withAnim, isStreaming, timestamp){
        if (emptyEl) {
            emptyEl.style.display = 'none';
            if (typeTimeout) clearTimeout(typeTimeout);
        }
        var wrap = document.createElement('div');
        wrap.className = 'msg ' + role;
        if (withAnim !== false) wrap.style.animation = 'msgIn 0.3s ease-out';
        var avatarHtml = role === 'user' ? '<div class="msg-avatar-wrap"><div class="msg-avatar">😄</div></div>' : '<div class="msg-avatar-wrap"><span class="ai-name">DEBZ</span><div class="msg-avatar">🤖</div></div>';
        var ts = timestamp || Date.now();
        var timeStr = formatTime(ts);
        var bubbleInner = '<div class="msg-text">' + htmlContent + '</div>' + 
                          '<div class="expand-toggle" style="display:none"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg> Show more</div>';
        var actionsHtml = '';
        if (role === 'assistant' && !isStreaming) {
            actionsHtml = '<div class="msg-actions"><button class="msg-action-btn" onclick="copyMsgText(this)" data-msg-idx="' + (messages.length) + '"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button><button class="msg-action-btn" onclick="regenerateMsg(this)" data-msg-idx="' + (messages.length) + '"><svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Regen</button></div>';
        } else if (role === 'user') {
            actionsHtml = '<div class="msg-actions"><button class="msg-action-btn" onclick="copyMsgText(this)" data-msg-idx="' + (messages.length) + '"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button><button class="msg-action-btn" onclick="editMsg(this)" title="Edit pesan ini"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Edit</button></div>';
        }
        wrap.innerHTML = avatarHtml + '<div class="msg-body"><div class="msg-bubble">' + bubbleInner + '</div>' + actionsHtml + '<div class="msg-timestamp">' + timeStr + '</div></div>';
        var toggleBtn = wrap.querySelector('.expand-toggle');
        var textDiv = wrap.querySelector('.msg-text');
        toggleBtn.addEventListener('click', function() {
            if (textDiv.classList.contains('collapsed')) {
                textDiv.classList.remove('collapsed');
                toggleBtn.classList.add('expanded');
                toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg> Show less';
            } else {
                textDiv.classList.add('collapsed');
                toggleBtn.classList.remove('expanded');
                toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg> Show more';
                wrap.scrollIntoView({behavior: 'smooth', block: 'nearest'});
            }
        });
        if (stream) stream.appendChild(wrap);
        if (!isStreaming) setTimeout(function() { checkOverflow(wrap); }, 50);
        scrollDown();
        return wrap;
    }

    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise(function(resolve, reject) {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.top = '-9999px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
                var ok = document.execCommand('copy');
                document.body.removeChild(ta);
                if (ok) resolve(); else reject(new Error('execCommand copy gagal'));
            } catch (e) {
                document.body.removeChild(ta);
                reject(e);
            }
        });
    }

    window.copyMsgText = function(btn) {
        var msgWrap = btn.closest('.msg');
        var textDiv = msgWrap.querySelector('.msg-text');
        var text = textDiv.innerText || textDiv.textContent;
        copyToClipboard(text).then(function() {
            btn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Copied';
            btn.classList.add('copied');
            setTimeout(function() {
                btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy';
                btn.classList.remove('copied');
            }, 2000);
        }).catch(function() {
            btn.innerHTML = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Error';
            setTimeout(function() { btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy'; }, 2000);
        });
    };

    window.regenerateMsg = function(btn) {
        if (busy) return;
        var idx = parseInt(btn.getAttribute('data-msg-idx'));
        if (isNaN(idx) || idx < 1) return;
        btn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"><animate attributeName="stroke-dasharray" from="0 63" to="63 0" dur="1s" repeatCount="indefinite"/></circle></svg>Regen..';
        btn.disabled = true;
        var lastAssistantIdx = -1;
        for (var i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
                lastAssistantIdx = i;
                break;
            }
        }
        if (lastAssistantIdx === -1) return;
        messages.splice(lastAssistantIdx, 1);
        var allMsgs = stream.querySelectorAll('.msg.assistant');
        if (allMsgs.length) allMsgs[allMsgs.length - 1].remove();
        persist();
        var lastUserMsg = '';
        for (var j = messages.length - 1; j >= 0; j--) {
            if (messages[j].role === 'user') {
                lastUserMsg = messages[j].content;
                break;
            }
        }
        if (lastUserMsg && form) {
            input.value = lastUserMsg;
            form.dispatchEvent(new Event('submit'));
        }
    };

    /* ==================== EDIT PESAN USER ==================== */
    var editBackup = null;

    window.editMsg = function(btn) {
        if (busy) { showToast('Tungguin Debz kelar jawab dulu..'); return; }
        var wrap = btn.closest('.msg');
        if (!wrap || !stream) return;
        // Posisi .msg di stream === index di array messages (1:1, di-render berurutan)
        var idx = Array.prototype.indexOf.call(stream.querySelectorAll('.msg'), wrap);
        if (idx < 0 || !messages[idx] || messages[idx].role !== 'user') return;
        var raw = String(messages[idx].content || '');
        // buang preview attachment (format baru & legacy) — cuma teksnya yang balik ke input
        raw = raw.replace(/<div style="display: flex; gap: 6px;[\s\S]*<\/div>\s*$/i, '');
        raw = raw.replace(/<div style="width: 70px;[\s\S]*?<\/div>/g, '');
        raw = raw.replace(/<div style="background: rgba\(0,0,0,0\.2\);[\s\S]*?<\/div>/g, '');
        raw = raw.replace(/\s+$/, '').trim();
        if (editBackup) { cancelEdit(true); }
        editBackup = { sessionId: activeSessionId, idx: idx, removed: messages.splice(idx), original: raw };
        persist();
        loadSessionView();
        if (composerWrap) composerWrap.classList.add('editing');
        if (input) {
            input.value = raw;
            input.focus();
            try { input.setSelectionRange(input.value.length, input.value.length); } catch(e) {}
            input.dispatchEvent(new Event('input'));
        }
        showToast('Mode edit aktif — benerin teksnya, kirim ulang. Esc = batal.', 3500);
    };

    function cancelEdit(silent) {
        if (!editBackup) return;
        var b = editBackup;
        editBackup = null;
        var s = getSession(b.sessionId);
        if (s && s.messages.length === b.idx) {
            s.messages = s.messages.concat(b.removed);
            if (b.sessionId === activeSessionId) {
                messages = s.messages;
                loadSessionView();
            }
            persist();
        }
        if (composerWrap) composerWrap.classList.remove('editing');
        if (input) {
            input.value = '';
            input.dispatchEvent(new Event('input'));
            resetInputHeight();
        }
        if (!silent) showToast('Edit dibatalin, pesan balik kayak semula.');
    }

    function scrollDown(force) {
        if (!stream) return;
        var threshold = 80;
        var isAtBottom = (stream.scrollHeight - stream.scrollTop - stream.clientHeight) <= threshold;
        if (force || isAtBottom) {
            stream.scrollTop = stream.scrollHeight;
        }
    }

    function setBusy(state){
        busy = state;
        termSetLive(state, state ? 'running' : 'idle');
        if (input) input.disabled = state;
        if (state) {
            if (sendArrow) sendArrow.style.display = 'none';
            if (sendLoader) sendLoader.style.display = 'flex';
        } else {
            if (sendArrow) sendArrow.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
            if (sendArrow) sendArrow.style.display = 'inline-block';
            if (sendLoader) sendLoader.style.display = 'none';
        }
    }

    function resetInputHeight() {
        if (!input) return;
        input.style.height = '42px';
        input.style.overflowY = 'hidden';
        if (composerWrap) composerWrap.style.borderRadius = '30px';
    }

    function updateCharCount() {
        if (!charCountEl || !input) return;
        var len = input.value.length;
        if (len === 0) {
            charCountEl.textContent = '';
            charCountEl.className = 'char-count';
        } else {
            charCountEl.textContent = len + ' / ' + MAX_CHARS;
            if (len > MAX_CHARS * 0.9) charCountEl.className = 'char-count danger';
            else if (len > MAX_CHARS * 0.75) charCountEl.className = 'char-count warn';
            else charCountEl.className = 'char-count';
        }
    }

    if (input) {
        input.addEventListener('input', function(){
            this.style.height = '42px';
            var newHeight = Math.min(this.scrollHeight, 150);
            this.style.height = newHeight + 'px';
            if (this.scrollHeight > 50) {
                if (composerWrap) composerWrap.style.borderRadius = '20px';
            } else {
                if (composerWrap) composerWrap.style.borderRadius = '30px';
            }
            if (this.scrollHeight > 150) {
                this.style.overflowY = 'auto';
            } else {
                this.style.overflowY = 'hidden';
            }
            updateCharCount();
        });
        input.addEventListener('keydown', function(e) {
            var isMobile = window.innerWidth <= 768;
            if (e.key === 'Enter' && !e.shiftKey) {
                if (!isMobile && form) {
                    e.preventDefault(); 
                    form.dispatchEvent(new Event('submit'));
                }
            }
        });
    }

    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', function() { fileInput.click(); });
        fileInput.addEventListener('change', function() {
            if (this.files && this.files.length > 0) {
                for (var i = 0; i < this.files.length; i++) {
                    selectedFiles.push(this.files[i]);
                }
                renderAttachmentPreviews();
                fileInput.value = '';
            }
        });
    }

    function renderAttachmentPreviews() {
        if (!attachmentPreview) return;
        if (selectedFiles.length === 0) {
            attachmentPreview.style.display = 'none';
            attachmentPreview.innerHTML = '';
            return;
        }
        attachmentPreview.style.display = 'flex';
        var html = '';
        selectedFiles.forEach(function(file, index) {
            var isImage = file.type.startsWith('image/');
            if (isImage) {
                var objectUrl = URL.createObjectURL(file);
                html += '<div style="position: relative; width: 60px; height: 60px; border-radius: 8px; overflow: hidden; border: 1px solid #333; flex-shrink: 0;"><img src="' + objectUrl + '" style="width: 100%; height: 100%; object-fit: cover;"><button type="button" onclick="removeAttachment(' + index + ')" style="position: absolute; top: 2px; right: 2px; background: rgba(0,0,0,0.7); color: #fff; border: none; border-radius: 50%; width: 18px; height: 18px; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center;">✕</button></div>';
            } else {
                html += '<div style="position: relative; display: flex; align-items: center; gap: 6px; background: #222; padding: 6px 10px; border-radius: 8px; border: 1px solid #333; font-size: 12px; color: #fff; flex-shrink: 0;"><span>📄 ' + escapeHTML(file.name) + '</span><button type="button" onclick="removeAttachment(' + index + ')" style="background: transparent; color: #aaa; border: none; cursor: pointer; font-size: 14px;">✕</button></div>';
            }
        });
        attachmentPreview.innerHTML = html;
    }

    window.removeAttachment = function(index) {
        selectedFiles.splice(index, 1);
        renderAttachmentPreviews();
    };

    if (form) {
        form.addEventListener('submit', async function(e){
            e.preventDefault();
            if (busy) return;
            var text = input ? input.value.trim() : '';
            if (!text && selectedFiles.length === 0) return;
            if (text.length > MAX_CHARS) {
                showToast('Terlalu panjang! Max ' + MAX_CHARS + ' karakter.');
                return;
            }
            // Edit mode aktif → pesan lama udah kehapus dari history.
            // Bersihin backup & tanda editing, lalu kirim sebagai pesan baru.
            if (editBackup) {
                editBackup = null;
                if (composerWrap) composerWrap.classList.remove('editing');
            }
            var filesToSend = [...selectedFiles];
            var localPreviews = filesToSend.map(function(file) {
                return { isImage: file.type.startsWith('image/'), url: URL.createObjectURL(file), name: file.name };
            });
            if (input) input.value = '';
            resetInputHeight();
            updateCharCount();
            selectedFiles = [];
            renderAttachmentPreviews();

            var ts = Date.now();
            var displayContent = text;
            if (localPreviews.length > 0) {
                displayContent += '<div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px;">';
                localPreviews.forEach(function(item) {
                    if (item.isImage) {
                        displayContent += '<div style="width: 70px; height: 70px; border-radius: 6px; overflow: hidden; border: 1px solid rgba(255,255,255,0.2); flex-shrink: 0;"><img src="' + item.url + '" style="width: 100%; height: 100%; object-fit: cover;"></div>';
                    } else {
                        displayContent += '<div style="background: rgba(0,0,0,0.2); padding: 4px 8px; border-radius: 4px; font-size: 11px;">📄 ' + escapeHTML(item.name) + '</div>';
                    }
                });
                displayContent += '</div>';
            }
            messages.push({ role: 'user', content: displayContent, timestamp: ts });
            renderMessage('user', displayContent, true, false, ts);
            persist();

            var placeholder = renderMessage('assistant', '<div style="display: flex; align-items: center; gap: 8px;"><div class="typing-indicator"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div><span style="font-size: 11px; color: #86868b; font-style: italic;">Tungguin ya! lagi mikir 🤔...</span></div>', true, true);
            var assistantIndex = messages.length;
            messages.push({ role: 'assistant', content: '', timestamp: ts });

                        setBusy(true);
            lastProgressKey = '';
            approvalCards = [];
            abortController = new AbortController();

            try {
                var systemPrompt = "You are a precise, concise, and helpful AI assistant. MANDATORY RULE: Always provide a brief acknowledgment, validation, or conversational opening response before executing any heavy tasks, writing code, or providing final answers. Never jump straight into raw execution on the first sentence. Format all responses using clean, structured Markdown, use bullet points for lists, and wrap all code or scripts in proper code blocks.";
                var formData = new FormData();
                kaStreamId = 'ka' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                formData.append('ka_id', kaStreamId);
                var historyPayload = [{ role: 'system', content: systemPrompt }].concat(
                    messages.slice(0, assistantIndex).map(function(m){
                        var row = { role: m.role, content: m.content };
                        // Round-trip reasoning_details (thinking models) — assistant bawa jejak mikirnya
                        if (m.role === 'assistant' && m.reasoning_details && m.reasoning_details.length) {
                            row.reasoning_details = m.reasoning_details;
                        }
                        return row;
                    })
                );
                formData.append('messages', JSON.stringify(historyPayload));
                formData.append('prompt', text);
                formData.append('max_tokens', 10000000);
                formData.append('tools', toolsOn ? '1' : '0');
                formData.append('approval_session', approvalSession ? '1' : '0');
                if (activeProviderId) formData.append('provider_id', activeProviderId);
                
                filesToSend.forEach(function(file) { formData.append('images[]', file); });

                termLog('info', '▶ kirim pesan ke agent');
                var response = await fetch(API_URL, {
                    method: 'POST',
                    signal: abortController.signal,
                    body: formData
                });

                if (!response.ok) {
                    if (window.__clientLog) window.__clientLog('error', 'chat fetch HTTP ' + response.status, { statusText: response.statusText });
                    placeholder.querySelector('.msg-text').innerHTML = '<span style="color:#fca5a5;">⚠️ HTTP Error ' + response.status + ' - ' + response.statusText + '</span>';
                    messages[assistantIndex].content = '[error] HTTP ' + response.status;
                    persist();
                    hideProgress();
                    setBusy(false);
                    return;
                }

                var reader = response.body.getReader();
                var decoder = new TextDecoder("utf-8");
                var fullContent = '';
                var rdItems = []; // reasoning_details merged (round-trip ke request berikutnya)
                var bubbleText = placeholder.querySelector('.msg-text');
                bubbleTextRef = bubbleText;
                var buffer = '';
                var doneReceived = false;
                var currentStreamRunId = '';

                // Resume: kalau stream putus sebelum [DONE], polling status run
                // di gateway sampai kelar — jawaban gak ilang cuma gara2 koneksi.
                function finalizeFromResume(text) {
                    if (!text) text = '';
                    fullContent = text;
                    var tempContent = fullContent;
                    var fences = (tempContent.match(/```/g) || []).length;
                    if (fences % 2 !== 0) tempContent += '\n```';
                    bubbleText.innerHTML = md(tempContent);
                    if (rdItems.length) renderRDBox(bubbleText, rdItems);
                    messages[assistantIndex].content = fullContent;
                    if (rdItems.length) messages[assistantIndex].reasoning_details = rdItems;
                    messages[assistantIndex].timestamp = Date.now();
                    persist();
                    checkOverflow(placeholder);
                    var msgBody = placeholder.querySelector('.msg-body');
                    if (msgBody && !msgBody.querySelector('.msg-actions')) {
                        var actionsHtml = '<div class="msg-actions"><button class="msg-action-btn" onclick="copyMsgText(this)" data-msg-idx="' + assistantIndex + '"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button><button class="msg-action-btn" onclick="regenerateMsg(this)" data-msg-idx="' + assistantIndex + '"><svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Regen</button></div>';
                        msgBody.insertAdjacentHTML('beforeend', actionsHtml);
                    }
                    hideProgress();
                }

                function resumeFromRunStatus(reasonLabel) {
                    var rid = currentStreamRunId;
                    if (!rid) return Promise.resolve(false);
                    showProgress('🔌', reasonLabel || 'nyambungin ulang...');
                    startElapsed();
                    return new Promise(function(resolve) {
                        var attempts = 0;
                        var maxAttempts = 450; // ~30 menit @ 4s
                        var timer = setInterval(function() {
                            attempts++;
                            if (attempts > maxAttempts || !currentStreamRunId) {
                                clearInterval(timer);
                                stopElapsed();
                                resolve(false);
                                return;
                            }
                            fetch(API_URL + '?action=run_status&run_id=' + encodeURIComponent(rid), { cache: 'no-store' })
                                .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                                .then(function(st) {
                                    var s = st && st.status;
                                    if (s === 'completed') {
                                        clearInterval(timer);
                                        stopElapsed();
                                        stopKeepaliveBeacon();
                                        finalizeFromResume(st.output || '');
                                        if (st.usage && st.usage.total_tokens > 0) {
                                            tokenCounter.textContent = st.usage.total_tokens + ' tokens';
                                        }
                                        showToast('✅ Jawaban ke-resume setelah koneksi putus');
                                        resolve(true);
                                    } else if (s === 'failed' || s === 'cancelled') {
                                        clearInterval(timer);
                                        stopElapsed();
                                        stopKeepaliveBeacon();
                                        finalizeFromResume((fullContent ? fullContent + '\n\n' : '') + (s === 'failed' ? '⚠️ Run gagal: ' + (st.error || 'unknown') : '⚠️ Run dibatalkan.'));
                                        resolve(true);
                                    } else if (s === 'waiting_for_approval') {
                                        showProgress('⏳', 'Nunggu');
                                    } else if (attempts % 8 === 0) {
                                        showProgress('🔌', 'Stream putus — nunggu agent kelar (resume otomatis)...');
                                    }
                                })
                                .catch(function() {
                                    if (attempts % 15 === 0) showProgress('🔌', 'Resume: gateway belum bisa dihubungi, coba lagi...');
                                });
                        }, 4000);
                    });
                }


                showProgress('🤔', 'Mikir dulu...');
                startElapsed();
                startKeepaliveBeacon();

                while (true) {
                    var result = await reader.read();
                    if (result.done) break;

                    buffer += decoder.decode(result.value, { stream: true });
                    var lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (!line) continue;
                        if (line === ': ka') continue;
                        if (line === '[DONE]') { doneReceived = true; continue; }
                        if (line.startsWith('data:')) line = line.substring(5).trim();

                        try {
                            var parsed = JSON.parse(line);

                            if (parsed.error) {
                                var errMsgAPI = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error));
                                fullContent += "\n\n⚠️ **API Error:** " + errMsgAPI;
                                bubbleText.innerHTML = md(fullContent);
                                scrollDown();
                                continue;
                            }

                            if (parsed.type === 'run_started') {
                                currentStreamRunId = parsed.run_id || '';
                                continue;
                            }
                            if (parsed.type === 'terminal') {
                                termLog(parsed.kind, parsed.line);
                                continue;
                            }
                            if (parsed.type === 'reasoning') {
                                // reasoning_details (thinking models) — merge per index,
                                // tampilin kolapsible 💭 + simpen buat round-trip request berikutnya
                                (parsed.items || []).forEach(function(it) {
                                    var k = it.index || 0;
                                    var found = null;
                                    for (var ri = 0; ri < rdItems.length; ri++) {
                                        if ((rdItems[ri].index || 0) === k) { found = rdItems[ri]; break; }
                                    }
                                    if (!found) { found = { type: it.type || 'reasoning.text', index: k }; rdItems.push(found); }
                                    if (it.text) found.text = (found.text || '') + it.text;
                                    if (it.data) found.data = (found.data || '') + it.data;
                                    if (it.format) found.format = it.format;
                                });
                                if (rdItems.length) renderRDBox(bubbleText, rdItems);
                                continue;
                            }
                            if (parsed.type === 'status') {
                                if (parsed.phase === 'thinking') showProgress('🧠', 'Mikir' + (parsed.iter ? ' · iter ' + parsed.iter : ''));
                                else if (parsed.phase === 'writing') showProgress('✍️', 'Nulis');
                                continue;
                            }
                            if (parsed.type === 'tool') {
                                if (parsed.phase === 'start') {
                                    showProgress('🛠️', (parsed.name || 'Tool') + (parsed.detail ? ': ' + parsed.detail : ''));
                                } else if (parsed.phase === 'result' && parsed.summary) {
                                    showProgress('☀️', (parsed.name || 'Tool') + ' · ' + parsed.summary);
                                }
                                continue;
                            }
                            if (parsed.type === 'approval') {
                                showApprovalCard(parsed);
                                continue;
                            }
                            if (parsed.type === 'approval_done') {
                                markApprovalDone(parsed.choice, parsed.run_id, !!parsed.auto);
                                continue;
                            }
                            if (parsed.type === 'usage') {
                                if (parsed.total_tokens > 0) {
                                    tokenCount = parsed.total_tokens;
                                    tokenCounter.textContent = tokenCount + ' tokens';
                                }
                                continue;
                            }

                            if (parsed.status || parsed.progress) {
                                showProgress(parsed.emoji || '⚙️', parsed.status || parsed.progress);
                                continue;
                            }

                            if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.tool_calls) {
                                var toolName = parsed.choices[0].delta.tool_calls[0].function.name;
                                if (toolName) showProgress('🛠️', '📢 ' + toolName);
                            }
                            
                            var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                            var piece = (delta && delta.content) || (parsed.message && parsed.message.content) || parsed.response || (parsed.choices && parsed.choices[0] && parsed.choices[0].text) || '';
                            
                            if (piece) {
                                fullContent += piece;
                                var tempContent = fullContent;
                                var matches = tempContent.match(/```/g);
                                if (matches && matches.length % 2 !== 0) tempContent += '\n```';
                                bubbleText.innerHTML = md(tempContent);
                                if (rdItems.length) renderRDBox(bubbleText, rdItems);
                                scrollDown();
                            }
                        } catch(e) {}
                    }
                }
                stopElapsed();
                stopKeepaliveBeacon();
                termLog('ok', '✔ stream kelar · ' + tokenCount + ' tokens');

                // Stream berakhir TANPA [DONE] → kemungkinan koneksi beneran putus.
                // Kalau kita punya run_id, resume via polling status — bukan drama "gak ada balesan".
                if (!doneReceived && currentStreamRunId) {
                    var resumed = await resumeFromRunStatus();
                    if (resumed) {
                        abortController = null;
                        setBusy(false);
                        lastProgressKey = '';
                        if (window.innerWidth > 600 && input) input.focus();
                        return;
                    }
                }

                if (!fullContent && !doneReceived) fullContent = "⚠️ Maaf, Gak ada balesan..";

                if (!fullContent && doneReceived) {
                    fullContent = "⚠️ Provider balikin jawaban kosong (kemungkinan model cuma ngerjain reasoning tanpa output).\n\nCoba kirim ulang pesan lu — kalau masih kayak gini, ganti model di ⚙️ Settings.";
                    if (window.__clientLog) window.__clientLog('warn', 'empty reply but [DONE] received', null);
                }

                if (!doneReceived && fullContent && fullContent.indexOf('⚠️') !== 0) {
                    // footer otomatis DIMATIKAN: fullContent += ...;
                } else if (doneReceived && !fullContent) {
                    fullContent = fullContent || '⚠️ Maaf, Gak ada balesan..';
                }
                bubbleText.innerHTML = md(fullContent);
                if (rdItems.length) renderRDBox(bubbleText, rdItems);
                if (approvalCards.length) {
                    approvalCards.forEach(function(c) { bubbleText.appendChild(c); });
                }
                messages[assistantIndex].content = fullContent;
                if (rdItems.length) messages[assistantIndex].reasoning_details = rdItems;
                messages[assistantIndex].timestamp = Date.now();
                persist();
                checkOverflow(placeholder);

                var msgBody = placeholder.querySelector('.msg-body');
                if (msgBody && !msgBody.querySelector('.msg-actions')) {
                    var actionsHtml = '<div class="msg-actions"><button class="msg-action-btn" onclick="copyMsgText(this)" data-msg-idx="' + assistantIndex + '"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button><button class="msg-action-btn" onclick="regenerateMsg(this)" data-msg-idx="' + assistantIndex + '"><svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Regen</button></div>';
                    msgBody.insertAdjacentHTML('beforeend', actionsHtml);
                }
                hideProgress();
                
            } catch(err) {
                console.error(err);
                if (window.__clientLog) window.__clientLog('error', 'stream error: ' + (err && err.message ? err.message : String(err)), { name: err && err.name ? err.name : '' });
                stopElapsed();
                var errDetail = err.message ? err.message : String(err);
                if (err.name === 'AbortError') {
                    termLog('info', '⏹ stream dibatalkan user');
                    var currentSavedText = fullContent ? fullContent + '\n\n*(Dibatalkan)*' : '\n\n*(Dibatalkan)*';
                    placeholder.querySelector('.msg-text').innerHTML = md(currentSavedText);
                    messages[assistantIndex].content = currentSavedText;
                    persist();
                } else {
                    // Network error di tengah stream? Coba resume via run_status dulu
                    if (currentStreamRunId) {
                        var resumedErr = await resumeFromRunStatus('Koneksi error — resume otomatis...');
                        if (resumedErr) {
                            abortController = null;
                            setBusy(false);
                            lastProgressKey = '';
                            if (window.innerWidth > 600 && input) input.focus();
                            return;
                        }
                    }
                    var errText = fullContent ? fullContent + '\n\n⚠️ Error: ' + errDetail : '⚠️ Error: ' + errDetail;
                    placeholder.querySelector('.msg-text').innerHTML = md(errText);
                    if (approvalCards.length) {
                        approvalCards.forEach(function(c) { placeholder.querySelector('.msg-text').appendChild(c); });
                    }
                    messages[assistantIndex].content = errText;
                    persist();
                }
                hideProgress();
            } finally {
                abortController = null;
                stopKeepaliveBeacon();
                setBusy(false);
                lastProgressKey = '';
                if(window.innerWidth > 600 && input) input.focus();
            }
        });
    }

    if (clearBtn) {
        // tombol header lama udah pindah ke sidebar — listener clear udah dipasang
        // via querySelectorAll('.clear-btn') di atas. Ini no-op kalau elemen gak ada.
    }

    if (sendBtn) {
        sendBtn.addEventListener('click', function(e) {
            if (busy && abortController) {
                e.preventDefault();
                abortController.abort();
            }
        });
    }

    document.querySelectorAll('.suggestion-chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
            if (input) input.value = this.textContent;
            if (input) input.focus();
            updateCharCount();
            if (form) form.dispatchEvent(new Event('submit'));
        });
    });

    /* ==================== UI v2: Provider / Settings / Tools / Compact ==================== */

    var toolsOn = true;
    var activeProviderId = '';
    var providerData = null;
    var toolsBtn = document.getElementById('tools-toggle');
    var providerBtn = document.getElementById('provider-btn');
    var providerPop = document.getElementById('provider-pop');
    var providerListEl = document.getElementById('provider-list');
    var compactBtn = document.getElementById('compact-btn');
    var settingsBtn = document.getElementById('settings-btn');
    var settingsPanel = document.getElementById('settings-panel');
    var settingsBackdrop = document.getElementById('settings-backdrop');
    var settingsCloseBtn = document.getElementById('settings-close');
    var settingsProvidersEl = document.getElementById('settings-providers');
    var settingsAddBtn = document.getElementById('settings-add');
    var statusTextEl = document.querySelector('.status-text');

    // ===== Tools toggle =====
    function renderToolsBtn() {
        if (!toolsBtn) return;
        toolsBtn.classList.toggle('on', toolsOn);
        toolsBtn.title = toolsOn ? 'Agent Tools ON (shell, file, search) — klik buat OFF' : 'Agent Tools OFF — klik buat ON';
    }
    if (toolsBtn) {
        toolsBtn.addEventListener('click', function() {
            toolsOn = !toolsOn;
            renderToolsBtn();
            updateStatusText();
            showToast(toolsOn ? '⚡ Tools ON — agent bisa shell/file/search' : '💤 Tools OFF — mode chat biasa', 2200);
        });
        renderToolsBtn();
    }

    // ===== Allow All toggle (auto-approve perintah berbahaya, persist) =====
    var allowAllBtn = document.getElementById('allowall-toggle');
    var allowAllOn = false;
    function renderAllowAllBtn() {
        if (!allowAllBtn) return;
        allowAllBtn.classList.toggle('on', allowAllOn);
        allowAllBtn.title = allowAllOn
            ? 'Allow All ON — semua perintah berbahaya auto-approve tanpa nanya. Klik buat OFF.'
            : 'Allow All OFF — perintah berbahaya minta approval dulu. Klik buat ON.';
    }
    if (allowAllBtn) {
        fetch(API_URL + '?action=approval_mode', { cache: 'no-store' })
            .then(function(r) { return r.json(); })
            .then(function(d) { allowAllOn = !!(d && d.always); renderAllowAllBtn(); })
            .catch(function() {});
        allowAllBtn.addEventListener('click', function() {
            var next = !allowAllOn;
            fetch(API_URL + '?action=approval_mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ always: next })
            }).then(function(r) { return r.json(); }).then(function(d) {
                if (d && d.success) {
                    allowAllOn = !!d.always;
                    renderAllowAllBtn();
                    showToast(allowAllOn ? '🔓 Allow All ON — gak ada approval lagi' : '🔒 Allow All OFF — approval normal', 2200);
                } else showToast('❌ ' + ((d && d.error) || 'gagal'));
            }).catch(function() { showToast('❌ gagal set allow-all'); });
        });
    }

    // ===== Provider load & switch =====
    function fetchProviders(cb) {
        fetch(API_URL + '?action=providers', { cache: 'no-store' })
            .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function(d) {
                if (d && d.providers) {
                    providerData = d;
                    activeProviderId = d.active || activeProviderId;
                    cb && cb();
                }
            })
            .catch(function(e) {
                console.warn('providers load gagal:', e);
            });
    }

    function updateStatusText() {
        if (!statusTextEl || !providerData) return;
        var p = providerData.providers[activeProviderId];
        if (!p) return;
        // header biarkan default dari index.php (gak dinimpa status tools)
        var sbStatus = document.getElementById('sidebar-status');
        if (sbStatus) {
            sbStatus.innerHTML = '<b>' + escapeHTML(p.name || '?') + '</b><br>'
                + 'Model: ' + escapeHTML(p.model || '?') + '<br>'
                + 'Mode: ' + escapeHTML(p.mode || 'chat') + (toolsOn ? ' · ⚡ tools aktif' : ' · 💤 tools off');
        }
    }

    // routing: fixed | roundrobin | failover (mode pemilihan provider)
    function setRouting(mode, doneCb) {
        fetch(API_URL + '?action=providers', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'routing', routing: mode })
        }).then(function(r) { return r.json(); }).then(function(d) {
            if (d.success) {
                if (providerData) providerData.routing = mode;
                showToast('🔀 Routing: ' + ({fixed:'Fixed (manual)', roundrobin:'Round-Robin (ganti tiap request)', failover:'Failover (aktif → cadangan)'})[mode]);
                doneCb && doneCb();
            } else showToast('❌ ' + (d.error || 'gagal'));
        }).catch(function() { showToast('❌ gagal set routing'); });
    }

    function renderProviderPop() {
        if (!providerListEl || !providerData) return;
        var rt = providerData.routing || 'fixed';
        var html = '<div class="routing-row">'
            + '<div class="routing-label">🔀 ROUTING</div>'
            + '<div class="routing-opts">'
            + '<button type="button" class="routing-opt' + (rt === 'fixed' ? ' on' : '') + '" data-rt="fixed">📌 Fixed</button>'
            + '<button type="button" class="routing-opt' + (rt === 'roundrobin' ? ' on' : '') + '" data-rt="roundrobin">🔁 Round-Robin</button>'
            + '<button type="button" class="routing-opt' + (rt === 'failover' ? ' on' : '') + '" data-rt="failover">🪂 Failover</button>'
            + '</div></div>';
        var enCount = 0;
        Object.keys(providerData.providers).forEach(function(id) { if (providerData.providers[id].enabled !== false) enCount++; });
        html += '<div class="routing-hint">' + (rt === 'fixed'
            ? 'Pake provider pilihan lu (klik di bawah).'
            : rt === 'roundrobin'
                ? 'Ganti provider otomatis tiap request (' + enCount + ' aktif) + pindah kalau error.'
                : 'Mulai dari pilihan lu, otomatis pindah kalau error/limit.') + '</div>';
        Object.keys(providerData.providers).forEach(function(id) {
            var p = providerData.providers[id];
            var act = id === activeProviderId;
            var dis = p.enabled === false;
            var mCnt = p.models_count || (p.models ? p.models.length : 0);
            html += '<button type="button" class="provider-item' + (act ? ' active' : '') + (dis ? ' disabled' : '') + '" data-pid="' + escapeHTML(id) + '"'
                + (dis ? ' title="Provider ini OFF (disabled)"' : '') + '>'
                + '<div style="flex:1">'
                + '<div class="p-name">' + (dis ? '⚪ ' : '') + escapeHTML(p.name || id) + '</div>'
                + '<div class="p-meta">' + escapeHTML(p.model || 'model?') + (mCnt ? ' · 📂 ' + mCnt + ' model' : '') + '</div>'
                + '</div>'
                + '<span class="p-badge">' + escapeHTML(p.mode || 'chat') + '</span>'
                + '</button>';
        });
        providerListEl.innerHTML = html;
    }

    function refreshProviderUI() {
        renderProviderPop();
        updateStatusText();
    }

    if (providerBtn && providerPop) {
        providerBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            providerPop.hidden = !providerPop.hidden;
            if (!providerPop.hidden) {
                fetchProviders(refreshProviderUI);
            }
        });
        document.addEventListener('click', function(e) {
            if (!providerPop.hidden && !providerPop.contains(e.target) && e.target !== providerBtn) {
                providerPop.hidden = true;
            }
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') providerPop.hidden = true;
        });
    }
    if (providerListEl) {
        providerListEl.addEventListener('click', function(e) {
            // routing options row
            var rtBtn = e.target.closest ? e.target.closest('.routing-opt') : null;
            if (rtBtn) {
                var rtMode = rtBtn.getAttribute('data-rt');
                if (rtMode === (providerData && providerData.routing)) { return; }
                setRouting(rtMode, function() {
                    renderProviderPop();
                    updateStatusText();
                });
                return;
            }
            var btn = e.target.closest ? e.target.closest('.provider-item') : null;
            if (!btn) return;
            if (btn.classList.contains('disabled')) {
                showToast('⚪ Provider ini OFF — aktifin dulu di ⚙️ Settings');
                return;
            }
            var id = btn.getAttribute('data-pid');
            if (!id || id === activeProviderId) { providerPop.hidden = true; return; }
            fetch(API_URL + '?action=providers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ op: 'activate', id: id })
            }).then(function(r) { return r.json(); }).then(function(d) {
                if (d.success) {
                    activeProviderId = id;
                    fetchProviders(function() {
                        refreshProviderUI();
                        var p = providerData.providers[id];
                        showToast('✅ Ganti ke ' + (p ? p.name : id) + ' (' + (p ? p.model : '') + ')');
                    });
                } else {
                    showToast('❌ Gagal: ' + (d.error || 'unknown'));
                }
            }).catch(function() { showToast('❌ Gagal ganti provider'); });
            providerPop.hidden = true;
        });
    }

    // ===== Settings panel (CRUD provider) =====
    function settingsOpen() {
        if (settingsPanel) settingsPanel.hidden = false;
        if (settingsBackdrop) settingsBackdrop.hidden = false;
        renderSettingsProviders();
    }
    function settingsClose() {
        if (settingsPanel) settingsPanel.hidden = true;
        if (settingsBackdrop) settingsBackdrop.hidden = true;
    }
    if (settingsBtn) settingsBtn.addEventListener('click', settingsOpen);
    if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', settingsClose);
    if (settingsBackdrop) settingsBackdrop.addEventListener('click', settingsClose);
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && settingsPanel && !settingsPanel.hidden) settingsClose();
    });

    function providerCardHtml(id, p, isActive) {
        var cls = 'provider-card' + (isActive ? ' active' : '') + (p.enabled === false ? ' off' : '');
        var mCnt = p.models_count || (p.models ? p.models.length : 0);
        return '<div class="' + cls + '" data-pcid="' + escapeHTML(id) + '">'
            + '<div class="pc-head">'
            + '<div class="pc-name">' + (isActive ? '🟢 ' : '') + escapeHTML(p.name || id)
            + (isActive ? ' <span style="font-size:10px;color:#34c759;">(aktif)</span>' : '')
            + (p.enabled === false ? ' <span style="font-size:10px;color:#636366;">(OFF)</span>' : '')
            + '</div>'
            + '<div class="pc-actions">'
            + '<label class="pc-switch" title="' + (p.enabled === false ? 'Aktifin provider ini' : 'Matiin provider ini') + '">'
            + '<input type="checkbox" data-act="toggle" data-id="' + escapeHTML(id) + '"' + (p.enabled === false ? '' : ' checked') + '>'
            + '<span class="pc-slider"></span>'
            + '</label>'
            + (isActive ? '' : '<button type="button" data-act="activate" data-id="' + escapeHTML(id) + '">Pakai</button>')
            + '<button type="button" data-act="edit" data-id="' + escapeHTML(id) + '">Edit</button>'
            + '<button type="button" data-act="del" data-id="' + escapeHTML(id) + '" class="danger">Hapus</button>'
            + '</div>'
            + '</div>'
            + '<div class="pc-info" style="font-size:11px;color:#86868b;line-height:1.7">'
            + 'Endpoint: ' + escapeHTML(p.base_url || '-') + '<br>'
            + 'Model: <b style="color:#d1d1d6">' + escapeHTML(p.model || '-') + '</b> · Mode: ' + escapeHTML(p.mode || 'chat')
            + ' · Key: ' + escapeHTML(p.key_hint || (p.has_key ? 'tersimpan' : 'KOSONG!'))
            + (mCnt ? ' · 📂 <b style="color:#0a84ff">' + mCnt + ' model</b>' : ' · 📂 belum ada list')
            + ((p.extra && p.extra.reasoning && p.extra.reasoning.enabled) ? ' · 🧠 reasoning' : '')
            + ((p.extra && p.extra.user_agent) ? ' · UA: ' + escapeHTML(String(p.extra.user_agent).slice(0, 24)) : '')
            + '</div>'
            + '<div class="pc-row-extra">'
            + '<button type="button" class="pc-mini" data-act="fetchmodels" data-id="' + escapeHTML(id) + '">🔄 Ambil List Model</button>'
            + '<button type="button" class="pc-mini" data-act="pickmodel" data-id="' + escapeHTML(id) + '"' + (mCnt ? '' : ' disabled') + '>📂 Ganti Model</button>'
            + '</div>'
            + '<div class="pc-model-drop" data-mdrop="' + escapeHTML(id) + '" hidden></div>'
            + '<div class="pc-test-result" data-testid="' + escapeHTML(id) + '"></div>'
            + '</div>';
    }

    function renderSettingsProviders() {
        if (!settingsProvidersEl) return;
        fetchProviders(function() {
            if (!providerData) {
                settingsProvidersEl.innerHTML = '<div style="color:#ff6961;font-size:12px;">Gagal load providers</div>';
                return;
            }
            var html = '';
            Object.keys(providerData.providers).forEach(function(id) {
                html += providerCardHtml(id, providerData.providers[id], id === activeProviderId);
            });
            settingsProvidersEl.innerHTML = html || '<div style="color:#86868b;font-size:12px;">Belum ada provider. Tambahin dong!</div>';
        });
    }

    // form edit/tambah (inline di card)
    function providerFormHtml(id, p) {
        p = p || { name: '', base_url: '', model: '', mode: 'native', key_hint: '', has_key: false, extra: {} };
        var re = (p.extra && p.extra.reasoning_effort) ? String(p.extra.reasoning_effort) : '';
        var rdOn = (p.extra && p.extra.reasoning && p.extra.reasoning.enabled === true) ? 'on' : ((p.extra && p.extra.reasoning && p.extra.reasoning.enabled === false) ? 'off' : '');
        var uaV = (p.extra && p.extra.user_agent) ? String(p.extra.user_agent) : '';
        var xtraObj = {};
        if (p.extra) Object.keys(p.extra).forEach(function(k) {
            if (k !== 'reasoning_effort' && k !== 'reasoning' && k !== 'user_agent' && k !== 'headers') xtraObj[k] = p.extra[k];
        });
        var sidV = '';
        if (p.extra && p.extra.headers && p.extra.headers['x-session-id']) sidV = String(p.extra.headers['x-session-id']);
        var xtraV = Object.keys(xtraObj).length ? JSON.stringify(xtraObj) : '';
        var presets = [
            ['https://openrouter.ai/api/v1', 'OpenRouter'],
            ['https://opencode.ai/zen/v1', 'opencode zen'],
            ['https://api.openai.com/v1', 'OpenAI'],
            ['http://127.0.0.1:11434/v1', 'Ollama lokal'],
            ['http://127.0.0.1:1234/v1', 'LM Studio']
        ];
        var presetHtml = '<div style="display:flex;gap:4px;flex-wrap:wrap;">';
        presets.forEach(function(ps) {
            presetHtml += '<button type="button" data-act="preset" data-pbase="' + escapeHTML(ps[0]) + '" style="background:#2c2c2e;border:none;color:#0a84ff;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:10px;font-family:inherit;">⚡ ' + escapeHTML(ps[1]) + '</button>';
        });
        presetHtml += '</div>';
        // [uagate-tpl] Template UA & Parameter — proven lolos harness banyak provider.
        // Semua UA di sini lolos debz_ua_ok(): format name/version, tanpa substring "compat".
        var uaTpls = [
            ['opencode/1.0 (linux; x64)', '⭐ opencode / OR-safe'],
            ['opencode/1.0.0 (github.com/sst/opencode)', 'opencode penuh'],
            ['claude-cli/1.0.0', 'Claude Code'],
            ['cline/3.0.0', 'Cline'],
            ['continue/0.0.1', 'Continue.dev'],
            ['cursor/0.5.0', 'Cursor'],
            ['aider/0.74.0', 'aider'],
            ['gemini-cli/1.0', 'Gemini CLI'],
            ['codex/0.4.0', 'Codex CLI'],
            ['kilo/1.0', 'kilo.ai']
        ];
        var uaTplHtml = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 8px;">';
        uaTpls.forEach(function(u) {
            uaTplHtml += '<button type="button" data-act="uatpl" data-ua="' + escapeHTML(u[0]) + '" title="' + escapeHTML(u[0]) + '" style="background:#1c1c1e;border:1px solid #3a3a3c;color:#0a84ff;padding:3px 7px;border-radius:6px;cursor:pointer;font-size:10px;font-family:inherit;">' + escapeHTML(u[1]) + '</button>';
        });
        uaTplHtml += '</div>';
        var xtraTpls = [
            ['{"temperature":0.7}', '🌡️ Natural 0.7'],
            ['{"temperature":0.2}', '🎯 Stabil 0.2 (kode)'],
            ['{"temperature":1.1}', '🎨 Kreatif 1.1'],
            ['{"reasoning_effort":"none"}', '🧠 effort:none'],
            ['{"reasoning_effort":"high"}', '🧠 effort:high'],
            ['{"reasoning":{"enabled":true}}', '💭 OR thinking'],
            ['{"reasoning":{"enabled":true},"temperature":0.6}', '💭 thinking + 0.6'],
            ['{"top_p":0.9,"frequency_penalty":0.3,"presence_penalty":0.3}', '🎲 sampling bebas']
        ];
        var xtraTplHtml = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 8px;">';
        xtraTpls.forEach(function(x) {
            xtraTplHtml += '<button type="button" data-act="xtptpl" data-xtra="' + escapeHTML(x[0]) + '" title="' + escapeHTML(x[0]) + '" style="background:#1c1c1e;border:1px solid #3a3a3c;color:#30d158;padding:3px 7px;border-radius:6px;cursor:pointer;font-size:10px;font-family:inherit;">' + escapeHTML(x[1]) + '</button>';
        });
        xtraTplHtml += '</div>';
        return '<div class="pc-form" data-formid="' + escapeHTML(id) + '">'
            + '<label>Endpoint Preset (klik buat isi otomatis)</label>' + presetHtml
            + '<label>Nama</label><input name="name" placeholder="Misal: Debz Combo" value="' + escapeHTML(p.name || '') + '" />'
            + '<label>Base URL (OpenAI-compatible, /v1)</label><input name="base_url" placeholder="http://127.0.0.1:20128/v1" value="' + escapeHTML(p.base_url || '') + '" />'
            + '<label>API Key' + (p.has_key ? ' (kosongkan = tetap pakai yang lama)' : '') + '</label><input name="api_key" type="password" placeholder="' + (p.has_key ? '******** (udah ada)' : 'sk-...') + '" />'
            + '<label>Model</label><div style="display:flex;gap:6px;align-items:stretch;">'
            + '<input name="model" placeholder="debz_ai" value="' + escapeHTML(p.model || '') + '" style="flex:1;min-width:0;" />'
            + '<button type="button" data-act="loadmodels" style="background:#2c2c2e;border:none;color:#0a84ff;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:11px;font-family:inherit;white-space:nowrap;">📂 Model</button>'
            + '</div>'
            + '<div class="pc-model-list" data-mlist="' + escapeHTML(id) + '" style="display:none;max-height:140px;overflow-y:auto;border:1px solid #3a3a3c;border-radius:8px;margin-top:6px;"></div>'
            + '<label>Reasoning Effort (nemotron / o-series dll)</label><select name="reasoning">'
            + '<option value=""' + (re === '' ? ' selected' : '') + '>— default provider —</option>'
            + '<option value="none"' + (re === 'none' ? ' selected' : '') + '>none — matiin reasoning (teks bersih)</option>'
            + '<option value="low"' + (re === 'low' ? ' selected' : '') + '>low</option>'
            + '<option value="medium"' + (re === 'medium' ? ' selected' : '') + '>medium</option>'
            + '<option value="high"' + (re === 'high' ? ' selected' : '') + '>high</option>'
            + '</select>'
            + '<label>Reasoning Details (inkling / GLM via OpenRouter)</label><select name="rdmode">'
            + '<option value=""' + (rdOn === '' ? ' selected' : '') + '>— default provider —</option>'
            + '<option value="on"' + (rdOn === 'on' ? ' selected' : '') + '>on — aktifin (extra_body reasoning enabled)</option>'
            + '<option value="off"' + (rdOn === 'off' ? ' selected' : '') + '>off — matiin</option>'
            + '</select>'
            + '<label>User-Agent (beberapa provider gate UA — kosong = auto)</label>'
            + '<input name="ua" placeholder="auto (OpenRouter: opencode/1.0)" value="' + escapeHTML(uaV || '') + '" />'
            + uaTplHtml
            + '<label>Custom Extra (JSON — temperature, dst)</label>'
            + '<textarea name="xtra" rows="2" placeholder="{&quot;temperature&quot;:0.7}" style="background:#1c1c1e;border:1px solid #3a3a3c;border-radius:8px;color:#f5f5f7;padding:8px 10px;font-size:12px;font-family:monospace;outline:none;width:100%;box-sizing:border-box;resize:vertical;">' + escapeHTML(xtraV || '') + '</textarea>'
            + xtraTplHtml
            + '<label>Session ID (x-session-id header — beberapa provider butuh ini)<\/label>'
            + '<div style="display:flex;gap:6px;align-items:stretch;">'
            + '<input name="sid" placeholder="auto-generate \/ tempel session id" value="' + escapeHTML(sidV || '') + '" style="flex:1;min-width:0;font-family:monospace;" \/>'
            + '<button type="button" data-act="gensession" title="Ambil x-session-id dari endpoint di atas (auto-generate UUID kalau gak dikasih)" style="background:#0a84ff;border:none;color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:11px;font-family:inherit;white-space:nowrap;">⚡ Generate<\/button>'
            + '<\/div>'
            + '<div class="pc-gen-result" style="font-size:11px;min-height:14px;margin-top:2px;"><\/div>'
            + '<label>Mode</label><select name="mode">'
            + '<option value="native"' + ((p.mode || '') === 'native' ? ' selected' : '') + '>native — agent + tools (shell/file)</option>'
            + '<option value="chat"' + ((p.mode || '') === 'chat' ? ' selected' : '') + '>chat — polos tanpa tools</option>'
            + '</select>'
            + '<div class="pc-test-result" style="margin-top:6px;font-size:11px;min-height:16px;"></div>'
            + '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
            + '<button type="button" class="pc-actions" data-act="smartparams" title="Probe provider & deteksi parameter yang tepat (reasoning, temperature, max_tokens) buat model ini" style="background:#5e5ce6;border:none;color:#fff;padding:8px 12px;border-radius:8px;cursor:pointer;font-size:11px;font-family:inherit;">🧪 Smart Params</button>'
            + '<button type="button" class="pc-actions" data-act="test" style="background:#2c2c2e;border:none;color:#d1d1d6;padding:8px 12px;border-radius:8px;cursor:pointer;font-size:11px;font-family:inherit;">Test Koneksi</button>'
            + '<button type="button" data-act="save" style="background:#34c759;border:none;color:#000;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:11px;font-weight:700;font-family:inherit;">Simpan</button>'
            + '<button type="button" data-act="cancel" style="background:transparent;border:1px solid #3a3a3c;color:#98989d;padding:8px 12px;border-radius:8px;cursor:pointer;font-size:11px;font-family:inherit;">Batal</button>'
            + '</div>'
            + '</div>';
    }

    if (settingsProvidersEl) {
        // filter model list live (input)
        settingsProvidersEl.addEventListener('input', function(e) {
            var el = e.target;
            if (el && el.classList && el.classList.contains('mdrop-filter')) {
                var host2 = el.closest('[data-mdrop]');
                if (!host2) return;
                var q2 = (el.value || '').toLowerCase();
                var btns2 = host2.querySelectorAll('.mdrop-item');
                for (var mi = 0; mi < btns2.length; mi++) {
                    btns2[mi].style.display = (!q2 || (btns2[mi].getAttribute('data-mname') || '').toLowerCase().indexOf(q2) !== -1) ? '' : 'none';
                }
                return;
            }
            if (el && el.getAttribute && el.getAttribute('data-mlfilter') !== null) {
                var host = el.closest('[data-mlist]');
                if (!host) return;
                var q = (el.value || '').toLowerCase();
                var btns = host.querySelectorAll('button[data-mname]');
                for (var bi = 0; bi < btns.length; bi++) {
                    btns[bi].style.display = (!q || (btns[bi].textContent || '').toLowerCase().indexOf(q) !== -1) ? '' : 'none';
                }
            }
        });
                        settingsProvidersEl.addEventListener('click', function(e) {
            var switchWrap = e.target.closest ? e.target.closest('.pc-switch') : null;
            var t = e.target.closest ? e.target.closest('[data-act]') : null;
            if (!t && switchWrap) {
                t = switchWrap.querySelector('input[data-act="toggle"]');
            }

            // Pindahkan pengecekan .mdrop-item KE ATAS sebelum if (!t) return;
            var mItem = e.target.closest ? e.target.closest('.mdrop-item') : null;
            if (mItem) {
                var card2 = mItem.closest('.provider-card');
                var id2 = card2 ? card2.getAttribute('data-pcid') : '';
                var nm2 = mItem.getAttribute('data-mname') || '';
                if (id2 && nm2) {
                    fetch(API_URL + '?action=providers', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ op: 'setmodel', id: id2, model: nm2 })
                    }).then(function(r) { return r.json(); }).then(function(d) {
                        if (d.success) {
                            showToast('✅ Model: ' + nm2);
                            if (providerData && providerData.providers[id2]) providerData.providers[id2].model = nm2;
                            renderSettingsProviders();
                            fetchProviders(refreshProviderUI);
                        } else showToast('❌ ' + (d.error || 'gagal'));
                    }).catch(function() { showToast('❌ gagal ganti model'); });
                }
                return;
            }

            if (!t) return;
            var act = t.getAttribute('data-act');
            var id = t.getAttribute('data-id');

            if (!id) {
                var formHost = t.closest('[data-formid]');
                if (formHost) id = formHost.getAttribute('data-formid');
            }
            var cardEl = t.closest('.provider-card');

            if (act === 'toggle') {
                var toVal = t.checked;
                fetch(API_URL + '?action=providers', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ op: 'toggle', id: id, enabled: toVal })
                }).then(function(r) { return r.json(); }).then(function(d) {
                    if (d.success) {
                        var af = d.auto_fetch || null;
                        if (toVal && af && af.count > 0) {
                            showToast('🟢 Provider aktif · 🔄 ' + af.count + ' model ke-fetch otomatis');
                            if (providerData && providerData.providers[id]) {
                                providerData.providers[id].models = providerData.providers[id].models || [];
                            }
                        } else if (toVal && af && af.error && af.error !== '-') {
                            showToast('🟢 Provider aktif (auto-fetch gagal: ' + af.error.slice(0, 40) + ' — coba 🔄 manual)');
                        } else {
                            showToast(toVal ? '🟢 Provider diaktifkan' : '⚪ Provider dimatiin');
                        }
                        renderSettingsProviders();
                        fetchProviders(refreshProviderUI);
                    } else showToast('❌ ' + (d.error || 'gagal'));
                }).catch(function() { showToast('❌ gagal toggle'); });
                return;
            }
            if (act === 'fetchmodels') {
                if (t.disabled) return;
                t.disabled = true; t.textContent = '⏳ Ambil...';
                fetch(API_URL + '?action=providers', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ op: 'fetchmodels', id: id })
                }).then(function(r) { return r.json(); }).then(function(d) {
                    if (d.success) {
                        showToast('📂 ' + d.count + ' model ke-fetch & disimpan');
                        if (providerData && providerData.providers[id]) {
                            providerData.providers[id].models = d.models || [];
                            providerData.providers[id].models_count = d.count || 0;
                        }
                        renderSettingsProviders();
                    } else {
                        showToast('❌ ' + (d.error || 'gagal fetch'), 3500);
                        t.disabled = false; t.textContent = '🔄 Ambil List Model';
                    }
                }).catch(function() {
                    showToast('❌ gagal fetch model');
                    t.disabled = false; t.textContent = '🔄 Ambil List Model';
                });
                return;
            }
            if (act === 'pickmodel') {
                if (t.disabled) return;
                var drop = cardEl ? cardEl.querySelector('[data-mdrop]') : null;
                if (!drop) return;
                var mp = (providerData && providerData.providers[id]) || {};
                var models = mp.models || [];
                if (!models.length) { showToast('Ambil list model dulu (🔄)'); return; }
                var curModel = mp.model || '';
                var html2 = '<input type="text" class="mdrop-filter" placeholder="🔍 cari model (' + models.length + ')…" value="' + escapeHTML(curModel) + '">';
                var list2 = '<div class="mdrop-list">';
                var fav2 = models.filter(function(m) { return /free|contributor/i.test(m); });
                if (fav2.length) list2 += '<div class="mdrop-sec">FREE TIER (' + fav2.length + ')</div>';
                fav2.forEach(function(m) { list2 += '<button type="button" class="mdrop-item' + (m === curModel ? ' cur' : '') + '" data-mname="' + escapeHTML(m) + '">' + escapeHTML(m) + '</button>'; });
                if (models.length > fav2.length) list2 += '<div class="mdrop-sec">LAINNYA (' + (models.length - fav2.length) + ')</div>';
                models.forEach(function(m) { if (fav2.indexOf(m) !== -1) return; list2 += '<button type="button" class="mdrop-item' + (m === curModel ? ' cur' : '') + '" data-mname="' + escapeHTML(m) + '">' + escapeHTML(m) + '</button>'; });
                list2 += '</div>';
                drop.innerHTML = html2 + list2;
                drop.hidden = false;
                var inp2 = drop.querySelector('.mdrop-filter');
                if (inp2) { inp2.focus(); inp2.select(); }
                return;
            }
                        if (act === 'activate') {
                fetch(API_URL + '?action=providers', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ op: 'activate', id: id, enabled: true })
                }).then(function(r) { return r.json(); }).then(function(d) {
                    if (d.success) {
                        activeProviderId = id;
                        showToast('✅ Provider aktif diganti & diaktifkan');
                        renderSettingsProviders();
                        fetchProviders(refreshProviderUI);
                    } else showToast('❌ ' + (d.error || 'gagal'));
                }).catch(function() { showToast('❌ gagal'); });
                return;
            }

            if (act === 'del') {
                var pname = providerData && providerData.providers[id] ? providerData.providers[id].name : id;
                if (!confirm('Hapus provider "' + pname + '"?')) return;
                fetch(API_URL + '?action=providers', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ op: 'delete', id: id })
                }).then(function(r) { return r.json(); }).then(function(d) {
                    if (d.success) { showToast('🗑️ Provider dihapus'); renderSettingsProviders(); fetchProviders(refreshProviderUI); }
                    else showToast('❌ ' + (d.error || 'gagal'));
                }).catch(function() { showToast('❌ gagal'); });
                return;
            }
            if (act === 'edit') {
                var p = providerData ? providerData.providers[id] : null;
                if (cardEl && p) cardEl.innerHTML = '<div class="pc-head"><div class="pc-name">✏️ Edit: ' + escapeHTML(p.name || id) + '</div></div>' + providerFormHtml(id, p);
                return;
            }
            if (act === 'preset') {
                var pForm2 = t.closest('.pc-form');
                var pBase = t.getAttribute('data-pbase') || '';
                if (pForm2 && pBase) {
                    var bUrl = pForm2.querySelector('[name="base_url"]');
                    if (bUrl) bUrl.value = pBase;
                    var bUa = pForm2.querySelector('[name="ua"]');
                    if (bUa) bUa.value = /openrouter\.ai/.test(pBase) ? '' : (bUa.value || '');
                    showToast('⚡ Preset endpoint di-apply — lanjut isi key & model');
                    if (bUrl) bUrl.focus();
                }
                return;
            }
            if (act === 'uatpl') {
                var uForm = t.closest('.pc-form');
                var uIn = uForm ? uForm.querySelector('[name="ua"]') : null;
                var uaPick = t.getAttribute('data-ua') || '';
                if (uIn && uaPick) {
                    uIn.value = uaPick;
                    showToast('🔖 UA: ' + uaPick);
                    if (uIn.focus) uIn.focus();
                }
                return;
            }
            if (act === 'xtptpl') {
                var xForm = t.closest('.pc-form');
                var xIn = xForm ? xForm.querySelector('[name="xtra"]') : null;
                var xPick = t.getAttribute('data-xtra') || '';
                if (xIn && xPick) {
                    xIn.value = xPick;
                    showToast('🧪 Parameter template di-apply — cek JSON-nya, terus Test/Simpan');
                }
                return;
            }
            if (act === 'gensession') {
                var gForm = t.closest('.pc-form');
                if (!gForm) return;
                var gUrl = (gForm.querySelector('[name="base_url"]') || {}).value || '';
                var gKey = (gForm.querySelector('[name="api_key"]') || {}).value || '____';
                var gUa = (gForm.querySelector('[name="ua"]') || {}).value || '';
                var gIn = gForm.querySelector('[name="sid"]');
                var gRes = gForm.querySelector('.pc-gen-result');
                if (!gIn) return;
                if (!/^https?:\/\//.test(gUrl)) {
                    if (gRes) { gRes.style.color = '#ff6961'; gRes.textContent = '❌ Isi Base URL dulu'; }
                    return;
                }
                if (gRes) { gRes.style.color = '#86868b'; gRes.textContent = '⏳ ngambil session id dari ' + gUrl + ' ...'; }
                t.disabled = true;
                fetch(API_URL + '?action=providers', {
                    method: 'POST', headers: { 'Content-Type': 'application\/json' },
                    body: JSON.stringify({ op: 'gensession', base_url: gUrl, api_key: gKey, ua: gUa })
                }).then(function(r) { return r.json(); }).then(function(d) {
                    t.disabled = false;
                    if (d.success && d.session_id) {
                        gIn.value = d.session_id;
                        if (gRes) { gRes.style.color = '#30d158'; gRes.textContent = '✅ Session ID: ' + d.session_id + (d.source === 'response' ? ' (dari respons endpoint)' : ' (UUID baru — endpoint gak ngasih header)'); }
                        showToast('⚡ Session ID ke-generate & masuk ke kolom');
                    } else {
                        if (gRes) { gRes.style.color = '#ff6961'; gRes.textContent = '❌ ' + (d.error || 'gagal'); }
                        showToast('❌ Gagal generate: ' + (d.error || '?'), 3000);
                    }
                }).catch(function(e) {
                    t.disabled = false;
                    if (gRes) { gRes.style.color = '#ff6961'; gRes.textContent = '❌ network error'; }
                    showToast('❌ Gagal generate (network)', 3000);
                });
                return;
            }
            if (act === 'cancel') { renderSettingsProviders(); return; }
            if (act === 'pickmodel') {
                var mName = t.getAttribute('data-mname') || '';
                var mForm = t.closest('.pc-form');
                if (mForm && mName) {
                    var mInput = mForm.querySelector('[name="model"]');
                    if (mInput) mInput.value = mName;
                }
                var mHost = t.closest('[data-mlist]');
                if (mHost) mHost.style.display = 'none';
                return;
            }
            if (act === 'loadmodels') {
                var lForm = t.closest('.pc-form');
                if (!lForm) return;
                var lUrl = (lForm.querySelector('[name="base_url"]') || {}).value || '';
                var lKey = (lForm.querySelector('[name="api_key"]') || {}).value || '____';
                var lHost2 = lForm.querySelector('[data-mlist]');
                if (!lHost2) return;
                if (!/^https?:\/\//.test(lUrl)) { lHost2.style.display = 'block'; lHost2.innerHTML = '<div style="color:#ff6961;font-size:11px;padding:6px;">Isi Base URL dulu</div>'; return; }
                lHost2.style.display = 'block';
                lHost2.innerHTML = '<div style="color:#86868b;font-size:11px;padding:6px;">⏳ ngambil list model...</div>';
                fetch(API_URL + '?action=providers', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ op: 'test', base_url: lUrl, api_key: lKey })
                }).then(function(r) { return r.json(); }).then(function(d) {
                    var models = d.models || [];
                    if (!models.length) { lHost2.innerHTML = '<div style="color:#ff6961;font-size:11px;padding:6px;">' + (d.error ? '❌ ' + escapeHTML(d.error) : '❌ gak ada model ketemu') + '</div>'; return; }
                    var fav = models.filter(function(m) { return /free|contributor/i.test(m); });
                    var html = '<div style="padding:4px 6px;"><input type="text" data-mlfilter placeholder="filter model…" style="width:100%;box-sizing:border-box;background:#1c1c1e;border:1px solid #3a3a3c;border-radius:6px;color:#f5f5f7;padding:5px 8px;font-size:11px;font-family:inherit;outline:none;" /></div>';
                    if (fav.length) html += '<div style="padding:4px 6px;color:#30d158;font-size:10px;font-weight:700;">FREE TIER (' + fav.length + ')</div>';
                    fav.forEach(function(m) {
                        html += '<button type="button" data-act="pickmodel" data-mname="' + escapeHTML(m) + '" style="display:block;width:100%;text-align:left;background:#1c1c1e;border:none;color:#d1d1d6;padding:5px 8px;cursor:pointer;font-size:11px;font-family:monospace;">' + escapeHTML(m) + '</button>';
                    });
                    if (fav.length && models.length > fav.length) html += '<div style="padding:4px 6px;color:#86868b;font-size:10px;font-weight:700;">LAINNYA (' + (models.length - fav.length) + ')</div>';
                    models.forEach(function(m) {
                        if (/free|contributor/i.test(m)) return;
                        html += '<button type="button" data-act="pickmodel" data-mname="' + escapeHTML(m) + '" style="display:block;width:100%;text-align:left;background:#1c1c1e;border:none;color:#98989d;padding:5px 8px;cursor:pointer;font-size:11px;font-family:monospace;">' + escapeHTML(m) + '</button>';
                    });
                    lHost2.innerHTML = html;
                }).catch(function() {
                    lHost2.innerHTML = '<div style="color:#ff6961;font-size:11px;padding:6px;">❌ gagal fetch</div>';
                });
                return;
            }
            console.log('[DEBUG-TEST] tombol ke-klik, act =', act, '| id =', id);
            if (act === 'test' || act === 'save') {
                var form = t.closest('.pc-form');
                if (!form) return;
                var fid = form.getAttribute('data-formid') || '';
                function fv(name) {
                    var el = form.querySelector('[name="' + name + '"]');
                    return el ? (el.value || '') : '';
                }
                var oldP = (providerData && providerData.providers[fid]) || {};
                var reVal = fv('reasoning') || ''; /*PATCH:c10*/
                var rdVal = fv('rdmode') || '';
                var uaVal = fv('ua') || '';
                var xtraVal = (fv('xtra') || '').trim();
                var oldP = (providerData && providerData.providers[fid]) || {};
                var oldExtra = (oldP && oldP.extra) ? oldP.extra : {};
                var extraObj = {};
                // pertahanin extra lain yang udah tersimpan (temperature dsb), update reasoning_effort
                Object.keys(oldExtra).forEach(function(k) {
                    if (k !== 'reasoning_effort' && k !== 'reasoning' && k !== 'user_agent') extraObj[k] = oldExtra[k];
                });
                if (reVal !== '') extraObj.reasoning_effort = reVal; // else: reasoning default → hapus key
                if (rdVal === 'on') extraObj.reasoning = { enabled: true };
                else if (rdVal === 'off') extraObj.reasoning = { enabled: false };
                if (uaVal !== '') extraObj.user_agent = uaVal;
                var sidVal = (fv('sid') || '').trim();
                if (sidVal !== '') {
                    if (!extraObj.headers || typeof extraObj.headers !== 'object') extraObj.headers = {};
                    extraObj.headers['x-session-id'] = sidVal;
                } else {
                    if (extraObj.headers && typeof extraObj.headers === 'object') delete extraObj.headers['x-session-id'];
                    if (extraObj.headers && Object.keys(extraObj.headers).length === 0) delete extraObj.headers;
                }
                if (xtraVal) {
                    try {
                        var xj = JSON.parse(xtraVal);
                        if (xj && typeof xj === 'object' && !Array.isArray(xj)) {
                            Object.keys(xj).forEach(function(k) {
                                if (k === 'headers') return; // headers dikelola kolom Session ID
                                extraObj[k] = xj[k];
                            });
                        }
                    } catch (eX) { showToast('⚠️ Custom Extra bukan JSON valid — diabaikan'); }
                }
                var payload = {
                    op: 'save',
                    id: fid,
                    name: fv('name'),
                    base_url: fv('base_url'),
                    api_key: fv('api_key') || (oldP.has_key ? '____' : ''),
                    model: fv('model'),
                    mode: fv('mode') || 'native',
                    extra: extraObj
                };
                if (act === 'test') {
                    payload.op = 'test';
                    if (payload.api_key === '____') payload.id = fid; // server ambil key lama
                    if (uaVal !== '') payload.ua = uaVal; // UA policy ikut ke test koneksi
                    var testEl = cardEl ? cardEl.querySelector('.pc-test-result') : null;
                    if (testEl) { testEl.className = 'pc-test-result'; testEl.textContent = '⏳ testing...'; }
                    fetch(API_URL + '?action=providers', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    }).then(function(r) { return r.json(); }).then(function(d) {
                        var el = cardEl ? cardEl.querySelector('.pc-test-result') : null;
                        if (!el) return;
                        if (d.success) {
                            el.className = 'pc-test-result ok';
                            var models = (d.models || []);
                            el.textContent = '✅ Konek! ' + models.length + ' model tersedia' + (models.length ? ': ' + models.slice(0, 5).join(', ') + (models.length > 5 ? '…' : '') : '');
                        } else {
                            el.className = 'pc-test-result err';
                            el.textContent = '❌ ' + (d.error || ('HTTP ' + d.http));
                        }
                    }).catch(function() {
                        var el2 = cardEl ? cardEl.querySelector('.pc-test-result') : null;
                        if (el2) { el2.className = 'pc-test-result err'; el2.textContent = '❌ gagal fetch'; }
                    });
                    return;
                }
                // save
                fetch(API_URL + '?action=providers', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).then(function(r) { return r.json(); }).then(function(d) {
                    if (d.success) {
                        var af = d.auto_fetch || null;
                        if (af && af.count > 0) showToast('💾 Disimpan · 🔄 ' + af.count + ' model ke-fetch otomatis');
                        else showToast('💾 Provider disimpan');
                        renderSettingsProviders(); fetchProviders(refreshProviderUI);
                    }
                    else showToast('❌ ' + (d.error || 'gagal'));
                }).catch(function() { showToast('❌ gagal'); });
                return;
            }
        });
    }

    if (settingsAddBtn) {
        settingsAddBtn.addEventListener('click', function() {
            var newId = 'custom_' + Date.now().toString(36);
            var wrap = document.createElement('div');
            wrap.className = 'provider-card';
            wrap.innerHTML = '<div class="pc-head"><div class="pc-name">➕ Provider Baru</div></div>' + providerFormHtml(newId, null);
            if (settingsProvidersEl) settingsProvidersEl.insertBefore(wrap, settingsProvidersEl.firstChild);
            wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    }

    // ===== Compact — ringkas context jadi summary =====
    if (compactBtn) {
        compactBtn.addEventListener('click', function() {
            if (busy) { showToast('Tungguin Debz kelar jawab dulu..'); return; }
            var s = activeSession();
            if (!s || !s.messages || s.messages.length < 2) {
                showToast('Chat masih dikit — gak ada yang perlu di-compact 😄');
                return;
            }
            if (!confirm('Compact context? Chat di session ini diringkas jadi summary — hemat token, lanjut ngobrol dari situ.')) return;
            compactBtn.disabled = true;
            compactBtn.textContent = '⏳';
            fetch(API_URL + '?action=compact', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: s.messages })
            }).then(function(r) { return r.json(); }).then(function(d) {
                compactBtn.disabled = false;
                compactBtn.textContent = 'Compact';
                if (!d.success) { showToast('❌ Compact gagal: ' + (d.error || '?'), 3500); return; }
                var summaryMsg = '> 🔸 **Context di-compact.** Ringkasan sebelumnya:\n>\n> ' + d.summary.replace(/\n/g, '\n> ') + '\n\n*(lanjut ngobrol dari sini)*';
                s.messages = [{ role: 'assistant', content: summaryMsg, timestamp: Date.now() }];
                messages = s.messages;
                saveStore();
                loadSessionView();
                renderSessionList();
                showToast('🗜️ Context di-compact! ' + s.messages[0].content.length + ' → ringkas');
            }).catch(function() {
                compactBtn.disabled = false;
                compactBtn.textContent = 'Compact';
                showToast('❌ Compact gagal (network)', 3000);
            });
        });
    }

    // Init: load providers pertama kali
    fetchProviders(refreshProviderUI);

    /* ==================== PWA ==================== */
    var installBtn = document.getElementById('install-btn');
    var deferredPrompt = null;

    function isStandalone() {
        return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
            || (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches)
            || window.navigator.standalone === true;
    }

    function looksIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    // [SW-KILL] Registrasi service worker dihapus biar gak ada cache nyangkut
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(regs) {
            regs.forEach(function(r) { r.unregister().then(function(ok) {
                console.log('[SW-KILL] unregister:', ok);
            }); });
        }).catch(function(e) { console.warn('[SW-KILL]', e); });
        navigator.serviceWorker.addEventListener('controllerchange', function() {
            console.log('[SW-KILL] controller berubah — refresh otomatis');
            window.location.reload();
        });
    }

    window.addEventListener('beforeinstallprompt', function(e) {
        e.preventDefault();
        deferredPrompt = e;
        if (installBtn && !isStandalone()) installBtn.hidden = false;
    });

    window.addEventListener('appinstalled', function() {
        deferredPrompt = null;
        if (installBtn) installBtn.hidden = true;
        showToast('c0n73xt ke-install! Cek home screen / desktop lu 🎉', 3500);
    });

    if (installBtn) {
        // iOS gak punya beforeinstallprompt — tetep tunjukin tombol buat ngasih arah manual
        if (!isStandalone() && looksIOS()) installBtn.hidden = false;
        installBtn.addEventListener('click', function() {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                deferredPrompt.userChoice.then(function(choice) {
                    if (choice && choice.outcome === 'accepted') installBtn.hidden = true;
                    deferredPrompt = null;
                }).catch(function() { deferredPrompt = null; });
            } else if (looksIOS()) {
                showToast('iOS: tombol Share (⬆️) → "Add to Home Screen"', 4500);
            } else {
                showToast('Pake menu browser: ⋮ → Install app / ikon install di address bar', 4500);
            }
        });
    }
})();

document.addEventListener('DOMContentLoaded', () => {
    const termBody = document.getElementById('term-body');
    if (termBody) {
        termBody.addEventListener('click', function(e) {
            const tx = e.target.closest('.term-tx');
            if (tx) tx.classList.toggle('unwrap');
        });
    }
});
