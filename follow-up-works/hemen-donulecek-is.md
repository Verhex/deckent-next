# Hemen dönülecek iş — Opus ana hattı (2026-09-23 askıya alındı)

Owner 2026-09-23: acil iş önce — Cursor terminalinin main'e alınması ve vLLM indirme/kurma/bağlama kararı.
Bu belge, acil iş bitince Opus'un kaldığı yerden devam etmesi içindir. Owner buradan ayrıntılı prompt verir;
Opus önce bu belgeyi, sonra main/kanal durumunu kontrol edip devam eder.

## Askıya alındığı andaki durum

- Main `041e7f3` (push yok): B09-1 `443006e`, Cursor Paket C birleştirme `c6d42f7`, entegrasyon düzeltmesi `a7ee8e4`, PLAN notu `041e7f3`.
- Commit edilmemiş: `follow-up-works/current-flow.md` (Astra notları da içinde; bilinçli olarak commit dışı) ve bu belge.
- Kanıtlar: `/home/alperen/deckent-refactor-work/proof/B09-WORKER-EVENTS-2026-09-23/`, `proof/F26-TERMINAL-PACKAGE-C-INTAKE-2026-09-23/`.
- Cursor için hazır prompt: `/home/alperen/deckent-refactor-work/CURSOR-TERMINAL-PACKAGE-D-PROMPT-2026-09-23.md`
  (canlı worker satırı, `/transcript`, yüksüzlük ölçümü). Acil terminal/vLLM işi bunu değiştirebilir; dönüşte yeniden kontrol et.
- Entegrasyon worktree'si `/home/alperen/deckent-next-wt-integrate-c` (dal `integrate/terminal-package-c`) ve
  `/home/alperen/deckent-next-wt-terminal-c` artık yalnız referans; silme owner'ın.
- LIVE kurulum güncellenmedi (ayrı aktivasyon kararı; DOGFOOD standing OFF).

## Astra 2046 bulguları (bağımsız inceleme; dönüşte ilk iş)

Astra önerisi: önce C11 kapsam/kimlik ve B09 sınırlı-redaksiyon negatif kanıtları; bu kaynak yolları kapanmadan tekrar tekrar tam suite koşma.

1. **C11-1 (94741da) REVISE.**
   - P1: engine scope+idempotencyKey hash'ini ledger'a yazıyor ama adapter'a ham `command.idempotencyKey` gidiyor; HTTP lookup
     global `/idempotency/<key>` ve hedef/payload'a bağlı değil. İki scope aynı anahtarla birbirinin makbuzunu alabilir (yanlış settle).
     Düzeltme: kalıcı niyete bağlı, isim alanlı anahtar (scope + hedef/uç kimliği + operasyon/payload bağı) ve makbuz uyum doğrulaması.
     Test: iki scope / aynı çağıran anahtarı / farklı kayıt + aynı scope replay.
   - P2: `http-conditional-effect` send() yalnız soket boşta kalma süresi; metrics'teki gibi toplam süre sınırı + damlatma testi.
   - Sözleşme: replay'de güncel katalog/hedef, saklanan niyetle karşılaştırılmıyor; uç/config değişimi eski unknown etkiyi başka
     servise yönlendirebilir. Hedef + descriptor kimliğini sabitle/karşılaştır; değişen ucun yönlendiremediğini kanıtla.
   - Eşzamanlı aynı replay: başka çağıran settle ettikten sonra EFFECT_CONFLICT yerine yeniden yükle, aynı dayanıklı başarıyı ayırt et.
   - Global kind+id meşgul kapsamı yalnız kind tek fiziksel servis isim alanıysa güvenli; bu kimlik açık olmalı.
2. **B09-1 (443006e) REVISE.**
   - P1: `tool.call.target` `redactText`'ten geçmiyor; gizli bilgi içeren dosya adı olaylara ve transcript'e sızar. Tüm dışa verilen
     serbest metin alanlarını (target, tool adı/id, model/oturum kimlikleri) redakte et; gizli bilgili dosya adı negatif testi.
     Belgele: üretici tarafı temizlik düşmanca worker'a karşı gizlilik sınırı değildir (worker şemaya uygun metni doğrudan POST edebilir);
     host tarafı dışa aktarım kısıtları gerekir.
   - P1: gateway reddedilen her parti için sayılmayan bir `dropped` olayı ekliyor; limit sonrası sonsuz geçersiz parti sink'i
     5000/4 MiB sınırının ötesine büyütür. Kayıp işaretlerini toplam bütçe içinde birleştir, bütçe bitince alımı durdur/reddet.
     Negatif test: limit sonrası çok sayıda geçersiz istek → sink uzunluğu/bayt/kuyruk sınırlı.
   - Mühürlü artifact bellekteki olaylardan kuruluyor; `worker.events` yazımı başarısız olursa (healthy=false) ikisi ayrışır.
     Projeksiyon sağlığı/kaybını görünür kıl.
   - ENOENT → `LOCAL_RUNTIME_UNAVAILABLE` makul bulundu.
3. **Paket C (2045):** `/exit` PTY kriteri PASS (test edilen yerel sağlayıcı senaryosunda). Metrics P2: `localhost` adını DNS'ten
   önce kabul etmek loopback bağlantısını garanti etmez; yalnız literal loopback adresi kabul et ya da çözümleyip tüm adresleri
   denetle; "localhost non-loopback'e çözülürse temas öncesi red" testi. Tip tekrarı bloklayıcı değil.
4. **2040 PASS** (B06-1 fence). **2042**: sınırlı deneme kanıtı tutarlı, B07 kapanışı değil; SQLite timeout satırı yeniden deneme toleransıdır, kök neden kanıtı değil.
5. **2043 ANALYSIS (atama tasarımı), kabulden önce eklenecekler:**
   - Ledger: değişmez karar kimliği/digest'ler, seçilen bağlama, otorite ve yürütme bağı; ayrıntılı aday nedenleri/anlık görüntüler
     içerik adresli artifact + retention. Yalnız hash ile replay olmaz.
   - Kota gözlemi: sağlayıcı/hesap kimliği, host alım zamanı, TTL/reset, köken; bayat/bilinmiyor ≠ tükenmiş. Anlık seçim kapasite
     rezervasyonu değildir: mevcut runtime admission'ı atomik kullan, çakışma/yeniden planlamayı kaydet, sessiz ikame yok.
   - Pin policy/yetenek/aktivasyon/sert güvenlik sınırlarını aşamaz; asgari tier istisnası açık scoped yetki + gerekçe ister.
     `sourceBearing=false` etiketi yetkiyi düşüremez; bilinmeyen/karışık iş muhafazakâr gereksinim alır.
   - Uçuştaki işler için katalog/skill/model/efor revizyonları sabitlenir; yeni revizyon yalnız yeni kararları etkiler.
   - Held-out replay seçim/kısıt uyumunu test eder, seçilmeyen modellerin daha iyi sonuç vereceğini KANITLAYAMAZ; seyrek veri için
     belirsizlik/asgari kapsam/çekimserlik; performans kazancı için ayrıca yetkilendirilmiş karşılaştırmalı değerlendirme.
   - Worker olaylarıyla gelen kota/kullanım worker-bildirimidir; güvenilir sağlayıcı gerçeği/fatura değildir.
   - Sıra B09-3 → G31 → B09-2 → G32 ancak mevcut sert sınırlar korunursa; atama yeni final-rapor sınırlarına bağlıysa o asgari
     sözleşme G31'den önce. "Yük yok" = ölçülmüş sınırlı ek yük, sıfır değil.
6. Kanaldaki 2011 (astra → fable, eski core-memory bulgusu: farklı-provider ikinci görüş ayrıntısı) hâlâ açık; Opus'a adresli değil.

## Owner kararı bekleyenler

- Ajan/skill/model/efor atama + evrim tasarımı: `/home/alperen/deckent-refactor-work/ASSIGNMENT-EVOLUTION-DESIGN-2026-09-23.md`
  (Jev d37d25c1 `shadow_then_promote` 1,00; kontroller 0,70–0,84; `guard_as_data` sorusu yorumlanamaz). Astra 2043 eklemeleri
  belgeye işlenmeli, sonra owner checkpoint'i; PLAN'a G31/G32 satırı ancak onaydan sonra.
- LIVE kurulumu yeni main'e geçirmek (ayrı aktivasyon kararı).

## Dönüşte önerilen sıra

1. Main ve kanal durumunu doğrula (acil terminal/vLLM işi main'i değiştirmiş olabilir; diff'i oku, testleri bilmeden yeniden koşma).
2. B09-1 REVISE düzeltmeleri (redaksiyon + gateway kayıp bütçesi + projeksiyon sağlığı) negatif testlerle.
3. C11-1 REVISE düzeltmeleri (isim alanlı idempotency, makbuz uyumu, hedef/descriptor sabitleme, toplam süre sınırı, eşzamanlı replay).
4. Metrics `localhost` çözümleme sınırı (Paket C P2) — vLLM bağlama işiyle çakışıyorsa oradaki kararla birlikte.
5. Tek tam verify, commit (owner yetkisi), Astra REQUEST_REVIEW.
6. Atama tasarımına Astra 2043 eklemeleri → owner checkpoint → B09-3 (canlı satır üretici + Codex normalizer) → G31-1.

Her dilimde: Jev danışması (karar gereken bulgularda), `effort.mjs` kaydı, current-flow/PLAN/ARCHITECTURE/CHANGELOG uzlaştırması.

## Astra'nın owner'a verdiği özet (2026-09-23 21:55, 2046 ile yanıtlandı ve tüketildi)

Astra altı entry'yi (2040–2045) kaynak ve mevcut loglar üzerinden inceledi; testleri yeniden koşturmadı.
- 2040: B06 düzeltmeleri PASS.
- 2041: C11 REVISE — scope'lar arası idempotency çakışması ve zaman sınırı açığı.
- 2042: Dogfood deneme kanıtı tutarlı; genel kapanış değil.
- 2043: Tasarım önerilerine sınır ve ölçüm düzeltmeleri.
- 2044: B09 REVISE — redaksiyonsuz hedef yolu ve olay sınırını aşan kayıtlar.
- 2045: Gerçek PTY /exit kanıtı PASS; metrics'te localhost çözümleme sınırı açık.
Astra'nın önerdiği sonraki adım: C11 bulgularını gidermek. 2046'nın tam metni yukarıdaki "Astra 2046 bulguları" bölümünde; kanalda artık yok.
Devam işlerinde Astra'ya yeni entry gönderirken `re=2046` ile bu bulgulara atıf yap.
