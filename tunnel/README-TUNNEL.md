# Tunnel SessionBot — sessionbot.my.id ke Cloudflare

Tujuan: web SessionBot (server Node.js di VM ini) bisa dibuka publik lewat
`https://sessionbot.my.id`, **tanpa bentrok sama sekali** dengan
`readsw.my.id` / panel ReadSW.

## Yang dipisah (jaminan tidak bentrok)

| Bagian | SessionBot | ReadSW (panel) |
| --- | --- | --- |
| Port server | `3001` | `3000` |
| Rute tunnel OpenTunnel | `sessionbot` | `readsw` |
| Worker Cloudflare | `sessionbot-tunnel` (BARU) | `readsw-tunnel` (jangan diedit) |
| Route / domain | `sessionbot.my.id/*` | `readsw.my.id/*` |
| UPSTREAM Worker | URL OpenTunnel `sessionbot.*` | URL tunnel `readsw.*` |
| Nameserver Cloudflare | `ada` + `cash` (khusus zone ini) | `cris` + `marjory` (khusus zone itu) |

**PENTING — nameserver TIDAK bisa disamakan:** tiap zone Cloudflare
dapat pasangan nameserver sendiri-sendiri. Zone `sessionbot.my.id`
dapat `ada.ns.cloudflare.com` + `cash.ns.cloudflare.com`, sedangkan
zone `readsw.my.id` memakai `cris` + `marjory`. Jangan pakai pasangan
zone lain — zone tidak akan aktif. (Ketahuan 26 Nov 2026 15:42 WIB:
awal sempat dipasang cris/marjory, lalu diperbaiki ke ada/cash.)

## Alur

```
sessionbot.my.id
  → Nameserver Cloudflare (cris + marjory)
  → Worker sessionbot-tunnel (route sessionbot.my.id/*)
  → OpenTunnel https://sessionbot.<id>.opentunnel.xyz
  → 127.0.0.1:3001 → server SessionBot (PORT=3001)
```

## Status domain (dicek 26 Nov 2026, 15:19 WIB)

- Domain: `sessionbot.my.id` — **ACTIVE**, berakhir **26 Nov 2027** (1 tahun).
  Perpanjangan ditutup sementara, jadi aman sampai tanggal berakhir.
- Nameserver aktif saat ini: **Indo Domains** (`ns1`/`ns2.indo.domains`) —
  BELUM Cloudflare. Preset Cloudflare `cris/marjory` tersedia (dipakai
  readsw.my.id) dan `lakas/zita`.
- DNS records: **belum ada**. Tidak ada forwarding.
- WHOIS privacy: AKTIF. Auto-renew: tidak tersedia sementara. Saldo: Rp 6.000.

## Bagian A — server + tunnel (dikerjakan di VM ini)

```bash
# 1. Jalankan server SessionBot di PORT 3001 (3000 sudah dipakai panel ReadSW)
PORT=3001 npm start

# 2. Jalankan tunnel OpenTunnel (rute `sessionbot`, URL tercatat di
#    tunnel/opentunnel-url.txt). Pembuatan pertama butuh ~3-5 menit
#    (sertifikat ACME) — jangan dibunuh di bawah 2 menit.
bash tunnel/start-opentunnel.sh

# 3. Cek URL publiknya
cat tunnel/opentunnel-url.txt
curl -s -o /dev/null -w "%{http_code}\n" "$(cat tunnel/opentunnel-url.txt)/api/health"
# Harus 200. Buka URL itu di browser — harus tampil halaman SessionBot.
```

Fallback kalau OpenTunnel gagal total (otomatis dicoba skrip di atas):

```bash
bash tunnel/start-tunnel.sh stable   # tunnl.gg, tahan maks 24 jam, URL berubah tiap restart
```

## Bagian B — Cloudflare (dikerjakan Wily, langkah jelas)

> Jangan edit Worker `readsw-tunnel` dan jangan ubah route `readsw.my.id`.
> Semua di bawah ini BARU dan terpisah.

**Langkah 1 — Pindah nameserver (di Indo Domains, sekali saja):**

1. Buka https://app.indo.domains/domains/manage/?name=sessionbot.my.id
2. Bagian Nameserver → KETIK MANUAL (jangan pilih preset):
   `ada.ns.cloudflare.com` + `cash.ns.cloudflare.com`
   (pasangan yang DITETAPKAN Cloudflare untuk zone ini — tiap zone
   dapat pasangan sendiri; cris/marjory itu punya zone readsw.my.id).
3. Simpan. Propagasi DNS butuh waktu (biasanya menit–jam, maks ~24 jam).
   Selama propagasi, domain belum mengarah ke Cloudflare — tunnel URL
   dari Bagian A tetap bisa dibuka langsung.

**Langkah 2 — Buat Worker BARU (di Cloudflare dashboard):**

1. Buka Cloudflare → Workers & Pages → **Create** → buat Worker baru
   bernama `sessionbot-tunnel` (jangan pakai nama `readsw-tunnel`).
2. Hapus isi editor, tempel seluruh isi file `tunnel/proxy-worker.js`.
3. **WAJIB:** ganti `UPSTREAM` di baris atas file dengan URL publik
   OpenTunnel dari `tunnel/opentunnel-url.txt`, contoh:
   `const UPSTREAM = "https://sessionbot.5wv6nxnv2c6g.opentunnel.xyz";`
   (tanpa trailing slash; JANGAN pakai URL tunnel readsw).
4. **Deploy.**

**Langkah 3 — Tambah Route (di Worker yang sama):**

1. Di halaman Worker `sessionbot-tunnel` → Settings → Triggers → Add Route.
2. Route: `sessionbot.my.id/*` → Worker: `sessionbot-tunnel`.
3. Simpan. Jangan tambah route ini ke Worker lain.

**Langkah 4 — Cek:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://sessionbot.my.id
# Harus 200 + tampil halaman SessionBot.
# Kalau masih 503 "SessionBot sedang dipulihkan" -> tunnel/server belum
# jalan, atau DNS belum propagasi — tunggu lalu cek lagi.
```

## File-file di folder ini

| File | Isi |
| --- | --- |
| `start-opentunnel.sh` | Jalankan tunnel OpenTunnel rute `sessionbot` → 127.0.0.1:3001. Guard cooldown 3 menit, fallback tunnl.gg. |
| `install-opentunnel.sh` | Pasang CLI OpenTunnel ke `~/.local/bin` kalau belum ada (v0.7.0 teruji). |
| `start-tunnel.sh` | Fallback tunnl.gg (SSH lewat proxy VM), mode `random`/`stable`. |
| `proxy_ssh.py` | Helper ProxyCommand SSH untuk tunnl.gg (CONNECT lewat proxy VM). |
| `proxy-worker.js` | Kode Worker Cloudflare `sessionbot-tunnel` (isi UPSTREAM dulu). |
| `opentunnel-url.txt` | URL publik OpenTunnel (ditulis otomatis skrip; dibuat saat tes). |
| `README-TUNNEL.md` | File ini. |

## Catatan penting (pelajaran dari readsw.my.id)

- **Cooldown 3 menit:** jangan start tunnel bertubi-tubi — restart tiap
  menit memicu rate limit tunnl.gg dan situs mati lebih lama.
- **tunnl.gg maks 24 jam**, lalu harus restart (URL berubah). OpenTunnel
  lebih stabil (rute `sessionbot` tetap).
- **VM diganti → panel + tunnel ikut mati.** Jalankan ulang Bagian A
  (server + tunnel) setelah VM baru; Worker + domain tidak berubah.
- **Port 3001, bukan 3000.** Port 3000 sudah dipakai panel ReadSW di VM
  yang sama — SessionBot di 3000 akan gagal `EADDRINUSE`.
- **Socket WhatsApp butuh agen proxy** (sudah ada di `src/proxyAgent.js`,
  dari panel). Tanpa itu pairing code asli tidak terbit (mati 408).
- **Session tetap per nomor** (`sessions/<nomor>/session.json`) dan hanya
  dikirim ke nomor owner lewat WhatsApp — tidak lewat Worker/tunnel.
