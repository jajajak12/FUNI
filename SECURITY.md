# Kebijakan Keamanan

Laporkan kerentanan secara privat dan berikan waktu yang wajar untuk investigasi serta perbaikan sebelum pengungkapan. Jika belum tersedia alamat kontak keamanan privat, buka issue GitHub minimal untuk meminta kanal kontak keamanan privat; jangan ungkapkan detail kerentanan atau secret secara publik.

Jangan sertakan private key, seed phrase, mnemonic, API token, token bot, atau kredensial RPC dalam laporan. Jika signer key pernah terekspos, segera hentikan pemakaiannya dan rotasi key tersebut.

File `.env` tidak boleh di-commit. Database produksi, log, bukti runtime, dan artefak operasional juga tidak boleh dilampirkan ke issue atau kanal publik. Gunakan contoh sintetis dan redaksi nilai sensitif ketika menjelaskan reproduksi.

Kami meminta responsible disclosure: hindari akses data yang tidak diperlukan, jangan memindahkan dana, dan jangan melakukan pengujian destruktif terhadap sistem pengguna lain.

Ketentuan lisensi tersedia dalam [LICENSE](LICENSE).
