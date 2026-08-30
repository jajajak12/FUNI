# ⚠️ PERINGATAN: penggunaan FUNI melibatkan risiko finansial. Segala kerugian uang/aset yang timbul dari penggunaan software ini sepenuhnya menjadi tanggung jawab pengguna.

<p align="center">
  <img src="apps/telegram-lp-bot/assets/funi-approved-logo.png" alt="Logo FUNI" width="150" height="150">
</p>

# FUNI

FUNI adalah alat manual untuk menemukan, membuka, memantau, mengelola, dan menutup posisi liquidity provider (LP) V3/V4 yang didukung. Pengguna selalu memilih pool, meninjau preview, menetapkan batas risiko, dan memberi otorisasi eksplisit sebelum tindakan ekonomi.

FUNI bersifat **source-available under PolyForm Noncommercial 1.0.0**. FUNI bukan layanan kustodian, bukan penasihat keuangan, dan tidak menjamin profit.

X: [@jajajakbtc](https://x.com/jajajakbtc)<br>
Telegram: [t.me/Jajajakbothouse](https://t.me/Jajajakbothouse)

## Risiko yang wajib dipahami

LP dan transaksi on-chain dapat menyebabkan hilangnya sebagian atau seluruh aset. Risiko meliputi:

- bug atau perubahan perilaku smart contract;
- impermanent loss, adverse selection, dan kerugian AMM/LP;
- token volatil, token berbahaya, likuiditas tipis, atau harga yang tidak dapat dipercaya;
- RPC/provider gagal, terlambat, berbeda pendapat, atau mengembalikan data usang;
- gas, biaya transaksi, transaksi revert, dan nonce yang belum terkonfirmasi;
- approval token yang terlalu besar atau diberikan kepada kontrak yang salah;
- salah konfigurasi wallet, chain, pool, rentang, jumlah, atau slippage;
- bug software dan kegagalan layanan pihak ketiga.

Verifikasi sendiri alamat kontrak, PoolKey, allowance, preview, transaksi, dan kondisi pasar. Jangan gunakan dana yang tidak sanggup Anda tanggung bila hilang.

## Ruang lingkup publik

FUNI publik menyediakan alur yang dipicu dan disetujui pengguna untuk:

- menemukan pool V3/V4 yang didukung dari token atau contract address;
- menampilkan semua kandidat yang memenuhi klasifikasi dukungan;
- memprioritaskan V4, mendukung static fee sampai 5,000%, dan menjelaskan pool dinamis/nonzero-hook yang tidak didukung;
- melakukan bounded direct lookup serta revalidasi inisialisasi dan canonical PoolKey;
- membuka dan mengelola posisi LP manual yang didukung;
- membuat V4 BID Ladder lima leg sebagai strategi limit-order-like manual;
- Claim, Close, dan Reposition V4 BID Ladder setelah preview dan konfirmasi eksplisit;
- menampilkan posisi segera setelah receipt dan memperbarui portfolio dari kebenaran kanonis;
- merekonsiliasi jurnal transaksi, receipt, dan SQLite secara idempoten;
- menghitung PnL posisi serta Daily/Weekly/Monthly berdasarkan ledger kanonis;
- membuat kartu share privacy-first.

Reposition hanya berlaku pada alur V4 BID Ladder yang memang ditampilkan dan diotorisasi. Hasil Close tidak ditukar secara otomatis; aset hasil penutupan tetap berada di wallet pengguna.

## Kontrak otorisasi manual

Konfigurasi bawaan fail-closed:

```dotenv
EXECUTION_ENABLED=false
DRY_RUN=true
EMERGENCY_PAUSE=true
LIVE_CANARY_ENABLED=false
V4_LIVE_CANARY_ENABLED=false
```

Instalasi, discovery, pembacaan portfolio, dan preview tidak mengizinkan transaksi. Alur live memerlukan konfigurasi sadar pengguna, bukti preflight yang masih segar, wallet yang cocok, dan konfirmasi final. Bukti yang ambigu tetap berstatus menunggu rekonsiliasi; FUNI tidak menganggap ketidakpastian provider sebagai alasan aman untuk mengirim ulang transaksi.

## Batas Gas Transaksi

Nilai bawaan `MAX_GAS_COST_USD=0.70` adalah hard safety cap untuk **maximum projected fee**, bukan perkiraan biaya aktual. FUNI membedakan raw `estimateGas`, final gas limit yang sudah diberi margin satu kali, gas price yang dibuffer, **estimated execution fee** yang kemungkinan terpakai, **maximum projected fee** bila seluruh final gas limit terpakai, dan **actual receipt fee** setelah transaksi masuk chain. Kondisi jaringan menentukan biaya aktual; menaikkan atau menurunkan cap tidak mengubah harga gas jaringan.

Preview atau output blokir menampilkan estimated execution fee, maximum projected fee, safety cap, final gas limit, dan gas price dalam gwei. Pengguna boleh memilih nilai lain yang tetap bounded; validasi schema mempertahankan maksimum `$1.00`. `MAX_LIFECYCLE_GAS_USD` tidak berubah, dan cap tidak pernah menjadi unlimited.

## Respons Telegram

Lookup token dan pembuatan LIVE preview menampilkan progress terlebih dahulu, lalu mengedit pesan yang sama dengan hasil akhir. Pool dari cache dapat muncul cepat; bukti yang belum selesai ditandai sedang diperbarui. Otoritas ekonomi akhir tetap memakai bukti pool, saldo, allowance, harga, dan gas yang fresh.

Menekan Refresh, mengirim token baru, atau mengoreksi jumlah menggantikan pekerjaan sebelumnya. Hasil worker lama tidak boleh menimpa sesi yang lebih baru, dan pesan progress tidak pernah memberi otoritas eksekusi.

## Pemulihan Transaksi

Setelah upaya broadcast yang otoritatif, FUNI segera memeriksa expected hash yang sama dan merekonsiliasi receipt kanonis. Jangan menekan Confirm berulang kali saat status masih direkonsiliasi: kebenaran exact-hash/receipt mengalahkan status presentasi lokal, dan ketidakjelasan penyimpanan lokal bukan izin untuk rebroadcast atau transaksi pengganti semantik.

## Reposition

Reposition memakai paling banyak tiga rematerialisasi JIT per generasi child untuk drift yang memang dapat dirematerialisasi. Jika source sudah terbukti tertutup tetapi child belum pernah terbuka, pengguna dapat memilih Resume Reposition secara eksplisit; FUNI memvalidasi ulang source CLOSE, principal, wallet, journal, dan nonce lalu membuat generation berikutnya dari state kanonis yang fresh. Child yang dibatalkan tidak dihidupkan kembali. Alur ini tidak melakukan swap otomatis atau burn NFT.

## PnL Tidak Lengkap

Valuasi pool yang melewati batas protokol, tidak memiliki active liquidity, tidak konsisten antara tick dan `sqrtPrice`, atau tidak dapat dipercaya ditampilkan sebagai `Unavailable`/`INCOMPLETE`. Daily, Weekly, dan Monthly meneruskan status `PARTIAL`/`INCOMPLETE` secara jujur; FUNI tidak mengarang harga untuk memaksa coverage menjadi `FULL`. Bukti accounting mentah tetap disimpan untuk rekonsiliasi.

## Intervensi Manual Darurat

Dalam kondisi normal, hindari mengirim transaksi wallet lain ketika FUNI masih merekonsiliasi transaksi `PREPARED` atau `SUBMITTED`. FUNI dapat memblokir tindakan baru sementara ketika kebenaran transaksi belum final.

Jika risiko pasar sangat berat dan menunggu dapat menambah kerugian secara material, pengguna dapat mengurangi atau menutup exposure secara manual melalui wallet atau antarmuka Uniswap yang tepercaya. Tindakan manual tidak bebas risiko dan dapat memakai nonce yang sebelumnya telah disiapkan FUNI.

Setelahnya, FUNI merekonsiliasi status posisi dari kebenaran on-chain kanonis. Tindakan tersebut tetap diberi provenance `EXTERNAL_ONCHAIN_MUTATION`, bukan diklaim sebagai transaksi FUNI. Accounting ditandai `FULL`, `PARTIAL`, atau `INCOMPLETE` sesuai bukti receipt/log yang tersedia; posisi yang terbukti tertutup tidak dibuka kembali hanya karena accounting belum lengkap. Bila memungkinkan, tunggu rekonsiliasi selesai sebelum melanjutkan operasi normal FUNI.

## Persyaratan

- Linux, macOS, atau WSL2;
- Git;
- Node.js `>=20.18` dan npm `>=10`;
- endpoint RPC untuk chain yang digunakan;
- SQLite melalui dependency `better-sqlite3`;
- bot token Telegram hanya bila antarmuka Telegram digunakan.

Pada Linux, `build-essential`, Python 3, dan `pkg-config` mungkin diperlukan bila binary `better-sqlite3` harus dikompilasi lokal.

## Instalasi

```bash
git clone https://github.com/jajajak12/FUNI.git
cd FUNI
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env` menggunakan endpoint, wallet publik, ID Telegram, dan kredensial milik Anda sendiri. Jangan menyalin `.env` dari instalasi lain. Jangan pernah commit private key, mnemonic, token bot, API key, URL RPC bercredential, database, atau log.

Konfigurasi minimum read-only:

```dotenv
RH_CHAIN_ID=4663
RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com
ALCHEMY_RPC_URL=

DATA_DIR=./data
DATABASE_PATH=./data/funi.sqlite

WALLET_ADDRESS=

EXECUTION_ENABLED=false
DRY_RUN=true
EMERGENCY_PAUSE=true
```

Untuk Telegram, isi juga:

```dotenv
FUNI_TELEGRAM_BOT_TOKEN=
FUNI_TELEGRAM_CHAT_ID=
TELEGRAM_ALLOWED_USER_IDS=
```

`.env.example` mendokumentasikan opsi discovery, freshness, risk cap, dan read-only multichain. BSC/Ethereum tetap non-eksekusi secara default.

## Database dan migrasi

Buat database baru dan terapkan migrasi publik berurutan:

```bash
npm run db-migrate
npm run db-status
```

Runtime hanya memakai migrasi yang terdapat di `infra/migrations/`. Runner mencatat checksum, menolak konflik, dan aman dijalankan kembali terhadap database yang sudah selesai dimigrasikan.

Jangan arahkan instalasi publik ke database produksi milik pihak lain.

## Validasi instalasi

```bash
npm run typecheck
npm test
npm run bot-preflight
npm run runtime-status
```

Preflight dan perintah status bersifat read-only serta melaporkan `mainnetTransactionsSent: 0`. Hentikan konfigurasi bila chain salah, migrasi gagal, wallet alias berbeda, deployment tidak terverifikasi, atau limit risiko tidak valid.

Perintah CLI yang tersedia:

```bash
npm run cli -- help
npm run db-status
npm run wallet-status
npm run allowance-audit
npm run reconcile-all
npm run cli -- v4-pool-registry-status
npm run cli -- v4-pools-for-token 0x...
npm run cli -- v4-position-inspect <token-id>
npm run cli -- v4-pnl-audit <token-id>
```

CLI publik tidak menyediakan perintah signing atau broadcast umum.

## Menjalankan Telegram dan worker

Foreground:

```bash
./node_modules/.bin/tsx apps/telegram-lp-bot/src/index.ts
```

PM2 opsional:

```bash
npx pm2 start infra/pm2/ecosystem.config.cjs
npx pm2 status
```

Definisi worker publik menjaga registry, direct lookup, state cache, urgent freshness, rekonsiliasi, dan delivery kartu. Worker read-only tidak menerima signer material.

## Alur penggunaan

1. Kirim contract address token atau buka command discovery.
2. Tinjau kandidat V3/V4 dan alasan dukungan/ketidakdukungan.
3. Pilih pool dan strategi manual.
4. Masukkan jumlah/rentang atau parameter V4 BID Ladder.
5. Tinjau PoolKey, harga, allowance, gas, slippage, dan preview final.
6. Konfirmasi tindakan secara eksplisit.
7. Pantau receipt, posisi, fee, dan PnL.
8. Gunakan Claim, Close, atau Reposition hanya setelah preview baru.

Callback Telegram terikat pada user, chat, wallet, workflow, revision, dan waktu kedaluwarsa. Callback lama atau replay ditolak.

## PnL dan accounting

Ledger memisahkan:

- capital basis;
- principal aktif;
- returned/realized principal;
- fee belum diklaim;
- claimed fee sepanjang lifecycle;
- total lifecycle LP fees;
- biaya gas yang memiliki valuasi;
- gross/net PnL serta coverage data.

Nilai yang bukti historisnya tidak cukup ditampilkan sebagai `Unavailable`, bukan diperkirakan diam-diam. Claim dan Close di-account berdasarkan event/receipt kanonis, sehingga principal tidak dihitung ganda sebagai fee.

## Kartu share privacy-first

Kartu publik Position Closed tersedia dalam mode:

- **Privacy** — menyembunyikan basis, returned value, dan PnL %;
- **Amounts** — menampilkan basis dan returned value tanpa PnL %;
- **Full Detail** — menampilkan basis, returned value, dan PnL %.

Semua mode publik tetap menyembunyikan transaction hash, event/workflow ID, ladder ID, wallet, NFT/token ID, pool ID, block, nonce, serta jam-menit penutupan. Kartu hanya menampilkan tanggal penutupan tingkat-hari. Identitas transaksi tetap disimpan internal untuk accounting, recovery, journal, dan audit lokal.

Branding kartu publik: `@jajajakbtc · t.me/Jajajakbothouse`.

## Troubleshooting

### `ALCHEMY_RPC_URL_REQUIRED`

Isi `ALCHEMY_RPC_URL` atau `ALCHEMY_RPC_URLS` dengan endpoint Anda. Pastikan endpoint berada pada chain yang benar.

### Wallet mismatch

Jika beberapa dari `WALLET_ADDRESS`, `OPERATOR_WALLET`, dan `DEDICATED_WALLET_ADDRESS` diisi, semuanya harus menunjuk address yang sama.

### Telegram tidak merespons

Periksa token bot, `FUNI_TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS`, database, serta log lokal. Jangan mempublikasikan token atau ID asli saat meminta bantuan.

### `RECONCILIATION_PENDING`

Jangan mengulang transaksi secara manual. Provider belum memberikan bukti final yang konsisten; jalankan siklus rekonsiliasi dan tunggu exact-hash evidence.

### PnL `Unavailable`

Data basis, harga historis, receipt, atau metadata belum lengkap. Jalankan rekonsiliasi dan periksa coverage; jangan mengganti nilai kanonis dengan perkiraan.

### SQLite busy/locked

Pastikan semua proses memakai satu `DATABASE_PATH`, gunakan worker resmi, dan jangan menjalankan writer ad-hoc paralel.

## Keamanan dan pelaporan

Baca [SECURITY.md](SECURITY.md). Gunakan identitas sintetis dalam issue atau reproduksi publik. Jangan unggah `.env`, database, WAL/SHM, log, PM2 dump, transaction hash pribadi, wallet, chat ID, atau bukti produksi.

## Lisensi

FUNI adalah **source-available under PolyForm Noncommercial 1.0.0**. Teks resmi terdapat di [LICENSE](LICENSE). Penggunaan komersial memerlukan izin tertulis terpisah dari pemegang hak cipta.
