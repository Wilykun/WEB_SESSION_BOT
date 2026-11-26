// proxy-worker.js — Cloudflare Worker untuk sessionbot.my.id.
//
// Cara kerja (pola yang sama seperti Worker readsw-tunnel untuk
// readsw.my.id): domain sessionbot.my.id di-route ke Worker ini, Worker
// meneruskan semua request ke tunnel (UPSTREAM) dan mengembalikan
// responsnya. Kalau tunnel/server mati, pengunjung melihat halaman
// "SessionBot sedang dipulihkan" (503, auto-refresh 10 detik) — bukan
// "Not Found" polos.
//
// LANGKAH PASANG (sekali saja):
//   1. Jalankan server + tunnel dulu:  PORT=3001 npm start
//      lalu  bash tunnel/start-opentunnel.sh
//      URL publik tercatat di tunnel/opentunnel-url.txt.
//   2. Ganti UPSTREAM di bawah dengan URL itu (tanpa trailing slash).
//   3. Buat Worker baru di Cloudflare (dashboard Workers & Pages, nama
//      bebas mis. sessionbot-tunnel), tempel file ini, Deploy.
//   4. Di Cloudflare, tambah Route:  sessionbot.my.id/*  -> Worker ini.
//      (Domain harus sudah memakai nameserver Cloudflare yang DITETAPKAN
//      untuk zone ini — ada.ns.cloudflare.com + cash.ns.cloudflare.com,
//      BUKAN cris/marjory (itu punya zone readsw.my.id); ubah di
//      Indo Domains > manage domain > Nameserver, ketik manual.)
//   5. Cek https://sessionbot.my.id — harus tampil halaman SessionBot.
//
// Catatan: Worker ini TIDAK menyimpan data apa pun; session.json tetap
// di server (sessions/<nomor>/session.json) dan hanya dikirim ke nomor
// owner lewat WhatsApp, bukan lewat Worker.

// GANTI dengan URL publik OpenTunnel dari tunnel/opentunnel-url.txt,
// contoh: "https://sessionbot.5wv6nxnv2c6g.opentunnel.xyz"
// (Kembali ke OpenTunnel 26 Nov 2026 atas permintaan Wily; tunnl.gg jadi cadangan.)
const UPSTREAM = "https://sessionbot.5wv6nxnv2c6g.opentunnel.xyz";

const MAINTENANCE_HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>SessionBot — Sedang Dipulihkan</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f14;color:#e6edf3;font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:24px}.wrap{max-width:420px}h1{font-size:22px;margin:0 0 8px}p{color:#8b98a5;margin:0 0 20px;line-height:1.6}.actions{display:flex;gap:10px}.actions button,.actions a{flex:1 1 0;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:7px;border:0;border-radius:8px;padding:11px 10px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;color:#fff}.actions button{background:#1f6feb}.actions a{background:#25d366}.actions a svg{width:18px;height:18px;flex:0 0 auto;fill:none;stroke:#fff;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f0a832;margin-right:6px;animation:blink 1s infinite}@keyframes blink{50%{opacity:.25}}</style></head><body><div class="wrap"><h1><span class="dot"></span>SessionBot sedang dipulihkan</h1><p>Server sempat tidak terjangkau dan sedang dihidupkan lagi otomatis.<br>Halaman ini akan refresh sendiri — tidak perlu menutup tab ini.</p><div class="actions"><button onclick="location.reload()">Muat Ulang Sekarang</button><a href="https://wa.me/6289688206739" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 3.5A10.7 10.7 0 0 0 3.4 16.4L2 21.8l5.5-1.4A10.7 10.7 0 1 0 20.5 3.5Z"/><path d="M8.6 7.3c.2-.4.4-.4.7-.4h.5c.2 0 .4.1.5.4l.8 1.8c.1.2.1.4 0 .6l-.5.7c-.1.2-.2.3 0 .6.5.8 1.2 1.5 2 2 .3.2.4.2.6 0l.8-.8c.2-.2.4-.2.6-.1l1.8.9c.2.1.3.3.2.6-.1.7-.5 1.2-1.1 1.5-.6.3-1.3.2-2.1 0-1.4-.5-2.7-1.3-3.8-2.4-1.1-1.1-1.9-2.4-2.4-3.8-.2-.8-.3-1.5 0-2.1.3-.6.8-1 1.4-1.2Z"/></svg>Chat Owner</a></div></div></body></html>`;

function maintenanceResponse() {
  return new Response(MAINTENANCE_HTML, {
    status: 503,
    statusText: "Service Unavailable",
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__tunnel/health") {
      return new Response(JSON.stringify({ ok: true, service: "sessionbot-proxy", upstream: UPSTREAM }), { headers: { "content-type": "application/json" } });
    }
    const upstreamUrl = UPSTREAM + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    // User-Agent asli DITERUSKAN (jangan ditimpa): server mendeteksi
    // mobile vs desktop dari UA. OpenTunnel tidak punya interstitial,
    // jadi tidak butuh UA palsu seperti tunnl.gg.
    // Teruskan host domain asli supaya server tahu pengunjung datang
    // dari sessionbot.my.id.
    headers.set("X-Forwarded-Host", url.host);
    headers.set("X-Original-Host", url.host);
    headers.set("X-Forwarded-Proto", "https");
    headers.delete("sec-fetch-site");
    headers.delete("sec-fetch-mode");
    let resp;
    try {
      resp = await fetch(upstreamUrl, { method: request.method, headers, body: request.body, redirect: "manual" });
    } catch {
      return maintenanceResponse();
    }
    // Tunnel/server mati (404/502/503/504) -> halaman pemulihan, bukan
    // halaman error polos.
    if ([404, 502, 503, 504].includes(resp.status)) return maintenanceResponse();
    // WebSocket upgrade (101) harus diteruskan apa adanya — status 101
    // di luar 200-599, jadi new Response(..., { status: 101 }) melempar
    // RangeError dan socket realtime mati (halaman tetap tampil karena
    // fallback polling, tapi QR/status tidak realtime).
    if (resp.status === 101) return resp;
    const out = new Headers(resp.headers);
    // Cache (biar navigasi cepat seperti panel — panel SPA, pindah halaman
    // tanpa jaringan sama sekali; SessionBot MPA, jadi aset harus boleh
    // disimpan browser): aset berversi (?v=) 1 tahun immutable — versinya
    // berubah tiap ada edit, jadi tidak mungkin kedaluwarsa; aset statis
    // lain (maskot, ikon, operator) 1 hari; HTML + API + Info Update
    // tetap no-store supaya selalu segar.
    const isStatic = /\.(css|js|webp|png|ico|svg|json)$/i.test(url.pathname);
    if (isStatic && url.searchParams.has("v")) {
      out.set("cache-control", "public, max-age=31536000, immutable");
    } else if (isStatic && !url.pathname.startsWith("/INFO_UPDATE/")) {
      out.set("cache-control", "public, max-age=86400");
    } else {
      out.set("cache-control", "no-store");
    }
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
  },
};
