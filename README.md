# FUNI — Operator LP Robinhood

Monorepo TypeScript yang mengutamakan keamanan untuk operator tunggal LP
Uniswap v3 dan v4 di Robinhood Chain (chain ID `4663`), beserta tumpukan
infrastruktur Robinhood baca-saja yang dapat digunakan kembali, bot operator
Telegram, worker registry/cache-state, dan kanal peringatan opsional.

> **Status**
>
> Eksekusi live dinonaktifkan secara bawaan. Nilai di `.env.example` yang
> disertakan membuat seluruh jalur transaksi tetap mati sampai manusia
> mengaktifkannya secara eksplisit setelah preflight lengkap, verifikasi
> deployment, dan tinjauan hash kode independen. Repositori ini diterbitkan
> untuk tinjauan sumber; tidak menyertakan state operasional, database, secret,
> maupun identifier runtime.

## Apa itu FUNI

FUNI adalah nama publik repositori operator LP Robinhood. Namespace paket,
nama perintah CLI, tabel database, migrasi, dan identifier runtime tetap
menggunakan desain Robin kanonis. Kata FUNI hanya muncul pada README yang
ditujukan untuk publik dan nama repositori.

## Fungsionalitas yang didukung

### Chain

- Robinhood Chain mainnet, chain ID `4663`, gas ETH.
- RPC publik dan pool endpoint Alchemy didukung. Pool Alchemy dapat diganti
  panas per proses melalui daftar koma standar `ALCHEMY_RPC_URLS`.

### Protokol

- **Uniswap v3** — penemuan pool, inspeksi posisi, audit allowance, estimasi
  biaya baca-saja, dan simulator persetujuan mint berbasis fork end-to-end.
- **Uniswap v4** — bootstrap serta refresh registry pool, pratinjau mint
  downside satu sisi, tampilan posisi persisten, intent open operasional,
  swap target/funding, penutupan penuh, burn, rekonsiliasi exact-hash, dan
  siklus hidup rebalance (pratinjau → otorisasi → eksekusi → selesai).

### Registry pool

- Bootstrap dan refresh periodik untuk kumpulan pool terbatas (ukuran jendela
  dan batas per siklus dapat dikonfigurasi) dengan kunci `poolId`.
- Status validasi per pool (`ELIGIBLE` / `BLOCKED`) beserta alasan pemblokiran
  untuk UI downstream.

### Portofolio dan visibilitas posisi eksternal

- Posisi `BOT_OPERATIONAL` dibuka dan dikelola oleh operator ini.
- Posisi `MANUAL_EXTERNAL` dimiliki wallet yang dikonfigurasi, tetapi diadopsi
  dari riwayat transfer on-chain; terlihat, tetapi tidak dihitung dalam
  eksposur yang dikelola bot.
- Posisi `TRACKED` disimpan untuk pemantauan tanpa modal yang dikomitkan.
- State live per posisi, fee yang dapat diklaim, dan PnL historis melalui
  snapshot portofolio dua menit yang dibatasi, diperbarui oleh worker cache
  state.

### Siklus hidup open, collect, close, burn, dan rebalance langsung

- `v4-open-preflight` — pratinjau baca-saja mint downside satu sisi v4.
- `v4-position-import` — adopsi NFT v4 on-chain ke tabel posisi lokal dan
  antrean rekonsiliasi.
- `v4-position-collect-preflight`, `v4-position-partial-close-preflight`,
  `v4-position-full-close-preflight` — pratinjau baca-saja untuk collect,
  close parsial, dan close penuh.
- `v4-pnl-audit` — PnL posisi tertutup dari akuntansi kanonis
  principal-first.
- Pratinjau, otorisasi, dan alur `rebalance-resume` dengan jurnal persisten
  berbasis SQLite, alokasi funding terproyeksi, serta pemulihan berbasis state
  untuk workflow `FAILED_RECOVERABLE`.
- Rekonsiliasi exact-hash: `rebalance-exact-hash-reconcile` merekonsiliasi
  broadcast on-chain yang sudah terkonfirmasi tetapi jurnal engine masih
  menunjukkan `PREPARED` (misalnya karena galat RPC sementara saat submit),
  dan merupakan perbaikan persisten kanonis.

### BOT_OPERATIONAL dibanding MANUAL_EXTERNAL

- Posisi `BOT_OPERATIONAL` dibuka bot dan berkontribusi pada agregat
  `BOT_MANAGED_EXPOSURE`.
- Posisi `MANUAL_EXTERNAL` dimiliki wallet terkonfigurasi namun tidak dibuka
  bot. Posisi ini terlihat di portofolio, diberi lencana “External” di UX
  Telegram, dikecualikan dari batas eksposur yang dikelola bot dan kandidat
  rebalance, serta tidak pernah menerima mint `BOT_OPERATIONAL` di backend.
- Posisi `TRACKED` hanya untuk pemantauan tanpa modal yang dikomitkan dan tidak
  pernah memasuki jalur rebalance.

### Batas eksposur yang dikelola bot

- `MAX_BOT_MANAGED_EXPOSURE_USD` membatasi agregat posisi yang terbuka dan
  tertunda yang dikelola bot, termasuk principal reopen terproyeksi dari
  workflow rebalance non-terminal yang belum memiliki posisi pengganti
  terkonfirmasi. Biaya per posisi diturunkan dari referensi harga segar;
  referensi harga kedaluwarsa gagal-tertutup.

### Atribusi transaksi exact-hash dan keamanan nonce

- Setiap broadcast dicatat dalam `rebalance_transactions` bersama request
  terserialisasi dan hash persisten.
- Engine mengkueri ulang hash yang sama pada pool RPC terkonfigurasi setelah
  setiap pengiriman. Receipt on-chain yang cocok merekonsiliasi baris menjadi
  `CONFIRMED` dalam satu transaksi; bukti `PENDING` dipantau; bukti `ABSENT`
  gagal-tertutup tanpa retry buta.
- Baris `nonce_mutex` per wallet mencegah broadcast bersamaan pada nonce yang
  sama, bahkan setelah proses dimulai ulang. Aktivitas eksternal pada wallet
  yang sama dideteksi melalui `pending != latest` dan engine tidak akan
  membroadcast ulang secara buta.

### Keamanan dry-run dan darurat

- `DRY_RUN=true` adalah nilai bawaan. Perintah preflight merupakan jalur
  publik; perintah broadcast memerlukan perubahan eksplisit
  `EXECUTION_ENABLED=true` dan lolos state keamanan terkonfirmasi.
- `EMERGENCY_PAUSE=true` bersama baris persisten `manualPause=true` pada
  `operator_safety_state` membentuk penutupan dua gerbang.
- `safety-pause` dan `safety-resume` memerlukan string alasan literal dan
  penanda konfirmasi; baris persisten adalah sumber kebenaran otoritatif saat
  boot.

## Instalasi lokal

```
git clone <repository>
cd <repository>
npm ci
cp .env.example .env
# Edit .env untuk mengatur RH_RPC_URL, ALCHEMY_RPC_URLS, dan placeholder lain.
# Semua nilai harus sintetis saat pertama kali dijalankan; lihat peringatan di
# .env.example.
npm run typecheck
npm test
```

`.env.example` yang disertakan menetapkan:

- `EXECUTION_ENABLED=false`
- `DRY_RUN=true`
- `EMERGENCY_PAUSE=true`
- `LIVE_CANARY_ENABLED=false`
- `V4_LIVE_CANARY_ENABLED=false`
- Batas konservatif untuk gas per transaksi, gas siklus hidup, dan slippage.

Penggunaan live pertama dengan wallet nyata **bukan** jalur yang didokumentasikan.
Urutan onboarding kanonis didokumentasikan di `docs/ROBINHOOD_RECON.md` dan
audit deployment (`npm run cli -- deployment-audit --live`). Eksekusi live
bersifat tingkat-operator dan memerlukan preflight lengkap, verifikasi
deployment, serta tinjauan hash kode independen.

## Inisialisasi database

Jalur database kanonis adalah `${DATA_DIR}/robinhood-lp.sqlite`. Migrasi bersifat
append-only dan bernomor (`001_initial.sql` hingga
`infra/migrations/*.sql` tertinggi). Inisialisasi berlangsung otomatis pada
setiap pemanggilan CLI yang membuka database:

```
npm run cli -- db-migrate   # migrasi eksplisit + status
npm run cli -- db-status    # migrasi yang sudah diterapkan + tertunda
npm run cli -- db-backup    # backup online bertanda waktu melalui SQLite Backup API
```

Pemeriksaan direktori sebelum `db-migrate` dilakukan saat boot; CLI akan
gagal-tertutup bila database hilang atau tidak dapat dibaca.

## Typecheck dan pengujian

```
npm run typecheck
npm test
```

Suite pengujian dibatasi pada berkas kanonis `*.test.ts` dalam `tests/`.
Pengujian yang memerlukan fork Anvil lokal digerbang oleh `ANVIL_BIN`; pengujian
yang memerlukan RPC mainnet digerbang oleh environment variable
`ALCHEMY_RPC_URLS` dan akan dilewati bila tidak disetel. Pengujian khusus live
dilewati saat `npm test` pada rilis publik ini; pengujian tersebut tidak
diperlukan untuk memvalidasi typecheck publik atau cakupan unit kanonis.

## Ringkasan model operator

- Satu operator, satu bot Telegram, satu wallet terkonfigurasi.
- `DEDICATED_WALLET_ADDRESS` (atau `OPERATOR_WALLET` / `WALLET_ADDRESS`) adalah
  satu-satunya EOA untuk baca dan (saat eksekusi aktif) tulis. Wallet harus
  merupakan signer khusus dengan saldo rendah.
- `LP_PRIVATE_KEY` adalah private key EOA opsional. Biarkan kosong di
  lingkungan bersama; gunakan secret manager platform bila diperlukan.
- Akses Telegram digerbang oleh `TELEGRAM_ALLOWED_USER_IDS`; chat id yang
  dikonfigurasi adalah `ROBIN_TELEGRAM_CHAT_ID`.

## Tata letak repositori

```
apps/
  cli/                 # CLI keselamatan publik (db, runtime, wallet, preflight,
                      #   rebalance, rekonsiliasi exact-hash, audit,
                      #   rebalance-commitment-release)
  shared/              # helper lintas aplikasi (isolasi kredensial,
                      #   redaksi secret)
  telegram-lp-bot/     # bot operator berbasis grammy (posisi, portofolio,
                      #   callback range, tampilan persistence-first)
  workers/             # worker cache-state, worker registry v4,
                      #   kanal peringatan opsional
packages/
  robinhood-core/      # RPC, kesehatan, helper v3, utilitas ERC-20
  uniswap-v3-adapter/  # matematika tick/range/likuiditas v3, gerbang eksekusi
  uniswap-v4-adapter/  # poolId v4, sqrtPriceX, jumlah, matematika tick
  lp-ledger/           # ledger event append-only, akuntansi PnL
  astra-robinhood-adapter/  # adapter observabilitas sisi Robinhood
infra/
  migrations/          # migrasi SQL append-only
config/
  robinhood-v3-deployments.<block>.json   # registry deployment v3 yang dipin
docs/
  ROBINHOOD_RECON.md   # audit chain dan deployment v3 (hanya alamat publik)
tests/                 # berkas kanonis *.test.ts
.env.example
.gitignore
package.json
package-lock.json
tsconfig.json
vitest.config.ts
```

## Keterbatasan yang diketahui

- Dukungan Uniswap v4 digerbang oleh semantik fee dan klasifikasi hook pool;
  pool dengan `dynamicFee` atau hook tidak didukung akan dilaporkan `BLOCKED`
  di registry dan dikecualikan dari pratinjau.
- Eksekutor rebalance dibatasi pada satu jendela eksekusi live per workflow.
  `rebalance-resume` adalah jalur pemulihan kanonis untuk workflow yang
  mencapai `FAILED_RECOVERABLE`; perintah ini tidak pernah membuat ulang
  pratinjau.
- Pengiriman Telegram dibatasi pada satu chat id per bot dan memerlukan
  `TELEGRAM_ALLOWED_USER_IDS` berisi user id operator. Bot akan menolak mulai
  bila tidak demikian.
- Worker cache-state dan registry v4 memakai cadence dan batas batch per siklus
  yang dibatasi. Cadence bawaan adalah 60 dtk untuk cache state dan 15 dtk
  untuk registry; keduanya dapat dikonfigurasi melalui
  `STATE_CACHE_CADENCE_MS` dan `V4_REGISTRY_CADENCE_MS`.
- Rekonsiliasi exact-hash mengharuskan pool RPC mengembalikan hash yang sama
  dari seluruh provider terkonfigurasi. Ketidaksepakatan provider gagal-tertutup
  dan muncul sebagai `INCONCISE:PROVIDER_DISAGREEMENT` pada pratinjau.

## Penafian

- Ini adalah alat LP personal, operator tunggal, dengan dry-run sebagai
  prioritas. Ini bukan produk kustodian, layanan multi-tenant, atau bot trading
  serbaguna. Jangan menyetor dana yang tidak sanggup Anda rugikan.
- Selalu pasangkan pembaruan kode dengan audit deployment, preflight baru, dan
  tinjauan manual jurnal `rebalance_*`, `v4_lifecycle_*`, serta `v4_positions`
  untuk workflow target.
- Alamat chain publik, bytecode kontrak, dan identifier pool yang dirujuk dalam
  repositori ini dicatat untuk transparansi; bukan rekomendasi untuk berinteraksi
  dengan kontrak atau pool tertentu.

## Lisensi

Tidak ada lisensi yang disertakan. Operator belum memilih lisensi untuk rilis
publik ini. Secara bawaan, seluruh hak dilindungi sampai lisensi ditambahkan.
