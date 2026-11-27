/* SessionBot — app.js
   Logika frontend: validasi nomor realtime (server), pairing code / QR,
   WebSocket status, countdown wall-clock, pipeline, terminal, pengiriman.
   TIDAK PERNAH menampilkan isi package.json. */
(function () {
  'use strict';

  /* URL bersih: buang ?view= dari address bar (pilihannya sudah tersimpan
     di cookie sessionbot-view oleh server). Path halaman dipertahankan:
     /tentang tetap /tentang, /info-update tetap /info-update. */
  /* URL selalu polos: sessionbot.my.id saja, apa pun halamannya.
     Path asli disimpan dulu supaya tombol "Lihat versi desktop/mobile"
     tetap bisa kembali ke halaman yang sama. */
  try {
    sessionStorage.setItem('sb-page', window.location.pathname + window.location.hash);
  } catch (e) { /* lanjut tanpa simpanan */ }
  try {
    if (window.location.pathname !== '/' || window.location.search || window.location.hash) {
      history.replaceState(null, '', '/');
    }
  } catch (e) { /* biarkan URL apa adanya */ }

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var STATE_KEY = 'sessionbot-state-v1';
  var THEME_KEY = 'sessionbot-theme-v1';
  var VISITOR_KEY = 'sessionbot-visitor-v1';
  var RING_C = 339.29; // 2 * PI * 54

  /* ---------------- State ---------------- */
  var state = {
    phone: '',
    phoneValid: false,
    numberChecked: false, // server sudah konfirmasi nomor valid — baru tampilkan Pilih Metode
    region: null,
    method: null,          // 'pairing' | 'qr'
    codeMode: 'random',    // 'custom' | 'random'
    customCode: '',
    code: '',
    qrDataUrl: '',
    status: 'idle',
    expiresAt: 0,
    totalSeconds: 180,
    botNumber: '',
    delivery: null,
    deliveryError: '',
    session: null,
    sessionFile: '',
    successOverlayShown: false
  };

  var validateTimer = null;
  var validateAbort = null;
  var countdownTimer = null;
  var ws = null;
  var wsRetryMs = 3000;
  var lastStatusLogged = '';
  var lastPrefsPhone = '';
  var savePrefsTimer = null;
  var operatorsCache = null;

  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        phone: state.phone,
        method: state.method,
        codeMode: state.codeMode,
        customCode: state.customCode,
        code: state.code,
        qrDataUrl: state.qrDataUrl,
        expiresAt: state.expiresAt,
        totalSeconds: state.totalSeconds,
        status: state.status,
        botNumber: state.botNumber,
        delivery: state.delivery,
        session: state.session,
        sessionFile: state.sessionFile,
        deliveryError: state.deliveryError
      }));
    } catch (e) { /* abaikan */ }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearSavedCode() {
    var s = loadState() || {};
    s.code = ''; s.qrDataUrl = ''; s.expiresAt = 0; s.status = 'idle';
    try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) { /* abaikan */ }
  }

  /* ---------------- Util ---------------- */
  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function wibNow() {
    return new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  }

  // Kode negara terpanjang yang cocok di awal digit (mis. 62, 60, 1, 44).
  // LOCAL_COUNTRY_PREFIXES didefinisikan di bawah; fungsi ini baru dipanggil
  // setelah skrip selesai dimuat, jadi aman.
  function findCallingCodeLocal(digits) {
    var codes = Object.keys(LOCAL_COUNTRY_PREFIXES).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < codes.length; i++) {
      if (digits.indexOf(codes[i]) === 0) return codes[i];
    }
    return null;
  }

  // WAJIB ada kode negara (27 Nov 2026): nomor tanpa 0 / + / 00 / kode
  // negara (mis. 89...) TIDAK boleh ditebak jadi 62 — kembalikan '' supaya
  // validatePhoneLocal/validatePhone menampilkan pesan "masukkan kode negara".
  function normalizePhone(raw) {
    var s = String(raw || '').replace(/[\s\-().]/g, '');
    if (!s) return '';
    if (s.charAt(0) === '+') return s.slice(1).replace(/\D/g, '');
    s = s.replace(/\D/g, '');
    if (!s) return '';
    // "00" di depan = kode akses internasional, buang "00"-nya.
    if (s.indexOf('00') === 0) {
      s = s.slice(2);
      if (!s) return '';
      return findCallingCodeLocal(s) ? s : '';
    }
    // "0" di depan = nomor lokal Indonesia, 0 diganti 62.
    if (s.charAt(0) === '0') {
      while (s.charAt(0) === '0') s = s.slice(1);
      if (!s) return '';
      return '62' + s;
    }
    // Sudah ada kode negara? Harus cocok dengan peta calling code.
    if (findCallingCodeLocal(s)) return s;
    // Tanpa 0 / + / 00 / kode negara -> region tidak diketahui, jangan ditebak.
    return '';
  }

  function formatCode8(code8) {
    var c = String(code8 || '').replace(/[^A-Z0-9]/gi, '').toUpperCase().padEnd(8, '0').slice(0, 8);
    return c.slice(0, 4) + '-' + c.slice(4);
  }

  /* ---------------- Tema ---------------- */
  var themeModes = ['dark', 'light', 'system'];
  var themeLabels = { dark: ['🌙', 'Malam'], light: ['☀️', 'Siang'], system: ['🌓', 'Sistem'] };

  function currentThemeSetting() {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; }
  }

  function applyTheme(setting) {
    var mode = setting;
    if (mode === 'system') {
      mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', mode);
    var btn = $('themeToggle');
    if (btn) {
      var label = themeLabels[setting] || themeLabels.dark;
      var icon = $('themeToggleIcon'); if (icon) icon.textContent = label[0];
      var text = $('themeToggleText'); if (text) text.textContent = label[1];
      btn.setAttribute('aria-label', 'Tema: ' + label[1] + ' (klik untuk ganti)');
    }
  }

  /* Saklar tampilan di footer ("Lihat versi desktop/mobile"): simpan pilihan
     ke cookie sessionbot-view lalu muat ulang path yang sama TANPA query —
     URL tetap bersih dan pilihan menetap di semua halaman + refresh. */
  function initViewToggle() {
    $$('a[href^="?view="]').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        var m = /view=(mobile|desktop)/.exec(a.getAttribute('href') || '');
        if (!m) return;
        ev.preventDefault();
        try {
          document.cookie = 'sessionbot-view=' + m[1] + '; path=/; max-age=31536000; SameSite=Lax';
        } catch (e) { /* lanjut tanpa cookie */ }
        var back = '/';
        try { back = sessionStorage.getItem('sb-page') || window.location.pathname; } catch (e) { back = window.location.pathname; }
        window.location.href = back;
      });
    });
  }

  function initTheme() {
    applyTheme(currentThemeSetting());
    var btn = $('themeToggle');
    if (btn) {
      btn.addEventListener('click', function () {
        var cur = currentThemeSetting();
        var next = themeModes[(themeModes.indexOf(cur) + 1) % themeModes.length];
        try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* abaikan */ }
        applyTheme(next);
      });
    }
    try {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
        if (currentThemeSetting() === 'system') applyTheme('system');
      });
    } catch (e) { /* abaikan */ }
  }

  /* ---------------- Jam WIB realtime ---------------- */
  function tickClock() {
    var el = $('liveClock');
    if (!el) return;
    try {
      var parts = new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long',
        year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).formatToParts(new Date());
      var get = function (t) { var p = parts.find(function (x) { return x.type === t; }); return p ? p.value : ''; };
      el.textContent = get('weekday') + ', ' + get('day') + ' ' + get('month') + ' ' + get('year') +
        ' · ' + get('hour') + ':' + get('minute') + ':' + get('second') + ' WIB';
    } catch (e) {
      el.textContent = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
    }
  }

  /* ---------------- Presence ---------------- */
  function getVisitorId() {
    try {
      var v = localStorage.getItem(VISITOR_KEY);
      if (!v) {
        v = 'v-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        localStorage.setItem(VISITOR_KEY, v);
      }
      return v;
    } catch (e) { return 'v-anon'; }
  }

  function refreshLiveStats() {
    fetch('/api/public/live-stats').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      var o = $('statOnline'); if (o) o.textContent = d.online;
      var s = $('statStalker'); if (s) s.textContent = d.stalker;
      var v = $('statVisits'); if (v) v.textContent = d.visits;
    }).catch(function () { /* abaikan */ });
  }

  function sendHeartbeat() {
    var paired = ['connected', 'delivering', 'delivered_disconnected'].indexOf(state.status) !== -1;
    fetch('/api/visitor/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: getVisitorId(), paired: paired })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      var o = $('statOnline'); if (o) o.textContent = d.online;
      var s = $('statStalker'); if (s) s.textContent = d.stalker;
      var v = $('statVisits'); if (v) v.textContent = d.visits;
    }).catch(function () { /* abaikan */ });
  }

  function initPresence() {
    if (!$('statOnline')) return;
    refreshLiveStats();
    sendHeartbeat();
    setInterval(function () { sendHeartbeat(); refreshLiveStats(); }, 30000);
  }

  /* ---------------- Health ---------------- */
  function initHealth() {
    fetch('/api/health').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      $$('[id="botVersion"]').forEach(function (bv) { bv.textContent = d.botVersion || 'latest'; });
      var about = $('aboutServer');
      if (about) about.textContent = 'Baileys ' + (d.botVersion || 'latest') + ' · Browser ' + (d.browser || 'Ubuntu + Chrome') + ' · Metode: ' + (d.methods || ['pairing', 'qr']).join(' / ');
      var fl = $('footerServerLink');
      if (fl) fl.textContent = 'Baileys ' + (d.botVersion || 'latest') + ' · V1';
    }).catch(function () { /* abaikan */ });
  }

  /* ---------------- Operator ---------------- */
  function loadOperators() {
    if (operatorsCache) return Promise.resolve(operatorsCache);
    return fetch('/operators.json').then(function (r) { return r.json(); }).then(function (list) {
      operatorsCache = Array.isArray(list) ? list : [];
      return operatorsCache;
    }).catch(function () { operatorsCache = []; return operatorsCache; });
  }

  function findOperatorSlug(carrierName) {
    var norm = String(carrierName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!norm || !operatorsCache) return null;
    var hit = operatorsCache.find(function (op) {
      var on = String(op.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      var os = String(op.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return on === norm || os === norm;
    });
    return hit ? hit.slug : null;
  }

  /* ---------------- Terminal ---------------- */
  // Warna teks terminal mengikuti konteks barisnya: sukses = hijau,
  // gagal = merah, proses = kuning, info = hijau pudar. Kode pairing
  // XXXX-XXXX ditonjolkan lebih terang di dalam barisnya.
  function logKind(msg) {
    if (/gagal|tidak bisa|tidak valid|ditolak|terputus|invalid|^Kode kedaluwarsa|^Kode \/ QR kedaluwarsa/i.test(msg)) return 'log-err';
    if (/terhubung|terkirim|diterima|tersimpan|valid|berhasil|dipulihkan|selesai/i.test(msg)) return 'log-ok';
    if (/menunggu|tunggu|menghubungkan|meminta|mengirim|dibatalkan|mengecek/i.test(msg)) return 'log-warn';
    return 'log-info';
  }
  function logLine(msg) {
    var pre = $('terminalLog');
    if (!pre) return;
    if (!pre.dataset.colored) { pre.textContent = ''; pre.dataset.colored = '1'; }
    var line = document.createElement('span');
    line.className = 'tlog ' + logKind(msg);
    var t = document.createElement('span');
    t.className = 'tlog-time';
    t.textContent = '[' + wibNow() + '] ';
    line.appendChild(t);
    var m = String(msg).match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    if (m) {
      var parts = String(msg).split(m[0]);
      line.appendChild(document.createTextNode(parts[0]));
      var b = document.createElement('b');
      b.className = 'tlog-code';
      b.textContent = m[0];
      line.appendChild(b);
      line.appendChild(document.createTextNode(parts.slice(1).join(m[0])));
    } else {
      line.appendChild(document.createTextNode(msg));
    }
    pre.appendChild(line);
    pre.appendChild(document.createTextNode('\n'));
    var lines = pre.querySelectorAll('.tlog');
    while (lines.length > 80) {
      var first = lines[0];
      var nl = first.nextSibling;
      pre.removeChild(first);
      if (nl && nl.nodeType === 3) pre.removeChild(nl);
      lines = pre.querySelectorAll('.tlog');
    }
    pre.scrollTop = pre.scrollHeight;
  }

  /* ---------------- Validasi nomor (realtime, via server) ---------------- */
  function setPhoneError(msg) {
    var el = $('phoneError');
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; el.textContent = ''; }
  }

  function renderChips() {
    var wrap = $('phoneChips');
    if (!wrap) return;
    var r = state.region;
    if (!state.phoneValid || !r) { wrap.hidden = true; wrap.innerHTML = ''; return; }
    wrap.innerHTML = '';
    var regionChip = document.createElement('span');
    regionChip.className = 'chip';
    regionChip.innerHTML = '';
    var flag = document.createElement('span');
    flag.className = 'chip-flag'; flag.textContent = r.flag || '🌐';
    regionChip.appendChild(flag);
    regionChip.appendChild(document.createTextNode((r.countryName || r.country || '—') + ' ' + (r.callingCode || '')));
    wrap.appendChild(regionChip);

    var carrier = r.carrier || 'unknown';
    var opChip = document.createElement('span');
    opChip.className = 'chip';
    if (carrier === 'unknown') {
      opChip.classList.add('muted');
      opChip.textContent = 'Operator tidak dikenal';
    } else {
      var slug = findOperatorSlug(carrier);
      if (slug) {
        var img = document.createElement('img');
        img.src = '/operators/' + slug + '.svg?v=2';
        img.alt = 'Logo ' + carrier;
        img.loading = 'lazy';
        opChip.appendChild(img);
      }
      opChip.appendChild(document.createTextNode(carrier));
    }
    wrap.appendChild(opChip);
    wrap.hidden = false;
  }

  function showNormalized() {
    var el = $('phoneNormalized');
    if (!el) return;
    if (state.phoneValid && state.phone) {
      el.innerHTML = '';
      el.appendChild(document.createTextNode('Nomor ternormalisasi: '));
      var code = document.createElement('code');
      code.textContent = state.phone;
      el.appendChild(code);
      el.hidden = false;
    } else { el.hidden = true; }
  }

  function setMethodBlockVisible(show) {
    var mb = $('methodBlock');
    // Pilih Metode HANYA muncul setelah server mengonfirmasi nomor valid
    // (numberChecked). Validasi lokal saja tidak cukup — itu yang bikin
    // kartu metode muncul terlalu dini saat nomor baru diketik.
    if (mb) mb.hidden = !(show && state.numberChecked);
  }

  /* ---- Kartu hasil cek nomor (langkah 1.5) ----
     checking = sedang dicek server, valid = nomor valid (metode muncul),
     invalid = nomor tidak valid + alasannya, hide = belum ada nomor. */
  function setNumberCheck(kind, text) {
    var card = $('numberCheck');
    if (!card) return;
    var t = $('numberCheckText');
    if (kind === 'hide') { card.hidden = true; card.className = 'number-check'; if (t) t.textContent = ''; return; }
    card.hidden = false;
    card.className = 'number-check nc-' + kind;
    if (t) t.textContent = text || '';
    // Saat kartu cek menampilkan invalid, phoneError disembunyikan supaya
    // alasan yang sama tidak tampil dua kali (di kartu + di bawah input).
    if (kind === 'invalid') setPhoneError('');
  }

  /* ---- Tombol hapus nomor (×) di dalam input ----
     Nomor tersimpan di localStorage (restoreSaved) — tanpa tombol ini nomor
     yang sudah dihapus manual tetap muncul lagi saat refresh, karena
     cabang kosong validatePhoneLocal tidak memanggil saveState(). */
  function updatePhoneClearBtn() {
    var btn = $('phoneClearBtn');
    var input = $('phoneInput');
    if (!btn || !input) return;
    btn.hidden = !(input.value || '').trim();
  }
  function clearPhoneNumber() {
    var input = $('phoneInput');
    if (input) { input.value = ''; input.classList.remove('is-valid', 'is-invalid'); input.focus(); }
    state.phone = ''; state.phoneValid = false; state.region = null; state.numberChecked = false;
    state.method = null;
    // Hapus nomor tersimpan supaya tidak muncul lagi saat refresh.
    var sv = loadState() || {};
    sv.phone = ''; sv.method = ''; sv.codeMode = ''; sv.customCode = ''; sv.code = ''; sv.qrDataUrl = ''; sv.expiresAt = 0;
    try { localStorage.setItem(STATE_KEY, JSON.stringify(sv)); } catch (e) { /* abaikan */ }
    lastPrefsPhone = '';
    setNumberCheck('hide');
    setPhoneError('');
    renderChips(); showNormalized(); setMethodBlockVisible(false);
    $$('.method-card').forEach(function (card) { card.classList.remove('selected'); card.setAttribute('aria-pressed', 'false'); });
    var po = $('pairingOptions'); if (po) po.hidden = true;
    var qo = $('qrOptions'); if (qo) qo.hidden = true;
    updatePhoneClearBtn();
    updateRequestBtn();
  }

  /* ---- Deteksi lokal instan (tanpa jaringan, 0ms) ----
     Duplikasi src/phone.js (peta prefix) supaya region + operator
     muncul di tiap ketikan, bukan menunggu fetch server. Server tetap
     sumber kebenaran dan mengoreksi bila berbeda. */
  var LOCAL_COUNTRY_PREFIXES = {
    '62': { country: 'ID', flag: '🇮🇩' }, '60': { country: 'MY', flag: '🇲🇾' },
    '65': { country: 'SG', flag: '🇸🇬' }, '1': { country: 'US', flag: '🇺🇸' },
    '91': { country: 'IN', flag: '🇮🇳' }, '44': { country: 'GB', flag: '🇬🇧' },
    '81': { country: 'JP', flag: '🇯🇵' }, '82': { country: 'KR', flag: '🇰🇷' },
    '86': { country: 'CN', flag: '🇨🇳' }, '61': { country: 'AU', flag: '🇦🇺' },
    '33': { country: 'FR', flag: '🇫🇷' }, '49': { country: 'DE', flag: '🇩🇪' },
    '31': { country: 'NL', flag: '🇳🇱' }, '34': { country: 'ES', flag: '🇪🇸' },
    '39': { country: 'IT', flag: '🇮🇹' }, '55': { country: 'BR', flag: '🇧🇷' },
    '52': { country: 'MX', flag: '🇲🇽' }, '63': { country: 'PH', flag: '🇵🇭' },
    '84': { country: 'VN', flag: '🇻🇳' }, '66': { country: 'TH', flag: '🇹🇭' },
    '90': { country: 'TR', flag: '🇹🇷' }, '7': { country: 'RU', flag: '🇷🇺' },
    '20': { country: 'EG', flag: '🇪🇬' }, '27': { country: 'ZA', flag: '🇿🇦' },
    '234': { country: 'NG', flag: '🇳🇬' }, '92': { country: 'PK', flag: '🇵🇰' },
    '880': { country: 'BD', flag: '🇧🇩' }
  };
  var LOCAL_CARRIER_PREFIXES = {
    '0811': 'Telkomsel', '0812': 'Telkomsel', '0813': 'Telkomsel',
    '0821': 'Telkomsel', '0822': 'Telkomsel', '0823': 'Telkomsel',
    '0851': 'by.U (Telkomsel)', '0852': 'Telkomsel', '0853': 'Telkomsel',
    '0814': 'Indosat', '0815': 'Indosat', '0816': 'Indosat',
    '0855': 'Indosat', '0856': 'Indosat', '0857': 'Indosat', '0858': 'Indosat',
    '0817': 'XL', '0818': 'XL', '0819': 'XL', '0859': 'XL', '0877': 'XL', '0878': 'XL',
    '0831': 'Axis', '0832': 'Axis', '0833': 'Axis', '0838': 'Axis',
    '0895': 'Tri', '0896': 'Tri', '0897': 'Tri', '0898': 'Tri', '0899': 'Tri',
    '0881': 'Smartfren', '0882': 'Smartfren', '0883': 'Smartfren', '0884': 'Smartfren',
    '0885': 'Smartfren', '0886': 'Smartfren', '0887': 'Smartfren', '0888': 'Smartfren', '0889': 'Smartfren'
  };
  var _localDisplayNames = null;
  try { _localDisplayNames = new Intl.DisplayNames(['id'], { type: 'region' }); } catch (e) { /* abaikan */ }
  function localCountryNameOf(cc) {
    if (!cc) return 'Tidak dikenal';
    try { return (_localDisplayNames && _localDisplayNames.of(cc)) || cc; } catch (e) { return cc; }
  }
  function detectCarrierLocal(digits) {
    if (digits.slice(0, 2) !== '62' || digits.length < 6) return null;
    return LOCAL_CARRIER_PREFIXES['0' + digits.slice(2, 5)] || 'unknown';
  }
  function detectRegionLocal(digits) {
    var codes = Object.keys(LOCAL_COUNTRY_PREFIXES).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < codes.length; i++) {
      if (digits.indexOf(codes[i]) === 0) {
        var info = LOCAL_COUNTRY_PREFIXES[codes[i]];
        return {
          country: info.country, countryName: localCountryNameOf(info.country),
          flag: info.flag, callingCode: codes[i],
          valid: digits.length >= 10 && digits.length <= 15, type: 'unknown',
          carrier: detectCarrierLocal(digits)
        };
      }
    }
    return {
      country: null, countryName: 'Tidak dikenal', flag: '🌐', callingCode: null,
      valid: false, type: 'unknown', carrier: null
    };
  }
  function validatePhoneLocal() {
    var input = $('phoneInput');
    if (!input) return;
    var raw = input.value || '';
    var digits = normalizePhone(raw);
    state.phone = digits;
    state.numberChecked = false; // nomor berubah -> harus dicek ulang server
    if (validateAbort) { try { validateAbort.abort(); } catch (e) { /* abaikan */ } }
    if (!digits) {
      state.phoneValid = false; state.region = null;
      // Ada digit tapi tanpa kode negara (mis. 89...) -> minta kode negara.
      var rawDigits = String(raw || '').replace(/\D/g, '');
      if (rawDigits) {
        input.classList.remove('is-valid'); input.classList.add('is-invalid');
        setPhoneError('Masukkan kode negara di depan nomor — contoh 62 (Indonesia), 60 (Malaysia), 1 (Amerika). Nomor Indonesia diawali 0 atau 62.');
        setNumberCheck('invalid', 'Masukkan kode negara di depan nomor — contoh 62 (Indonesia), 60 (Malaysia), 1 (Amerika). Nomor Indonesia diawali 0 atau 62.');
        renderChips(); showNormalized(); setMethodBlockVisible(false);
        updatePhoneClearBtn();
        updateRequestBtn();
        saveState();
        return;
      }
      // Benar-benar kosong.
      input.classList.remove('is-valid', 'is-invalid');
      setPhoneError('');
      setNumberCheck('hide');
      renderChips(); showNormalized(); setMethodBlockVisible(false);
      updatePhoneClearBtn();
      updateRequestBtn();
      saveState(); // nomor dihapus -> simpan kosong supaya tidak balik saat refresh
      return;
    }
    if (/[a-zA-Z]/.test(raw)) {
      state.phoneValid = false; state.region = null;
      input.classList.remove('is-valid'); input.classList.add('is-invalid');
      setPhoneError('Nomor hanya boleh berisi angka (tanpa huruf).');
      setNumberCheck('invalid', 'Nomor hanya boleh berisi angka (tanpa huruf).');
      renderChips(); showNormalized(); setMethodBlockVisible(false);
      updateRequestBtn();
      return;
    }
    if (digits.length < 6) {
      state.phoneValid = false; state.region = null;
      input.classList.remove('is-valid'); input.classList.add('is-invalid');
      setPhoneError('Nomor terlalu pendek. Masukkan nomor WhatsApp yang lengkap.');
      setNumberCheck('invalid', 'Nomor terlalu pendek. Masukkan nomor WhatsApp yang lengkap.');
      renderChips(); showNormalized(); setMethodBlockVisible(false);
      updateRequestBtn();
      return;
    }
    var region = detectRegionLocal(digits);
    if (!region.country) {
      // Kode negara di luar tabel lokal. Tapi nomor WhatsApp paling pendek
      // 10 digit (aturan server) — kalau kurang dari itu, sudah pasti
      // belum lengkap, tidak perlu tunggu server.
      if (digits.length < 10) {
        state.phoneValid = false; state.region = null;
        input.classList.remove('is-valid'); input.classList.add('is-invalid');
        setPhoneError('Nomor terlalu pendek. Masukkan nomor WhatsApp yang lengkap.');
        setNumberCheck('invalid', 'Nomor terlalu pendek. Masukkan nomor WhatsApp yang lengkap.');
        renderChips(); showNormalized(); setMethodBlockVisible(false);
        updateRequestBtn();
        return;
      }
      // 10+ digit tapi prefix asing: jangan vonis dulu, tunggu server.
      state.phoneValid = false; state.region = null;
      input.classList.remove('is-valid', 'is-invalid');
      setPhoneError('');
      setNumberCheck('checking', 'Memeriksa nomor…');
      renderChips(); showNormalized(); setMethodBlockVisible(false);
      updateRequestBtn();
      return;
    }
    if (digits.length > 15) {
      state.phoneValid = false; state.region = region;
      input.classList.remove('is-valid'); input.classList.add('is-invalid');
      setPhoneError('Nomor terlalu panjang — maksimal 15 digit (termasuk kode negara).');
      setNumberCheck('invalid', 'Nomor terlalu panjang — maksimal 15 digit (termasuk kode negara).');
      renderChips(); showNormalized(); setMethodBlockVisible(false);
      updateRequestBtn();
      return;
    }
    state.phoneValid = region.valid; state.region = region;
    if (region.valid) {
      input.classList.add('is-valid'); input.classList.remove('is-invalid');
      setPhoneError('');
      loadOperators().then(function () { renderChips(); });
      renderChips();
      showNormalized();
      // Valid lokal = baru "sedang dicek". Pilih Metode tetap sembunyi
      // sampai server mengonfirmasi (validatePhone -> numberChecked).
      setMethodBlockVisible(false);
      setNumberCheck('checking', 'Memeriksa nomor…');
    } else {
      input.classList.remove('is-valid'); input.classList.add('is-invalid');
      setPhoneError('Nomor terlalu pendek. Masukkan nomor WhatsApp yang lengkap.');
      setNumberCheck('invalid', 'Nomor terlalu pendek. Masukkan nomor WhatsApp yang lengkap.');
      renderChips(); showNormalized(); setMethodBlockVisible(false);
    }
    updateRequestBtn();
    updatePhoneClearBtn();
    saveState();
  }

  function validatePhone() {
    var input = $('phoneInput');
    if (!input) return;
    var digits = normalizePhone(input.value);
    state.phone = digits;

    if (validateAbort) { try { validateAbort.abort(); } catch (e) { /* abaikan */ } }
    if (!digits) {
      state.phoneValid = false; state.region = null;
      // Ada digit tapi tanpa kode negara (mis. 89...) -> minta kode negara.
      // Tanpa ini, cabang ini menimpa pesan validatePhoneLocal setelah 300ms.
      var rawDigits2 = String(input.value || '').replace(/\D/g, '');
      if (rawDigits2) {
        input.classList.remove('is-valid'); input.classList.add('is-invalid');
        setPhoneError('Masukkan kode negara di depan nomor — contoh 62 (Indonesia), 60 (Malaysia), 1 (Amerika). Nomor Indonesia diawali 0 atau 62.');
        setNumberCheck('invalid', 'Masukkan kode negara di depan nomor — contoh 62 (Indonesia), 60 (Malaysia), 1 (Amerika). Nomor Indonesia diawali 0 atau 62.');
        renderChips(); showNormalized(); setMethodBlockVisible(false);
        updateRequestBtn();
        return;
      }
      input.classList.remove('is-valid', 'is-invalid');
      setPhoneError('');
      setNumberCheck('hide');
      renderChips(); showNormalized(); setMethodBlockVisible(false);
      updateRequestBtn();
      return;
    }
    if (digits.length < 6) {
      state.phoneValid = false; state.region = null;
      input.classList.remove('is-valid'); input.classList.add('is-invalid');
      setPhoneError('Nomor terlalu pendek. Masukkan nomor WhatsApp yang lengkap.');
      setNumberCheck('invalid', 'Nomor terlalu pendek. Masukkan nomor WhatsApp yang lengkap.');
      renderChips(); showNormalized(); setMethodBlockVisible(false);
      updateRequestBtn();
      return;
    }

    validateAbort = new AbortController();
    fetch('/api/session/status?phone=' + encodeURIComponent(digits), { signal: validateAbort.signal })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          // Server MERESPON tapi menolak nomornya (mis. terlalu pendek) —
          // itu BUKAN masalah koneksi. Tampilkan alasan aslinya supaya
          // pintar: valid atau tidak, dan kenapa. Pesan "cek koneksi" hanya
          // untuk fetch yang benar-benar gagal (lihat .catch di bawah).
          state.phoneValid = false; state.region = null; state.numberChecked = false;
          input.classList.remove('is-valid'); input.classList.add('is-invalid');
          setPhoneError((d && d.error) ? d.error : 'Tidak bisa mengecek nomor. Periksa koneksimu lalu coba lagi.');
          setNumberCheck('invalid', (d && d.error) ? d.error : 'Tidak bisa mengecek nomor. Periksa koneksimu lalu coba lagi.');
          renderChips(); showNormalized(); setMethodBlockVisible(false);
          updateRequestBtn();
          return;
        }
        var region = d.region || {};
        if (region.valid) {
          state.phoneValid = true; state.region = region; state.numberChecked = true;
          input.classList.add('is-valid'); input.classList.remove('is-invalid');
          setPhoneError('');
          loadOperators().then(function () { renderChips(); });
          renderChips();
          showNormalized();
          // Nomor terkonfirmasi server -> kartu cek hijau + Pilih Metode muncul otomatis.
          var ncDetail = (region.countryName || region.country || '') + (region.carrier && region.carrier !== 'unknown' ? ' · ' + region.carrier : '');
          setNumberCheck('valid', 'Nomor valid' + (ncDetail ? ' — ' + ncDetail : '') + '. Pilih metode di bawah.');
          setMethodBlockVisible(true);
          // Jika server sudah punya status aktif untuk nomor ini, pulihkan tampilannya.
          if (d.status && d.status !== 'idle') applyStatus(d);
          restoreNumberPrefs(digits);
        } else {
          state.phoneValid = false; state.region = region; state.numberChecked = false;
          input.classList.remove('is-valid'); input.classList.add('is-invalid');
          setPhoneError('Nomor tidak valid. Periksa lagi nomor WhatsApp kamu — pastikan kode negara & nomornya benar.');
          setNumberCheck('invalid', 'Nomor tidak valid. Periksa lagi nomor WhatsApp kamu — pastikan kode negara & nomornya benar.');
          renderChips(); showNormalized(); setMethodBlockVisible(false);
        }
        updateRequestBtn();
        saveState();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        state.phoneValid = false; state.numberChecked = false;
        input.classList.remove('is-valid'); input.classList.add('is-invalid');
        setPhoneError('Tidak bisa mengecek nomor. Periksa koneksimu lalu coba lagi.');
        setNumberCheck('invalid', 'Tidak bisa mengecek nomor. Periksa koneksimu lalu coba lagi.');
        renderChips(); showNormalized(); setMethodBlockVisible(false);
        updateRequestBtn();
      });
  }

  function initPhoneInput() {
    var input = $('phoneInput');
    if (!input) return;
    input.addEventListener('input', function () {
      validatePhoneLocal(); // instan, 0ms — chip region/operator langsung muncul
      updatePhoneClearBtn();
      if (validateTimer) clearTimeout(validateTimer);
      validateTimer = setTimeout(validatePhone, 300); // konfirmasi server
    });
    input.addEventListener('paste', function () {
      validatePhoneLocal();
      updatePhoneClearBtn();
      if (validateTimer) clearTimeout(validateTimer);
      validateTimer = setTimeout(validatePhone, 300);
    });
    var clearBtn = $('phoneClearBtn');
    if (clearBtn) clearBtn.addEventListener('click', function (e) {
      e.preventDefault();
      clearPhoneNumber();
      if (validateTimer) clearTimeout(validateTimer);
    });
    updatePhoneClearBtn();
  }

  /* ---------------- Preferensi nomor (DATA_NOMER) ---------------- */
  // Kode custom disimpan per nomor di server; saat nomor yang sama
  // dimasukkan lagi, kode customnya dipulihkan otomatis.
  function restoreNumberPrefs(phone) {
    if (!phone || phone === lastPrefsPhone) return;
    lastPrefsPhone = phone;
    // Bersihkan kode nomor sebelumnya supaya tidak nyangkut ke nomor baru.
    var ci = $('customCodeInput'); if (ci) ci.value = '';
    state.customCode = '';
    var rnd = document.querySelector('input[name="codeMode"][value="random"]');
    if (rnd) rnd.checked = true;
    state.codeMode = 'random';
    var wrap = $('customCodeWrap'); if (wrap) wrap.hidden = true;
    refreshCustomPreview();
    fetch('/api/number/prefs?phone=' + encodeURIComponent(phone))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok || !d.prefs || !d.prefs.customCode) return;
        if (normalizePhone(($('phoneInput') || {}).value || '') !== phone) return;
        var input = $('customCodeInput'); if (!input) return;
        input.value = d.prefs.customCode;
        var cus = document.querySelector('input[name="codeMode"][value="custom"]');
        if (cus) cus.checked = true;
        state.codeMode = 'custom';
        if (wrap) wrap.hidden = false;
        refreshCustomPreview();
      })
      .catch(function () { /* abaikan — tanpa prefs tetap jalan */ });
  }
  function scheduleSaveNumberPrefs() {
    if (savePrefsTimer) clearTimeout(savePrefsTimer);
    savePrefsTimer = setTimeout(function () {
      var phone = state.phone, code = state.customCode || '';
      if (!phone || !state.phoneValid || state.codeMode !== 'custom' || !code) return;
      fetch('/api/number/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phone, customCode: code, method: state.method || 'pairing', codeMode: 'custom' }) }).catch(function () {});
    }, 600);
  }

  /* ---------------- Metode & kode custom ---------------- */
  function selectMethod(method) {
    state.method = method;
    $$('.method-card').forEach(function (card) {
      var on = card.getAttribute('data-method') === method;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var po = $('pairingOptions'); if (po) po.hidden = method !== 'pairing';
    var qo = $('qrOptions'); if (qo) qo.hidden = method !== 'qr';
    renderTutorial();
    renderPipeline();
    updateRequestBtn();
    saveState();
  }

  // Tutorial spoiler mengikuti metode yang dipilih: Pairing Code menampilkan
  // langkah pairing, QR Code menampilkan langkah QR.
  function renderTutorial() {
    var isQr = state.method === 'qr';
    var tp = $('tutPairing'); if (tp) tp.hidden = isQr;
    var tq = $('tutQr'); if (tq) tq.hidden = !isQr;
    var tt = $('tutTitle'); if (tt) tt.textContent = isQr ? 'Tutorial QR Code' : 'Tutorial Pairing Code';
  }

  function updateRequestBtn() {
    var btn = $('requestBtn');
    if (!btn) return;
    btn.disabled = !(state.phoneValid && state.method);
    btn.textContent = state.method === 'qr' ? 'Minta QR' : 'Minta Kode';
  }

  function refreshCustomPreview() {
    var input = $('customCodeInput');
    var prev = $('customPreview');
    if (!input || !prev) return;
    var v = String(input.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (input.value !== v) input.value = v;
    state.customCode = v;
    prev.textContent = formatCode8(v);
    saveState();
    scheduleSaveNumberPrefs();
  }

  function initMethodUI() {
    $$('.method-card').forEach(function (card) {
      card.addEventListener('click', function () { selectMethod(card.getAttribute('data-method')); });
    });
    $$('input[name="codeMode"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        state.codeMode = radio.value;
        var wrap = $('customCodeWrap');
        if (wrap) wrap.hidden = radio.value !== 'custom';
        renderPipeline();
        saveState();
        scheduleSaveNumberPrefs();
      });
    });
    var ci = $('customCodeInput');
    if (ci) ci.addEventListener('input', refreshCustomPreview);
    var btn = $('requestBtn');
    if (btn) btn.addEventListener('click', requestPairing);
  }

  /* ---------------- Overlay ---------------- */
  function showOverlay(mode) {
    var ov = $('overlay');
    if (!ov) return;
    ov.hidden = false;
    var c = $('overlayConnecting'); if (c) c.hidden = mode !== 'connecting';
    var s = $('overlaySuccess'); if (s) s.hidden = mode !== 'success';
    document.body.style.overflow = 'hidden';
  }

  function hideOverlay() {
    var ov = $('overlay');
    if (ov) ov.hidden = true;
    document.body.style.overflow = '';
  }

  function showSuccessOverlay() {
    if (state.successOverlayShown) return;
    state.successOverlayShown = true;
    showOverlay('success');
  }

  /* ---------------- Countdown ring ---------------- */
  function updateCountdown() {
    var remaining = 0;
    if (state.expiresAt > 0) remaining = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
    var total = state.totalSeconds || 180;
    var frac = total > 0 ? remaining / total : 0;
    var mm = Math.floor(remaining / 60);
    var ss = remaining % 60;
    var text = mm + ':' + String(ss).padStart(2, '0');
    var rt = $('ringTime'); if (rt) rt.textContent = text;
    var rf = $('ringFg'); if (rf) rf.style.strokeDashoffset = String(RING_C * (1 - frac));
    var rtq = $('ringTimeQr'); if (rtq) rtq.textContent = text;
    var rfq = $('ringFgQr'); if (rfq) rfq.style.strokeDashoffset = String(RING_C * (1 - frac));

    if (state.expiresAt > 0 && remaining <= 0 &&
        (state.status === 'awaiting_code' || state.status === 'awaiting_qr')) {
      expireCode();
    }
  }

  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(updateCountdown, 250);
    updateCountdown();
  }

  function expireCode() {
    state.status = 'expired';
    clearSavedCode();
    hideCodeAreas();
    showFinalNote('Kode kedaluwarsa. Minta kode baru untuk melanjutkan.', true);
    logLine('Kode kedaluwarsa — minta kode baru.');
    updateRequestBtn();
    renderPipeline();
  }

  /* ---------------- Tampilan kode / QR ---------------- */
  /* ---------------- Spoiler kode pairing ---------------- */
  function toggleCodeSpoiler() {
    var body = $('codeSpoilerBody'); var mask = $('codeSpoilerMask'); var btn = $('codeSpoilerBtn');
    if (!body || !mask || !btn) return;
    var show = body.hidden;
    body.hidden = !show; mask.hidden = show;
    var label = btn.querySelector('.code-spoiler-label');
    if (label) label.textContent = show ? 'Sembunyikan Kode' : 'Tampilkan Kode';
    btn.setAttribute('aria-expanded', show ? 'true' : 'false');
  }
  function resetCodeSpoiler() {
    var body = $('codeSpoilerBody'); var mask = $('codeSpoilerMask'); var btn = $('codeSpoilerBtn');
    if (body) body.hidden = true; if (mask) mask.hidden = false;
    if (btn) { var label = btn.querySelector('.code-spoiler-label'); if (label) label.textContent = 'Tampilkan Kode'; btn.setAttribute('aria-expanded', 'false'); }
  }

  function hideCodeAreas() {
    var ca = $('codeArea'); if (ca) ca.hidden = true;
    var qa = $('qrArea'); if (qa) qa.hidden = true;
    var info = $('codeInfo'); if (info) info.hidden = true;
    resetCodeSpoiler();
  }

  function renderCodeBoxes() {
    var wrap = $('codeBoxes');
    if (!wrap) return;
    var raw = String(state.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    wrap.innerHTML = '';
    for (var i = 0; i < 8; i++) {
      var box = document.createElement('span');
      box.className = 'code-box';
      box.textContent = raw.charAt(i) || '·';
      wrap.appendChild(box);
      if (i === 3) {
        var dash = document.createElement('span');
        dash.className = 'code-dash';
        dash.textContent = '–';
        wrap.appendChild(dash);
      }
    }
    var plain = $('codePlain');
    if (plain) plain.textContent = raw ? formatCode8(raw) : '—';
  }

  // Info statis yang selalu tampil bersama kode/QR: nomor, negara, operator,
  // metode, browser — diambil dari hasil validasi (state.region) supaya akurat.
  function renderCodeInfo() {
    var info = $('codeInfo'); if (!info) return;
    var r = state.region || {};
    var set = function (id, text) { var el = $(id); if (el) el.textContent = text; };
    set('ciPhone', state.phone ? '+' + state.phone : '—');
    set('ciRegion', r.countryName ? ((r.flag || '') + ' ' + r.countryName + (r.callingCode ? ' +' + r.callingCode : '')) : '—');
    set('ciCarrier', (r.carrier && r.carrier !== 'unknown') ? r.carrier : 'Operator tidak dikenal');
    set('ciMethod', state.method === 'qr' ? 'QR Code' : (state.codeMode === 'custom' ? 'Pairing Code · Custom' : state.codeMode === 'random' ? 'Pairing Code · Acak' : 'Pairing Code'));
    // Baris lengkap saat terhubung (sesi ada): nomor bot, status, ukuran, kunci.
    var ssn = state.session;
    var showConn = !!(ssn && ssn.exists);
    $$('.ci-connected').forEach(function (row) { row.hidden = !showConn; });
    if (showConn) {
      set('ciBotNumber', state.botNumber || '—');
      var stEl = $('ciStatus');
      var stTxt = state.status === 'delivering' ? 'Mengirim…' : state.status === 'delivered_disconnected' ? 'Terkirim' : 'Terhubung';
      if (stEl) stEl.innerHTML = '<span class="pill-ok">' + stTxt + '</span>';
      set('ciSize', fmtBytes(ssn.sizeBytes));
      set('ciPreKeys', ssn.preKeys != null ? String(ssn.preKeys) : '—');
      set('ciSessions', ssn.sessions != null ? String(ssn.sessions) : '—');
      set('ciIdentityKeys', ssn.identityKeys != null ? String(ssn.identityKeys) : '—');
      var reg = $('ciRegistered');
      if (reg) reg.innerHTML = ssn.registered ? '<span class="pill-ok">Ya</span>' : '<span class="pill-bad">Belum</span>';
    }
    info.hidden = false;
  }

  function showCodeArea() {
    var rb = $('resultBlock'); if (rb) rb.hidden = false;
    var rt = $('resultTitle'); if (rt) rt.textContent = 'Kode Pairing Kamu';
    hideCodeAreas();
    var ca = $('codeArea'); if (ca) ca.hidden = false;
    renderCodeBoxes();
    renderCodeInfo();
    startCountdown();
    var rb2 = $('resultBlock');
    if (rb2) rb2.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showQrArea() {
    var rb = $('resultBlock'); if (rb) rb.hidden = false;
    var rt = $('resultTitle'); if (rt) rt.textContent = 'QR Code WhatsApp';
    hideCodeAreas();
    var qa = $('qrArea'); if (qa) qa.hidden = false;
    var img = $('qrImg');
    if (img && state.qrDataUrl) img.src = state.qrDataUrl;
    renderCodeInfo();
    startCountdown();
    var rb2 = $('resultBlock');
    if (rb2) rb2.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------- Pipeline / sesi / pengiriman ---------------- */
  var PIPE_LABELS = {
    1: { idle: 'Menunggu nomor…', done: 'Nomor valid' },
    2: { idle: 'Pairing Code / QR Code', done: 'Metode dipilih' },
    3: { idle: 'Menunggu kode…', active: 'Kode / QR aktif — segera masukkan', done: 'Kode / QR diterima' },
    4: { idle: 'Menunggu bot terhubung…', active: 'Menghubungkan…', done: 'Bot terhubung ✓' },
    5: { idle: 'File hisoka.json ke owner', active: 'Mengirim sesi ke owner…', done: 'Sesi terkirim ke owner ✓', failed: 'Pengiriman gagal — coba kirim ulang' }
  };

  function setPipe(step, cls, label) {
    var li = document.querySelector('.pipeline li[data-pipe="' + step + '"]');
    if (!li) return;
    li.classList.remove('done', 'active');
    if (cls) li.classList.add(cls);
    var dot = li.querySelector('.pipe-dot');
    if (dot) dot.textContent = cls === 'done' ? '✓' : String(step);
    var span = li.querySelector('.pipe-body span');
    if (span && label) span.textContent = label;
  }

  function renderPipeline() {
    var s = state.status;
    // Setelah sesi terkirim + form di-reset, pipeline kembali fresh (siap
    // nomor berikutnya). Bukti pengiriman ada di blok Pengiriman + catatan
    // akhir — pipeline melacak sesi SAAT INI, jadi tidak boleh nyangkut
    // setengah selesai (langkah 1-2 menunggu tapi 3-5 centang).
    if (s === 'delivered_disconnected' && !state.phone) {
      setPipe(1, '', PIPE_LABELS[1].idle);
      setPipe(2, '', PIPE_LABELS[2].idle);
      setPipe(3, '', PIPE_LABELS[3].idle);
      setPipe(4, '', PIPE_LABELS[4].idle);
      setPipe(5, '', PIPE_LABELS[5].idle);
      return;
    }
    var connectedish = ['connected', 'delivering', 'delivered_disconnected', 'delivery_failed'].indexOf(s) !== -1;
    var awaiting = ['awaiting_code', 'awaiting_qr'].indexOf(s) !== -1;
    var requesting = s === 'connecting';

    // Label langkah 2 tampilkan mode yang dipakai (Custom/Acak/QR).
    var modeLabel = '';
    if (state.method === 'qr') modeLabel = 'QR Code';
    else if (state.method === 'pairing') modeLabel = state.codeMode === 'custom' ? 'Pairing Code · Custom' : 'Pairing Code · Acak';

    setPipe(1, state.phoneValid ? 'done' : '', state.phoneValid ? PIPE_LABELS[1].done : PIPE_LABELS[1].idle);
    setPipe(2, state.method && s !== 'idle' ? 'done' : '', state.method ? (modeLabel || PIPE_LABELS[2].done) : PIPE_LABELS[2].idle);
    setPipe(3, connectedish ? 'done' : (awaiting || requesting ? 'active' : ''),
      connectedish ? PIPE_LABELS[3].done : (awaiting ? PIPE_LABELS[3].active : (requesting ? 'Meminta kode…' : PIPE_LABELS[3].idle)));
    setPipe(4, connectedish ? 'done' : (requesting || awaiting ? 'active' : ''),
      connectedish ? PIPE_LABELS[4].done : (requesting ? PIPE_LABELS[4].active : PIPE_LABELS[4].idle));
    if (s === 'delivered_disconnected') setPipe(5, 'done', PIPE_LABELS[5].done);
    else if (s === 'delivery_failed') setPipe(5, 'active', PIPE_LABELS[5].failed);
    else if (s === 'delivering') setPipe(5, 'active', PIPE_LABELS[5].active);
    else setPipe(5, '', PIPE_LABELS[5].idle);
  }

  /* ---------------- Toast notifikasi realtime ---------------- */
  function showToast(msg, kind) {
    var wrap = $('toasts'); if (!wrap) return;
    var t = document.createElement('div');
    t.className = 'toast toast-' + (kind || 'info');
    var ic = document.createElement('span'); ic.className = 'toast-icon';
    ic.textContent = kind === 'ok' ? '✓' : kind === 'err' ? '!' : 'i';
    var m = document.createElement('span'); m.className = 'toast-msg'; m.textContent = msg;
    var x = document.createElement('button'); x.className = 'toast-close'; x.type = 'button';
    x.setAttribute('aria-label', 'Tutup notifikasi'); x.textContent = '×';
    x.addEventListener('click', function () { removeToast(t); });
    t.appendChild(ic); t.appendChild(m); t.appendChild(x);
    wrap.appendChild(t);
    while (wrap.children.length > 3) wrap.removeChild(wrap.firstChild);
    setTimeout(function () { removeToast(t); }, 5000);
  }
  function removeToast(t) {
    if (!t || !t.parentNode) return;
    t.classList.add('toast-out');
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
  }

  function renderSessionTable() {
    var table = $('sessionTable');
    if (!table) return;
    var s = state.session;
    var show = !!(s && (s.exists || state.status !== 'idle') && state.status !== 'delivered_disconnected');
    table.hidden = !show;
    if (!show) return;
    var set = function (id, val) { var el = $(id); if (el) el.textContent = val; };
    set('stBotNumber', state.botNumber || '—');
    set('stFile', state.sessionFile || ('sessions/' + state.phone + '/hisoka.json'));
    set('stSize', fmtBytes(s ? s.sizeBytes : null));
    set('stPreKeys', s && s.preKeys != null ? String(s.preKeys) : '—');
    set('stSessions', s && s.sessions != null ? String(s.sessions) : '—');
    set('stIdentityKeys', s && s.identityKeys != null ? String(s.identityKeys) : '—');
    var reg = $('stRegistered');
    if (reg) reg.innerHTML = s && s.registered ? '<span class="pill-ok">Ya</span>' : '<span class="pill-bad">Belum</span>';
    set('stMe', s && s.me ? String(s.me) : '—');
  }

  function renderDelivery() {
    var block = $('deliveryBlock');
    if (!block) return;
    var s = state.status;
    var show = ['connected', 'delivering', 'delivered_disconnected', 'delivery_failed'].indexOf(s) !== -1;
    block.hidden = !show;
    if (!show) return;

    var mark = function (key, cls) {
      var step = document.querySelector('.delivery-step[data-delivery="' + key + '"]');
      if (!step) return;
      step.classList.remove('done', 'active', 'failed');
      if (cls) step.classList.add(cls);
      var icon = step.querySelector('.ds-icon');
      if (icon) icon.textContent = cls === 'done' ? '✅' : (cls === 'failed' ? '❌' : (cls === 'active' ? '⏳' : icon.textContent));
    };

    var sess = state.session || {};
    var maximal = !!(sess.exists && sess.registered && (sess.sizeBytes || 0) > 0);
    if (state.delivery) {
      mark('wait', 'done'); mark('check', 'done'); mark('sent', 'done');
    } else if (s === 'delivered_disconnected') {
      // Status bilang terkirim tapi catatan delivery belum tersimpan
      // (state lama) — jangan nyangkut di langkah 1, tandai semua selesai.
      mark('wait', 'done'); mark('check', 'done'); mark('sent', 'done');
    } else if (s === 'delivering') {
      mark('wait', 'done'); mark('check', 'done'); mark('sent', 'active');
    } else if (s === 'delivery_failed') {
      mark('wait', maximal ? 'done' : 'active'); mark('check', 'failed'); mark('sent', 'failed');
    } else {
      mark('wait', maximal ? 'done' : 'active'); mark('check', ''); mark('sent', '');
    }

    var sentText = $('deliverySentText');
    if (sentText) {
      if (state.delivery) {
        sentText.textContent = 'Terkirim ' + (state.delivery.sentAtWib || '') + ' · ' + fmtBytes(state.delivery.sizeBytes) + ' · ke ' + (state.delivery.owner || 'owner');
      } else if (s === 'delivering') {
        sentText.textContent = 'Sedang mengirim file hisoka.json ke owner…';
      } else if (s === 'delivered_disconnected') {
        sentText.textContent = 'Sesi terkirim ke owner.';
      } else {
        sentText.textContent = 'Belum terkirim.';
      }
    }
    var errEl = $('deliveryErrorText');
    if (errEl) {
      if (state.deliveryError) { errEl.textContent = 'Gagal mengirim: ' + state.deliveryError; errEl.hidden = false; }
      else { errEl.hidden = true; errEl.textContent = ''; }
    }
    var sendBtn = $('sendOwnerBtn');
    if (sendBtn) sendBtn.hidden = !(s === 'delivery_failed' || (s === 'connected' && maximal && !state.delivery));
    var logoutBtn = $('logoutBtn');
    if (logoutBtn) logoutBtn.hidden = !(s === 'connected' || s === 'delivering' || s === 'delivered_disconnected' || s === 'delivery_failed');
  }

  /* ---------------- Reset form setelah sesi terkirim ---------------- */
  // Form (nomor + metode + kode custom) kembali bersih, tapi blok hasil
  // (pengiriman + terminal + catatan) tetap tampil sebagai bukti.
  function resetPairingForm() {
    var pi = $('phoneInput'); if (pi) { pi.value = ''; pi.classList.remove('is-valid', 'is-invalid'); }
    updatePhoneClearBtn();
    var pc = $('phoneChips'); if (pc) { pc.innerHTML = ''; pc.hidden = true; }
    var pe = $('phoneError'); if (pe) { pe.hidden = true; pe.textContent = ''; }
    var pn = $('phoneNormalized'); if (pn) { pn.hidden = true; pn.textContent = ''; }
    var mb = $('methodBlock'); if (mb) mb.hidden = true;
    var po = $('pairingOptions'); if (po) po.hidden = true;
    var qo = $('qrOptions'); if (qo) qo.hidden = true;
    $$('.method-card').forEach(function (card) { card.classList.remove('selected'); card.setAttribute('aria-pressed', 'false'); });
    var rnd = document.querySelector('input[name="codeMode"][value="random"]');
    if (rnd) rnd.checked = true;
    state.codeMode = 'random';
    var wrap = $('customCodeWrap'); if (wrap) wrap.hidden = true;
    var ci = $('customCodeInput'); if (ci) ci.value = '';
    state.customCode = '';
    var prev = $('customPreview'); if (prev) prev.textContent = '';
    state.phone = ''; state.method = ''; state.code = ''; state.qrDataUrl = ''; state.expiresAt = 0;
    state.phoneValid = false;
    lastPrefsPhone = '';
    var sv = loadState() || {};
    sv.phone = ''; sv.method = ''; sv.codeMode = ''; sv.customCode = ''; sv.code = ''; sv.qrDataUrl = ''; sv.expiresAt = 0; sv.status = 'delivered_disconnected';
    sv.delivery = state.delivery; sv.session = state.session; sv.sessionFile = state.sessionFile; sv.deliveryError = state.deliveryError;
    try { localStorage.setItem(STATE_KEY, JSON.stringify(sv)); } catch (e) { /* abaikan */ }
    updateRequestBtn(); renderTutorial();
  }

  function showFinalNote(msg, isError) {
    var el = $('finalNote');
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
  }

  /* ---------------- Terapkan status dari server / WS ---------------- */
  function applyStatus(d) {
    if (!d) return;
    var prev = state.status;
    if (d.status) state.status = d.status;
    if (d.phone) state.phone = d.phone;
    if (d.region) state.region = d.region;
    if (d.method) state.method = d.method;
    if (d.codeMode !== undefined) state.codeMode = d.codeMode || '';
    if (d.code) state.code = d.code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (d.qrDataUrl) state.qrDataUrl = d.qrDataUrl;
    if (d.botNumber) state.botNumber = d.botNumber;
    if (d.delivery !== undefined) state.delivery = d.delivery;
    if (d.deliveryError !== undefined) state.deliveryError = d.deliveryError || '';
    if (d.session) state.session = d.session;
    if (d.sessionFile) state.sessionFile = d.sessionFile;
    if (d.expiresIn != null && (state.status === 'awaiting_code' || state.status === 'awaiting_qr')) {
      state.expiresAt = Date.now() + d.expiresIn * 1000;
      state.totalSeconds = d.expiresIn;
    }

    // Log perubahan status (sekali per status).
    if (state.status !== prev || state.status !== lastStatusLogged) {
      var labels = {
        connecting: 'Menghubungkan ke WhatsApp…',
        awaiting_code: 'Kode pairing diterima — masukkan di WhatsApp sebelum kedaluwarsa.',
        awaiting_qr: 'QR diterima — pindai dengan WhatsApp.',
        connected: 'Bot terhubung — sesi tertaut! Kirim manual lewat tombol Kirim Session.',
        delivering: 'hisoka.json maksimal — mengirim ke owner…',
        delivered_disconnected: 'Sesi terkirim ke owner. Sesi web terputus otomatis.',
        delivery_failed: 'Pengiriman ke owner gagal.',
        invalid: 'Sesi tidak valid.',
        expired: 'Kode / QR kedaluwarsa.'
      };
      if (labels[state.status]) logLine(labels[state.status]);
      var toastMsgs = {
        awaiting_code: 'Kode pairing terbit — masukkan di WhatsApp.',
        awaiting_qr: 'QR terbit — pindai dengan WhatsApp.',
        connected: 'Bot terhubung — sesi tertaut!',
        delivering: 'Mengirim sesi ke owner…',
        delivered_disconnected: 'Sesi terkirim ke owner.',
        delivery_failed: 'Pengiriman ke owner gagal.',
        invalid: 'Sesi tidak valid.',
        expired: 'Kode / QR kedaluwarsa.'
      };
      var toastKinds = { awaiting_code: 'info', awaiting_qr: 'info', connected: 'ok', delivering: 'info', delivered_disconnected: 'ok', delivery_failed: 'err', invalid: 'err', expired: 'err' };
      if (toastMsgs[state.status]) showToast(toastMsgs[state.status], toastKinds[state.status]);
      lastStatusLogged = state.status;
    }

    if (state.status === 'awaiting_code' && state.code) {
      hideOverlay();
      showCodeArea();
    } else if (state.status === 'awaiting_qr' && state.qrDataUrl) {
      hideOverlay();
      showQrArea();
    } else if (state.status === 'connected') {
      hideCodeAreas();
      renderCodeInfo(); // info statis tetap tampil + lengkap saat terhubung
      showSuccessOverlay();
      var rb = $('resultBlock'); if (rb) rb.hidden = false;
    } else if (state.status === 'delivered_disconnected') {
      hideCodeAreas();
      showFinalNote('Sesi terkirim ke owner, sesi web terputus otomatis — file hisoka.json tetap tersimpan di ' + (state.sessionFile || ('sessions/' + state.phone + '/hisoka.json')) + '.', false);
      clearSavedCode();
      resetPairingForm(); // form bersih — siap nomor berikutnya
    } else if (state.status === 'delivery_failed') {
      showFinalNote('Pengiriman sesi ke owner gagal. Coba kirim ulang dengan tombol "Kirim ke Owner".', true);
    } else if (state.status === 'expired') {
      hideCodeAreas();
      showFinalNote('Kode / QR kedaluwarsa. Minta kode baru untuk melanjutkan.', true);
      clearSavedCode();
    } else if (state.status === 'invalid') {
      hideCodeAreas();
      showFinalNote('Sesi tidak valid. Coba lagi dengan nomor yang sama atau nomor baru.', true);
    }

    // Sinkronkan pilihan metode di UI bila datang dari server.
    if (state.method) {
      $$('.method-card').forEach(function (card) {
        var on = card.getAttribute('data-method') === state.method;
        card.classList.toggle('selected', on);
        card.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      var po = $('pairingOptions'); if (po) po.hidden = state.method !== 'pairing';
      var qo = $('qrOptions'); if (qo) qo.hidden = state.method !== 'qr';
    }

    renderPipeline();
    renderSessionTable();
    renderDelivery();
    if (state.status === 'connected' || state.status === 'delivering') renderCodeInfo();
    renderTutorial();
    updateRequestBtn();
    updateCountdown();
    saveState();
  }

  /* ---------------- Aksi ---------------- */
  function requestPairing() {
    if (!state.phoneValid || !state.method) return;
    var body = { phone: state.phone, method: state.method, codeMode: state.codeMode };
    if (state.codeMode === 'custom' && state.customCode) body.customCode = state.customCode;
    state.successOverlayShown = false;
    state.delivery = null; state.deliveryError = '';
    showFinalNote('');
    showOverlay('connecting');
    var ct = $('overlayConnectingText');
    if (ct) ct.textContent = state.method === 'qr' ? 'Meminta QR ke WhatsApp, tunggu sebentar.' : 'Meminta kode pairing ke WhatsApp, tunggu sebentar.';
    logLine('Meminta ' + (state.method === 'qr' ? 'QR Code' : 'Pairing Code') + ' untuk ' + state.phone + '…');
    state.status = 'connecting';
    renderPipeline();

    fetch('/api/pairing/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) {
        hideOverlay();
        var msg = (d && d.error) || 'Gagal meminta kode. Coba lagi.';
        showFinalNote(msg, true);
        var rb = $('resultBlock'); if (rb) rb.hidden = false;
        logLine('Gagal: ' + msg);
        state.status = 'idle';
        renderPipeline();
        return;
      }
      applyStatus(d);
      if (d.status === 'awaiting_code' || d.status === 'awaiting_qr') hideOverlay();
    }).catch(function () {
      hideOverlay();
      showFinalNote('Tidak bisa terhubung ke server. Periksa koneksimu lalu coba lagi.', true);
      var rb = $('resultBlock'); if (rb) rb.hidden = false;
      logLine('Gagal: tidak bisa terhubung ke server.');
      state.status = 'idle';
      renderPipeline();
    });
  }

  function cancelPairing() {
    if (!state.phone) { hideOverlay(); return; }
    fetch('/api/pairing/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: state.phone })
    }).catch(function () { /* abaikan */ });
    hideOverlay();
    hideCodeAreas();
    state.status = 'idle';
    state.code = ''; state.qrDataUrl = ''; state.expiresAt = 0;
    clearSavedCode();
    logLine('Dibatalkan oleh pengguna.');
    showFinalNote('Dibatalkan. Minta kode baru kapan pun kamu siap.', false);
    var rb = $('resultBlock'); if (rb) rb.hidden = false;
    renderPipeline(); updateRequestBtn();
  }

  function sendToOwner() {
    if (!state.phone) return;
    logLine('Mengirim hisoka.json ke owner secara manual…');
    fetch('/api/session/send-to-owner', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: state.phone, force: true })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d) applyStatus(d);
      if (!d || !d.ok) logLine('Gagal mengirim ke owner: ' + ((d && d.error) || 'kesalahan server'));
    }).catch(function () { logLine('Gagal mengirim ke owner: tidak bisa terhubung ke server.'); });
  }

  function logoutSession() {
    if (!state.phone) return;
    fetch('/api/pairing/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: state.phone })
    }).catch(function () { /* abaikan */ });
    logLine('Sesi diputuskan.');
    resetAll(false);
  }

  function resetAll(clearPhone) {
    state.status = 'idle';
    state.code = ''; state.qrDataUrl = ''; state.expiresAt = 0;
    state.delivery = null; state.deliveryError = ''; state.session = null;
    state.successOverlayShown = false;
    clearSavedCode();
    hideOverlay(); hideCodeAreas();
    var rb = $('resultBlock'); if (rb) rb.hidden = true;
    var db = $('deliveryBlock'); if (db) db.hidden = true;
    var st = $('sessionTable'); if (st) st.hidden = true;
    showFinalNote('');
    if (clearPhone) {
      var input = $('phoneInput');
      if (input) { input.value = ''; input.classList.remove('is-valid', 'is-invalid'); input.focus(); }
      state.phone = ''; state.phoneValid = false; state.region = null; state.numberChecked = false;
      setMethodBlockVisible(false);
      setNumberCheck('hide');
      renderChips(); showNormalized(); setPhoneError('');
      $$('.method-card').forEach(function (card) { card.classList.remove('selected'); card.setAttribute('aria-pressed', 'false'); });
      state.method = null;
      var po = $('pairingOptions'); if (po) po.hidden = true;
      var qo = $('qrOptions'); if (qo) qo.hidden = true;
    }
    renderPipeline(); renderTutorial(); updateRequestBtn(); saveState();
  }

  /* ---------------- WebSocket ---------------- */
  function connectWs() {
    try {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/');
      ws.addEventListener('open', function () { wsRetryMs = 3000; });
      ws.addEventListener('message', function (ev) {
        var d = null;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (!d) return;
        if (d.type === 'hello') {
          if (d.botVersion) { $$('[id="botVersion"]').forEach(function (bv) { bv.textContent = d.botVersion; }); }
          return;
        }
        if (d.type === 'status') {
          // Hanya terapkan status untuk nomor yang sedang aktif (atau bila nomor belum diisi).
          if (d.phone && state.phone && d.phone !== state.phone) return;
          applyStatus(d);
        }
      });
      ws.addEventListener('close', function () {
        setTimeout(connectWs, wsRetryMs);
        wsRetryMs = Math.min(wsRetryMs * 2, 10000);
      });
      ws.addEventListener('error', function () { try { ws.close(); } catch (e) { /* abaikan */ } });
    } catch (e) { setTimeout(connectWs, 5000); }
  }

  /* ---------------- Init ---------------- */
  function initActions() {
    var cb = $('cancelBtn'); if (cb) cb.addEventListener('click', cancelPairing);
    var cc = $('cancelCodeBtn'); if (cc) cc.addEventListener('click', cancelPairing);
    var sp = $('codeSpoilerBtn'); if (sp) sp.addEventListener('click', toggleCodeSpoiler);
    var cq = $('cancelQrBtn'); if (cq) cq.addEventListener('click', cancelPairing);
    var vs = $('viewSessionBtn');
    if (vs) vs.addEventListener('click', function () {
      hideOverlay();
      var rb = $('resultBlock');
      if (rb) rb.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    var co = $('closeOverlayBtn'); if (co) co.addEventListener('click', hideOverlay);
    var so = $('sendOwnerBtn'); if (so) so.addEventListener('click', sendToOwner);
    var lo = $('logoutBtn'); if (lo) lo.addEventListener('click', logoutSession);
    var rs = $('resetBtn'); if (rs) rs.addEventListener('click', function () { resetAll(true); });
    var cp = $('copyCodeBtn');
    if (cp) cp.addEventListener('click', function () {
      var raw = String(state.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
      if (!raw) return;
      var done = function () {
        cp.textContent = 'Disalin ✓';
        setTimeout(function () { cp.textContent = 'Salin Tanpa Strip'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(raw).then(done).catch(function () { fallbackCopy(raw); done(); });
      } else { fallbackCopy(raw); done(); }
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* abaikan */ }
  }

  function restoreSaved() {
    var s = loadState();
    if (!s) return;
    state.method = s.method || null;
    state.codeMode = s.codeMode || 'random';
    state.customCode = s.customCode || '';
    var input = $('phoneInput');
    if (input && s.phone) {
      input.value = s.phone;
      updatePhoneClearBtn();
      validatePhone();
    }
    if (state.method) selectMethod(state.method);
    var radios = $$('input[name="codeMode"]');
    radios.forEach(function (r) { r.checked = r.value === state.codeMode; });
    var wrap = $('customCodeWrap');
    if (wrap) wrap.hidden = state.codeMode !== 'custom';
    var ci = $('customCodeInput');
    if (ci && state.customCode) { ci.value = state.customCode; refreshCustomPreview(); }
    // Pulihkan kode/QR yang masih berlaku (wall-clock).
    if (s.expiresAt && s.expiresAt > Date.now() && (s.code || s.qrDataUrl)) {
      state.code = s.code || '';
      state.qrDataUrl = s.qrDataUrl || '';
      state.expiresAt = s.expiresAt;
      state.totalSeconds = s.totalSeconds || 180;
      state.status = s.status === 'awaiting_qr' ? 'awaiting_qr' : 'awaiting_code';
      state.botNumber = s.botNumber || '';
      if (state.status === 'awaiting_qr') showQrArea(); else showCodeArea();
      logLine('Sesi dipulihkan — kode masih berlaku.');
    } else if (s.status === 'connected' || s.status === 'delivering' || s.status === 'delivered_disconnected') {
      state.status = s.status;
      state.botNumber = s.botNumber || '';
      state.delivery = s.delivery || null;
      state.session = s.session || null;
      state.sessionFile = s.sessionFile || '';
      state.deliveryError = s.deliveryError || '';
      var rb = $('resultBlock'); if (rb) rb.hidden = false;
      if (s.status === 'delivered_disconnected') {
        showFinalNote(state.sessionFile
          ? 'Sesi terkirim ke owner, sesi web terputus otomatis — file hisoka.json tetap tersimpan di ' + state.sessionFile + '.'
          : 'Sesi terkirim ke owner, sesi web terputus otomatis.', false);
      }
      renderPipeline(); renderDelivery();
    }
    updateRequestBtn();
  }

  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initViewToggle();
    tickClock();
    setInterval(tickClock, 1000);
    initPresence();
    initHealth();
    initPhoneInput();
    initMethodUI();
    initActions();
    loadOperators();
    restoreSaved();
    renderPipeline();
    startCountdown();
    connectWs();
  });
})();
