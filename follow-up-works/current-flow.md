# Anlık iş akışı — devir, sıradaki adım, kanıt (2026-09-29, Opus 5.5 lead)

Bu belge yalnız güncel durumu tutar; önceki sürümü Git geçmişinde, kanıtlar `deckent-refactor-work/proof/`.

## Bu oturum — skill/rule düzenlemesi (owner 2026-10-02)

- İlk dört karar owner ile tek tek: ortak `deckent-next-refactor`, read-only bootstrap/audit güncellendi;
  ayrı outcome-ordering kaldırılıp sıralama ilkeleri ortak rehbere taşındı. Jev ayrıntıları `jev-workflow.md` içinde.
- Owner kalan 19 skill'in Jev analizini, kararını ve uygulamasını devretti. Her dosyada koruma/güncelleme/
  birleştirme/kaldırma ve alternatifin kazanım/kaybı değerlendirildi: **17 güncelleme, 1 birleştirme, 1 kaldırma**.
  Versioned-handoff'un devir ilkeleri ortak rehberde; genel design-system paketi aktif katalog dışında arşivde.
- Sonuç: başlangıçtaki 23 → **20 aktif skill**. Next'te olmayan legacy giriş/kapılar, token `--check` ve
  Desktop/Dashboard çıktıları temizlendi; gerçek palette kaynağı/üreticisi/yolu yazıldı. Kabul edilmiş tasarım
  yönü korunur; hedef/çalışan yüzey, Jev/self-review/bağımsız review ve rapor/product state ayrımı açık.
- Jev: 19 kayıtlı yanıt (`jev-1.13.0`), 19 karar ve 19 statik-kapsam outcome journal'da. Seçimlerin tümü 0,90 altında; bağlam yeterliliği
  18/19 çağrıda 0,75 altında (tamamı ilk çağrı hedefi 0,85 altında). Eşiği geçti veya independent PASS denmedi.
  İki çekimser seçenek her çağrıda ayrı sunuldu, seçilme sayıları ayrı ayrı 0; olasılıklar dosya raporunda.
  İlk ağ-kısıtlı çağrı unavailable/usage unknown; açık ağ izni sonrası kayıtlı danışma yapıldı, gizli retry yok.
- Kanıt/karar/asıllar: `../deckent-refactor-work/proof/SKILL-CLEANUP-2026-10-02/remaining-130706Z/`;
  önceki ordering arşivi `outcome-ordering-121638Z/`. Kurulum öncesi/sonrası ve arşiv hash'leri doğrulandı.
  Root AGENTS/CLAUDE eşit 55 satır ve byte olarak korundu; tarihsel migration ve diğer katkıcı WIP'i korunur.
- Doğrulama: etkin 20 skill biçimi, YAML/yerel linkler, üç-host eşitlik ve kurulum/arşiv/koruma kontrolü geçti
  (321 statik kontrol). lint-arch 0 ihlal/0 uyarı; memory 12 dosya/0 ihlal, manifest yenilendi; diff temiz. Ürün kodu/runtime ve DesignSync değişmedi; bağımsız PASS yok. İlk teslimde ürün tam verify koşulmadı.
- Owner son yönlendirmesi: skill çalışmasının commit'i ve commit sonrası ayrıntılı Opus kanal kaydı yetkili.
  Commit öncesi exact aday ayrı doğrulama kopyasında npm run verify ile kontrol edilir; push/canlı işlem yetkisi yok.
  İlk teslimde kaldırılan 31 dosya indekslenmişti (mimari kapı git ls-files kullanır); diğer WIP commit dışındadır.
  Commit kimliği, gerçek verify sonucu ve kanal receipt'i dış proof/Opus entry ile kaydedilir.
- Sıradaki: kalan rule analizi daha sonra owner ile tek tek; skill düzenlemeleri tamamlandı.
  Üç taze host oturumunda gerçek otomatik etkinleşme ve tarihsel kullanım sıklığı ölçülmedi.

## Durum
- **Güncel (2026-10-02 akşam, ana oturum):** 25. parti Sol 2246 sınırlı PASS (exact `aa58f559`; yazar tam verify 541/3908 EXIT0) → `origin/main` = `aa58f559` push edildi; dev-release stage `aa58f55972ed-04f7af80815e`, canlı hâlâ `b881b177` (owner switch bekliyor). Yerel main = skill düzenlemesi `5b019720` + bu birleşme. CATALOG-V3 Sol 2247 sınırlı PASS (`a8a7c9d7`, 26. parti adayı). Aşağıdaki satır 25. parti hazırlık anının kaydıdır. Önceki: main = canlı = `b881b177` (MONITOR; canlı sürüm `b881b177ea5f-b253bc7b85e2`). **25. parti** `integrate/2026-10-02-z` (worktree `/home/alperen/deckent-next-integrate-z`, aday `95c72a81`): B1 APPROVAL-ASSURANCE `7fa21214` (Sol 2235 REVISE → `31b0e4ca` → 2239 REVISE → `ed52f4d0` → 2241 yalnız R2b sınırlı PASS), PACKAGED-WORKER-BOOTSTRAP `a72d3661` (Sol 2238 sınırlı PASS; N1'de paketli build ile native worker init gözlemi açık), belge dilimi `a56a3f26`, LONG-LIVED-AGENTS/CLI-HELP PLAN satırları, MCP-NO-DECIDE `f98f5cf0` (`57c49ac6`; MCP'de onay kararı yok, list/inspect kalır), D3 portu `95c72a81`. Yazar tam verify exact `95c72a81` 540/3890 EXIT0 (`proof/INTEGRATE-2026-10-02-Z-verify-95c72a81.log`). Sol 2243 (istek 2242) **REVISE**: B25-R1 (monitör worker satırı heartbeat durumu; `lane/b25-revise` `aedbec9e`, birleşme `f9e3f3d7`; Codex uygulayıcı, lead hedefli 3 dosya 22/22, typecheck/arch temiz; `proof/B25-R1-2026-10-02/review.md`), B25-R2 (bu belge + PLAN durumları), B25-N1 (Azure metni; R2+N1 `037dcb2c`) — yalnız delta yeniden incelenir; yeni aday için tam verify koşuyor. Paralel şeritler: A1/A3 `lane/run-park-timeout`, CATALOG-V3 `lane/catalog-v3` (Codex). Dogfood N1 havuzu 8 slot (config yedekli; servis yeniden başlatması bekliyor). **Sıradaki:** B25 düzeltmeleri → delta Sol → push → stage → owner switch → N1 köprüsünü canlı build'e çevir.
- **MONITOR (owner 2026-10-02 tek görev; tarihsel — tamamlandı, canlı `b881b177`):** `deckent monitor` (tam ekran, `--once`, `--json`) + terminal `/monitor`; `integrate/monitor` (taban a2971850). Diğer işler owner talimatıyla bekliyor: B1 şeridi `ed52f4d0` (Sol 2240/2241 okunmadı), PACKAGED-WORKER-BOOTSTRAP (Sol 2238 sınırlı PASS), belge dilimi `lane/docs-batch25` 7283c9d4, dogfood D3 (N1 `a02b67a9`). Kanıt `proof/MONITOR-2026-10-02/`. **Sıradaki:** tam verify + Fable yeniden inceleme → push → stage → owner switch → canlı config'e N1 gözlenen kurulum.
- **Tarihsel (2026-10-01 gece, ana oturum deckent-next-fa; o günkü origin/canlı):** 24. parti push edildi — `origin/main` = `a2971850` (CI-PLATFORM `a5fea81c` + owner kararları belgesi);
  yazar tam verify exact `a2971850` 530 dosya/3789 test EXIT0. İncelemeler kapsamlarıyla: Sol 2233 (istek 2231 + 2232) PASS yalnız belge kararlarının receipt uyumu
  ve belge merge/korunma kapsamı (CI uygulaması, bütün parti, hosted/native ve canlı kabul dışında; DOC-N1..N3 düşük notları bu dilimde işlendi, Sol doğrulaması sonraki incelemede); Fable 5.1 CI-PLATFORM
  bağımsız PASS (`a5fea81c`, 4 düşük/gözlem borcu). Hosted `a2971850` koşuları 36905506423 / 36905506592: sonucu okunmadı. **Canlı hâlâ `76582f9f`**
  (`76582f9f1cd2-08512bc400d1`, instance `1dd5ea76`, ledger 44; `proof/LIVE-SWITCH-BATCH23-2026-10-01/`); C4 `attempt:release` grant'ı canlı policy'de.
  Owner kararları (logged Jev sonrası): dalga 3 (5 owner konusu güvenli seçenek: K1/LANG/TRTEXT/EFFDETAIL/OWNERROLE ertelendi; 7 lead kaydı), dalga 4 (8 owner konusu
  güvenli seçenek; 14 lead kaydı; Azure düzeltmesi; 4 yeni bulgu), dalga 5 (tam TUI = hepsi kapsamda; proje talimatları ertelendi; S-API sırası A0 → LOCAL → STREAM →
  DASHBOARD-READ + kurumsal WebSocket değerlendirmesi; Telegram yeniden bağlanır; öğrenen bellek; I18N-ORPHANS B ile K2 "3,374 retained" daraltması), DOGFOOD
  `staged_refresh_then_gates` (S0/S1/S2) — hepsi 25. parti belge diliminde (`lane/docs-batch25`): PLAN "İş listesi eşlemesi" + ARCHITECTURE karar günlüğü; hiçbiri uygulanmadı.
  Uygulama sırası (lead, Jev e775b172 eşik altı → en güvenli geri alınabilir): `b1_then_wave1`.
  **DOGFOOD:** resmî OFF. S0 yenilemesi yapıldı (18:48Z; N1 `a2971850` tabanı, N1 ledger v43→v44 yedekli; `proof/DOGFOOD-S0-REFRESH-2026-10-01/`). D3 bulguları:
  sandbox verify profili v5 (`--configLoader runner`) + v6 (deadline 1200000 ms); D3-1 paketli kurulumda native worker açılmıyor → **PACKAGED-WORKER-BOOTSTRAP**
  (canlı `76582f9f` paketli build'i de etkilenir; şerit `1d9a3fcf`+`b9bdcf73`, incelemede); K7 köprüsü geçici olarak `a2971850` tsc build'ini
  (`deckent-next-integrate-y/dist`) koşturuyor — K9 kuralından lead sapması; öldürülen bir verify Run'ı `evaluating`'de `TASK_EVALUATION_NOT_READY` ile takıldı,
  lead elle iptal etti (A1/A3 canlı örneği; iptal makbuzu proof'ta yok).
  **B1 APPROVAL-ASSURANCE:** `lane/approval-assurance` `041c424c`+`ba0b47aa`+`31b0e4ca` (Sol 2235 REVISE, istek 2234, B1-R1..R3 düzeltildi); Sol yeniden incelemesi bekliyor.
  Açık: EXEC-RELEASE C1–C3 (lead Jev), ER-N1/N2, CI-FULL F1/F2, eski MCP oturumlarının yeniden başlatılması (owner).
  **Sıradaki:** B1 Sol yeniden incelemesi + PACKAGED-WORKER-BOOTSTRAP bağımsız incelemesi → bu belge dilimiyle parti adayı tam verify → Sol → push (canlı geçiş owner'da);
  sonra A1+A3 ortak park/zaman aşımı ve kalan dalga 1; DOGFOOD S1 kapısı B1 + A1/A3 + canlı config/grant'lar + dilim 3 + SELF-SOURCE-FLOOR sonrası.
- **CI-WINDOWS-MACOS (2026-10-01, Sol uygulayıcı):** `lane/ci-sol-2` / exact taban `76582f9f`; run36884716187 Linux 24/26 success,
  macOS 24/26 51 dosya/153 fail; Windows iki verify job'ı >75 dk, owner yetkisiyle iptal istendi (16:47:06Z), cancelled 16:47:51Z/16:47:43Z.
  Windows/26 yaklaşık 66 dk, Windows/24 yaklaşık 33 dk çıktısız kaldı; iki asılı dosya `shell-fs-ops`/`shell-sandbox-bwrap`.
  Kök neden: ata traversal Windows drive root sabit noktada sonsuz döngü; OS deadline red → root-stop green. macOS 48 dosya/209 hedefli test Linux
  koşusunda geçti (0 skip); darwin/win32 yalnız guard simülasyonu/native kabul açık. USERPROFILE fixture, metadata ayırıcı ve görünür POSIX-mode kapıları düzeltildi.
  Eksik O_NOFOLLOW/O_NONBLOCK nedeniyle CLI dosya girişi ve terminal history/session erişimi tipli ret ile kapanır; stdin korunur.
  Final yerel sonuç: typecheck/ESLint144file/arch/memory/build temiz; Node26 son guard+COMMIT crash19/19, win32 guard47file30pass177skip ve scoped25file51pass108skip (Linux simülasyonu).
  Windows native fail union130file453/424case; final envanterde14dosya kök neden/native kanıtı açık, bütçeler yükseltilmedi.
  Sıradaki: dış final receipt/şerit commit → lead exact aday full verify/bağımsız inceleme; native platform green ve Windows timing/lock/descendant kök nedenleri açık. Push/re-run/canlı servis yok.
  Kanıt `../deckent-refactor-work/proof/CI-WINDOWS-2026-10-01/`.
- **Yirmi üçüncü parti (2026-10-01; `integrate/2026-10-01-x`, worktree `/home/alperen/deckent-next-integrate-x`, taban 22. parti `8ec36126`):** + CI-FULL
  (`lane/ci-sol` `10d5cbde`, Sol uygulayıcı, lead commit'i yamadan 28/28 hash eşit). Bağımsız inceleme: lead'in ayrı bağlamda başlattığı Fable 5.1 alt ajanı **PASS**
  (`proof/CI-FULL-2026-10-01/review-independent.md`; F1 düşük: `runtime-overlay-parents.test.ts:94` gerekçesi adsız win32 skip; F2 açık: yük altında bir kez
  düşen `shell-overlay-write-set.test.ts:111`, tek başına 6/6, kök neden yok — ayrı izlenir). Hosted CI kabulü push sonrası altı hücre + bwrap ile.
  Sol 2226 REVISE (22): ER-R1 mühürlü event akışı doğrulanmıyordu, ER-R2 scope çapında mezar silme → `5dd9bf08` (red 2 fail → green 31/256, mutasyon 7–9 düştü), 23'e birleşti.
  **Tamamlandı (2026-10-01):** tam verify 526/3766 → Sol 2228 PASS (yalnız ER-R1/R2 kaynak + mevcut yazar negatif kanıtı için sınırlı; bütün parti/hosted/canlı kabulü değil; CI-FULL Fable PASS ayrı) → push `76582f9f` → hosted CI → canlı 16:37Z → yeni ana oturuma devir (`proof/HANDOFF-MAIN-2026-10-01-B/`). Hosted run 36884716187: Linux 24/26 SUCCESS, macOS 24/26 FAILURE, Windows 24/26 cancelled (CI-WINDOWS-MACOS yukarıda).
- **Yirmi ikinci parti (2026-10-01; `integrate/2026-10-01-w`, worktree `/home/alperen/deckent-next-integrate-w`, taban `d11bdbfa`; ana oturum deckent-next-f6):**
  EXEC-RELEASE (`da102c4a`+`c0abc834`; owner D8; sahip = yama saklama geçişi, lead a′ mühürlü event log koşulu; composition 5500/5500) + SECRET-WRITE-CLOCK
  (`3bdd8111`+`a4616cfb` + lead arch `19a6aa19`; kararsızlığın kök nedeni WSL2 duvar saati geri adımı, `proof/SECRET-WRITE-FLAKE-2026-10-01`) + host-insights (`fc2b69e3`,
  auditor erken bulgu tablosu) + lead bütçe katlaması `8d5df641`. Açık: EXEC-RELEASE C1–C4 (PLAN), PROVIDER-SPEND-CLOCK, EXEC-RELEASE-INTEGRATIONS.
  Tam verify `8ec36126` 523/3748 geçti, 0 atlanan (`proof/INTEGRATE-2026-10-01-W-verify-8ec36126.log`); Sol REQUEST_REVIEW 2225. Dalga 1 kart girdileri + Jev J1–J6:
  `deckent-refactor-work/next-graph/deep-harvest/wave1/WAVE1-CARD-INPUTS.md`, `proof/WAVE1-JEV-2026-10-01/README.md` (owner soruları A1/A3/A8).
- **20. parti push edildi (2026-10-01):** Sol 2212 PASS exact `c10411a9` (K5-R1 kapandı: tek okuma snapshot'ı) → `origin/main` = `c10411a9`.
  Açık: `runtime-secret-write` kararsızlığı (ilk koşu 1 hata INSTALLATION_JOURNAL_INVALID, aynı SHA ikinci koşu temiz; kök neden yok), v44 canlı geçişi owner onayı bekliyor.
  **Yirmi birinci parti (yalnız belge):** D1–D10 owner kararları + 7 kart + Sol 2212 DOC-N1 (yüzey envanteri: TUI kısmi).
- **OWNER-DECISIONS-DOCS (2026-10-01; `lane/owner-decisions-docs`, taban `c10411a9`, yalnız belge):** owner kararları D1–D10 (`proof/OWNER-DECISIONS-2026-10-01/README.md`)
  PLAN/ARCHITECTURE'a tarihli kabul edilmiş karar olarak işlendi (karar günlüğü satırı, K1 değişikliği, W0-9 hedefinin kalkması, K6 O1/O2 kapanışı); yeni kartlar EXEC-RELEASE (yüksek),
  LEGACY-CODES-RETIRE, HOST-RULES-CLEANUP, AUDIT-CHECKPOINT, REASONING-RETENTION, CATALOG-SEED, K6-HINT — hiçbiri uygulanmadı. Konum listesi `docs-applied.md`. **Sıradaki:** lead incelemesi → partiye alma.
- **STALE-CLAIMS (2026-10-01; `lane/stale-claims`, taban `01dd71ab`, yalnız belge):** Dev↔Next kıyası öncesi bayat PLAN/ARCHITECTURE iddiaları
  kodla doğrulanıp düzeltildi (ledger v44, protokol v18, Anthropic/OpenAI-chat, B06-2/B09-2, `.deck`, `process`, audit, `/clear`, karar günlüğü
  2026-09-16 satırları için tek düzeltme satırı). Tablo ve owner düzeyi liste `proof/STALE-CLAIMS-2026-10-01/README.md`. 20. partide (birleşme `c10411a9`); O1–O8 owner 2026-10-01'de D1–D8 olarak karara bağlandı (aşağıda).
- **Yirminci parti (2026-10-01; `integrate/2026-10-01-u`, worktree `/home/alperen/deckent-next-integrate-u`, taban `c083ec8e`):**
  CI-HYGIENE (`6d425eaf`; test git ortamında bakım kapalı, test soketleri), K6 kapsam sınıflaması (`1845ecc2`), K5 tipli havuz bekletmesi
  (`68279e85`+`99ac09cf`+`1ed7a508`, ledger v44) + lead düzeltmeleri: CLI birim bütçesi 2000/2000 (tek satır katlandı), Windows build-zamanı
  izdüşüm kontrolleri LF metinle karşılaştırılır (C5; barındırılan CI `c083ec8e` koşu 36835569049: Ubuntu 24/26 **yeşil**, Windows yalnız
  `config-vocabulary` CONFIG_VOCABULARY_STALE, macOS F9), Sol 2208 CI-N1 Git 2.55 atfı düzeltildi, **`workTargets` v2** (v1 yayınlı: `scope` yalnız v2'de).
  Composition 5479/5500. Owner 2026-10-01: benimseme `use`+`adopt` onaylandı; K6 O1 (tam eşleşme) / O2 (kapsamsız işi reddet) owner 2026-10-01'de kapandı (D9 C + K6-HINT, D10 A).
  **Canlı (2026-10-01 08:21Z):** ilk `dev-release` geçişi — `current` = `versions/c083ec8ee3df-e1493d3b471c`, instance `b3e23208`, ledger 43
  (kanıt `proof/LIVE-SWITCH-BATCH19-2026-10-01/`); bu partiyle ledger v44 gelir (v43'e dönüş `--restore-ledger` ister; ilk v44 geçişi boşaltmasız).
  Sol 2210 REVISE K5-R1 (P2: `pool status` iki ayrı okuma — hiç yaşanmamış held+drained) → tek okuma snapshot'ı + deterministik ikinci bağlantı
  yarış testleri (eski kodda kırmızı: `proof/K5-POOL-HOLD-2026-10-01/sol-2210-red.txt`, yeşil `sol-2210-green.txt`).
  **Sıradaki:** tam verify → Sol → push → owner onayıyla canlı → bu tur kapanır; sonra ortak devralma analizi (analiz oturumu deckent-next-40).
- **On dokuzuncu parti (2026-10-01; `integrate/2026-10-01-t`, worktree `/home/alperen/deckent-next-integrate-t`, taban `21110d09`):**
  K3 tipli iş girdisi (`lane/k3-work-input` `31198880`+`425d4b65`; graf v3 `workInput`, `native-coding-template`; ARCHITECTURE alt bölümü)
  + CI-FIX-2 (`lane/ci-fix-2` `83f23b6d`). Barındırılan CI `21110d09` ([koşu 36788067766](https://github.com/Verhex/deckent-next/actions/runs/36788067766))
  6/6 kırmızıydı, yerel verify'dan ayrı: Linux/24 3657/3657 geçti ama bwrap testi soketinden yakalanmamış ECONNRESET (C1, test hijyeni);
  Linux/26 git fixture'ında Git 2.55 arka plan bakım yarışı (C3, test) + F7 (C4, **ürün hatası**: geçersiz parçadan önce aynı okumada gelen
  geçerli delta'lar düşüyordu; Node 26 okumaları birleştiriyor; openai-chat + anthropic-messages); Windows core-memory/config-vocabulary
  ham bayt özeti CRLF'de kırılıyor (C2, LF-normalize özet). macOS F9 kapsam dışı. Kanıt `proof/CI-FIX-2-2026-10-01/README.md`.
  Açık: diğer ~20 fixture deposunda aynı git bakım sınıfı (henüz kırılmadı), diğer `createServer` test soketleri taranmadı, Windows'ta sonraki adımlar doğrulanmadı.
  **Sıradaki:** tam verify → Sol REQUEST_REVIEW → PASS'te push → barındırılan CI → owner onayıyla ilk `dev-release` canlı geçişi.
- **Sol 2202 REVISE (WT-R1) → düzeltildi:** yürütme, tükettiği hedef için aynı config anlık görüntüsünden `work-target:use` ister; hedefi okuyan/yazan her attempt
  işlemi (yürütme, yama hazırlama, entegrasyon denetim/hazırlama, teslim, teslime sabit Run) `use`, benimseme/geri alma `use`+`adopt` (owner K2'den daha sıkı; okuma tüketimdir).
  Aday artık 17+18 birleşik: `integrate/2026-09-30-s`. Kanıt `proof/WORK-TARGETS-2026-09-30/README.md` §8–8.1, Sol metni `proof/SOL-2201-2026-09-30/review.txt`.
- **On sekizinci parti (2026-09-30; `integrate/2026-09-30-s`, worktree `/home/alperen/deckent-next-integrate-s`):** on yedinci partinin (`e7b6d675`, hâlâ Sol 2201 incelemesinde) üstüne
  `lane/dev-u2-0` (sürümlü dev kurulumu: `dev-release.mjs`, `next-entry` `current`, U1 guard; uç `5fdee2a4`) ve `lane/pack-smoke` (terminal sözleşmesi, verify hızlı alt kümesi, kilitli lisans metinleri,
  `path` tip sızıntısı; uç `1cd52ad1`) birleştirildi. Yayın engelleri kapandı (`publishable.ok=true`); `--waive-smoke terminal` artık gerekmez (acil seçenek). Kanıt `proof/DEV-U2-0-2026-09-30/`,
  `proof/PACK-SMOKE-2026-09-30/`; host testleri 71/71 (şerit), tam verify yok. Açık sınırlar: tipli boşaltma yok (K5), G5/G6 işletim kuralı, manifest yalnız switch öncesi (ayrıntı PLAN 18. parti).
  IDE'nin `pack-smoke-dist.test.ts:8` "unused @ts-expect-error" uyarısı yanlış pozitif: `tsc --noEmit` ve eslint temiz (diğer `.mjs` içe aktarmalarıyla aynı kalıp).
  **Sıradaki:** tam verify (yeni pack-smoke testinin süresini ölç) → Sol incelemesi (17 + 18) → push → ilk canlı switch `dev-release` ile (owner onayı; komutlar DEV-U2-0 README §5).
- **On yedinci parti (2026-09-30 gece; `integrate/2026-09-30-r`, worktree `/home/alperen/deckent-next-integrate-r`, taban `74ce44c4`, HEAD belge commit'inden önce `9758cceb`):**
  FA-TRACKED-WARN (`9e0bcf10`, v18'de yalnız sonuç metni), WORK-TARGETS dilim 1 (`f70c47ac`/`7f5c6d72`), WORKER-CURRENCY-2 (`ae6ce536`; owner kural A uygulandı — beyan edilen
  yardımcı serbest, beyan dışı model → deneme kabul edilmez, model çağrıları görünür), dogfood D2-1..D2-3 (`30988c66` → `4f823ee8`), TRUNCATED-TOOLCALL (`ba11dc77`, istem v7),
  CI-F8 CRLF (`f7848e07`), SURROGATE-OPENROUTER (`04892147`, yalnız ayrıştırıcı temizliği), COMPOSITION-RELIEF (composition 5520 → 5454), CI-TERMINAL-CLI (`8ff96a2d`).
  **Doğrulama durumu:** yalnız hedefli testler (lane kanıtları); tam verify yok. **Barındırılan CI (`30988c66`, koşu 36741640264) yerel verify'dan ayrı:** bwrap-bundle SUCCESS (ilk kez);
  ubuntu/Node24 3542 geçti 1 kaldı (→ ci-terminal-cli); Node26 2 kaldı (aynısı + F7); Windows F8 (bu partide); macOS ~425 F9 (kapsam dışı); CI-FIX C0–C2 kapanışı sonraki barındırılan koşuyu bekler.
  **Sıradaki:** tam verify (Docker imajı + bwrap'lı build) → **Sol** REQUEST_REVIEW (bağımsız inceleyen GPT-6.1 Sol, `astra` kanal adresi; owner 2026-09-30) → PASS'te push → canlı geçiş
  (owner onaylı yeniden başlatma; U1: canlı checkout yalnız o geçişte derlenir) → DEV-U2-0 şeridi (owner U2 seçenek C; Jev c2956e5d .94/.68) inince ilk DEV-U2-0 geçişi.
  Canlı config zaten değişti (owner onaylı, Jev 10d392b3 .94): `terminal.chat.maxCompletionTokens` 16384, `local-qwen` v7 `maxOutputTokens` 16384, `limits.timeoutMs` 600000
  (`service.responseTimeoutMs` yalnız son çerçeve yazımını sınırlar; model çağrısını profil `timeoutMs` sınırlar; kanıt `proof/MAX-COMPLETION-2026-09-30/`).
  Açık: `deckent models --help` `catalog` satırı (i18n-parity ile); ayrı `truncated` araç durumu (Jev 0,84, karar); D2 lead inceleme notları (PLAN); K3/K5/K6.
- **2026-09-30 akşam:** `origin/main` = `30988c66` canlıda (16. parti; instance `0c8a0709`, ledger v43). Owner K1–K9 kararları PLAN'da (ikame seçenek A **kararlaştırıldı**,
  17. partide uygulandı). Kanıt `proof/DOGFOOD-K-DECISIONS-2026-09-30`.
- **Canlı (2026-09-30, 15. parti):** `origin/main` = `47a76adf` (Astra 2194 PASS); instance `85d99b8d`, Node 24.21; tam erişimde model curl → HTTP/2 200
  (istem v6). Kanıt `proof/LIVE-SWITCH-BATCH15-2026-09-30/README.md`. **Sıradaki (owner 2026-09-30):** on altıncı parti (`integrate/2026-09-30-q`)
  dogfood D1-0..D1-2 + CI-FIX F1–F6 + WORKER-IMAGE-R4 + WORKER-CURRENCY-1'i birleştirdi (ayrıntı aşağıda; 30988c66 ile canlıya alındı).
- **On dördüncü parti (2026-09-30):** `integrate/2026-09-30-o` (worktree `/home/alperen/deckent-next-integrate-n`, taban `02601269`) =
  Astra 2189 REVISE düzeltmeleri: R7 ata pinleri (açık + kapalı yazılabilir görünüm; lane/r7-ancestor), gömülü bwrap kopya yarışı (link ile yayın),
  R8 doctor MCP launch kuralı (lane/r8-doctor-mcp). Tam verify 490/3467 0 skip (Docker imajıyla) → Astra 2190 PASS → `origin/main` = `51b19dc5` (push 2026-09-30).
  **Canlı (2026-09-30):** instance `6eb54a8c`, build main `979b4b02` (= `51b19dc5` + belge), Node 24.21, config `language: tr`;
  doğrulama: Türkçe yanıt, tam erişimde gerçek HOME, `.deckent/mcp.json` read-only, bubblewrap gömülü (bildirim yok), context7 ok.
  Canlı bulgu: tam erişim turunda istem "Network access: none" diyor → model ağı reddediyor; düzeltme lane/prompt-posture (istem v6).
  Kanıt `proof/LIVE-SWITCH-BATCH14-2026-09-30/README.md`. Birleşmiş worktree/dallar temizlendi.
- **On beşinci parti (2026-09-30):** `integrate/2026-09-30-p` (worktree `/home/alperen/deckent-next-integrate-p`) = PROMPT-POSTURE `37449c8a`:
  istem v6 kabuk duruşunu turun realm çözümünden (`createAgentShell().posture()`, çağrılarla aynı resolveRealm/callRealm) yazar —
  açık görünüm: ağ + gerçek HOME + proje/.git yazılabilir, Deckent durumu mühürlü; kapalı: ağ yok, HOME gizli; host: sandbox yok; fetch_url ayrı.
  Host realm'de standart/full-auto istemi de artık ağın erişilebilir olduğunu söyler (doğru, görünür değişiklik). requestDigest istem hash'i
  içerdiğinden eski turn id tekrarı AGENT_TURN_CONFLICT (bilinçli). Kanıt `proof/PROMPT-POSTURE-2026-09-30/`.
  Astra 2192 REVISE R9 P2 (istem config'i koşulsuz mühürlü diyordu; full-access içinde owner-approved çağrı mevcut config içeriğini yazabilir)
  → `0542196b`: yapısal taban (durum/policy/kimlik) ile config kuralı (onaysız salt okunur, onaylı çağrı mevcut içeriği değiştirebilir) ayrı;
  `posture().configuration` `shellWritePosture('owner-approved')` kaynağından; Astra reviewer testi gerçek serviste kırmızı→yeşil (r9/). Sıradaki: tam verify → Astra. Kanıt `proof/R7-R8-FIX-2026-09-30/`.
- **On altıncı parti (2026-09-30):** `integrate/2026-09-30-q` — dogfood ilk döngüleri D1-0..D1-2 Deckent'in kendi Run/verify/benimseme döngüsüyle
  benimsendi (N1 izole kurulum, topoloji a′: canlıya yazım yok; `c7b44469` → `844048e6` → `0e4fa003` → `b61b34b9`; lead test düzeltmesi `02cff460`;
  kanıt `../deckent-refactor-work/proof/DOGFOOD-D1-2026-09-30/README.md`); CI-FIX F1–F6 (Codex lane + lead F6 düzeltmesi `b9b2ce15`/`28f6bfe0`;
  required Linux job artık bwrap'ı aşamalıyor (F1–F3), PTY fixture CI'de yeşil (F4), git patch `ls-tree` BAD sentinel'i `PATCH_UNAVAILABLE` (F5),
  shared-ledger testi 5 adıma bölündü, en uzun adım ~7 s (F6); GitHub koşusu push sonrası gerekli, C0–C2 DONE/PASS yazılmadı; kanıt
  `../deckent-refactor-work/proof/CI-FIX-2026-09-30/`); WORKER-IMAGE-R4 (`0fd2df1b`; r4 imajı `sha256:bf6973ec…`, Claude 2.1.285/Codex 0.159.2/
  Cursor 2026.09.28; kanıt `../deckent-refactor-work/proof/WORKER-IMAGE-R4-2026-09-30/`); WORKER-CURRENCY-1 (`2231ac8f`; ledger v43 model kataloğu
  sağlayıcı kanalı başına, tam model ID pinleme (takma ad reddi), admission ret kodları, `model.verification`; kanıt
  `../deckent-refactor-work/proof/WORKER-CURRENCY-1-2026-09-30/`). Açık (16. parti anında; katalog CLI/MCP ve ikame kabul kapısı 17. partide
  WORKER-CURRENCY-2 ile kapandı): Codex/Cursor model kanıtı doğrulanmadı; verify imajında bwrap yok; ağaç dışı `node_modules` SBOM açığı sürüyor.
- **Canlı (2026-09-29 18:07'den beri):** yedinci–on ikinci partiler `4a2ac04` build'iyle canlıda; `origin/main` = `4a2ac04` (push `0e0ca63` → `9a3ef2c`
  Astra 2181 PASS → `4a2ac04` Astra 2186/2187 PASS). Instance `74e4359e` (ilk `0b044e1a`, global kök düzeltmesiyle yeniden başlatıldı), Node 24.21,
  protokol v18; eski v16 servisi eski build'in kendi CLI'ıyla durduruldu. Mod göçü dry-run → `--grant-full-access` (bindings v3 + owner full-access
  grant'ı, full-auto korundu); secret yetkisi `owner-secret-store` (`add-secret-grant.mjs`); secret deposu bilerek env (dosya arka ucu geçişi owner'la).
  Kanıt `proof/LIVE-SWITCH-BATCH12-2026-09-29/README.md`. Geri dönüş: `0e0ca63` build'i + yedekler (`migrate-backup/` v2 bindings). DOGFOOD OFF.
- **Canlı bulgu → düzeltme:** ilk kabuk kartı Landlock gösterdi; kök neden next-entry `DECKENT_GLOBAL_HOME` proje içinde → gömülü bwrap kopyası
  proje içinde → güvenlik kuralı reddetti (doğru) → Landlock'a bildirimsiz düşüş. Düzeltme: next-entry global kökü `~/.local/state/deckent-next-dev`
  (main `0360bab9`, push bekliyor; canlı build'in parçası değil), yeniden başlatma sonrası kart "Runs in a bubblewrap sandbox …"; ürün bildirimi
  REALM-NOTICE on üçüncü partide (`bwrap-fallback-investigation.md`).
- Küçük açıklar (kapanış kanıtı yok): bwrap içinde `ls .deckent/live-data/state` giriş adlarını listeliyor (içerik maskeli); terminal kapanınca onay
  bekleyen tur onay TTL'i (9 dk) dolana kadar `running` kalıyor.
- **Astra 2186 (`4a2ac04`) PASS:** R5/R6 kapandı, R1–R4 korunuyor; açık: önceden 1 MiB üstü store kurtarması yok, compact dış dosyada delete
  `SECRET_STORE_FULL` alabilir (dosya aynı/okunabilir). Ayrıntı PLAN "On ikinci parti".
- Ana checkout: Astra'nın yerel notları (stash `astra-main-notes-2026-09-29-live12` / `.deckent/host/reviews/…-live12.patch`) on üçüncü partiye
  işlendi; stash owner/Astra'nın, dokunulmadı.
- Aşağıdaki yedinci–on ikinci parti bölümleri canlıya alınmış partilerin entegrasyon kaydıdır (sonraki temizlikte COMPLETED-PLAN'a).

## Dış çalışma alanı sadeleştirmesi — Astra, 2026-09-29
Owner isteğiyle 7 tüketilmiş devir/plan belgesi ve 18 eski, referanssız kanıt girdisi
`../deckent-refactor-work/archive/2026-09-29-consumed/` altına arşivlendi (71 dosya; `moves.json` eski → yeni yollar, `README.md` geri alma).
Paket ayrı dizine açılarak ve taşınan özgünler SHA-256 ile doğrulandı; içerik silinmedi. `COMPLETED-PLAN.md`'deki beş tarihsel bağlantı
yeni yollara çevrildi (hedefler var); diğer iki belge ve 18 kanıt girdisine izli belgelerde referans yok. Manifest aracı sembolik bağları
izlemek yerine bağın kendisini sayıyor. Aktif kartlar, son üç günün kanıtları ve owner WIP'i yerinde; arşiv için bekleyen silme yok.

## Yedinci parti (`integrate/2026-09-28-h`, worktree `/home/alperen/deckent-next-integrate-h`, taban `5b267a9` + main `0e0ca63`)
- Birleşenler (her biri `--no-ff`):
  - SESSION-RESULT-LIMIT `c67302c` (doctor `modelInvocationDelivery`, `MODEL_ACTIVATION_DELIVERY_UNFIT`).
  - POLICY-ADMIN P1–P3 `6e76c42` → POLICY-HARDEN P3-R `3e01b90` (yetki onayı yalnız yetki yüzeyinde `APPROVAL_SURFACE_RESTRICTED`, settle anında ret,
    `authority-refusal` audit, redakte kart farkı).
  - MCP-CLIENT `4cc7ca0` → `afb7518` (kapsamlı kayıt dosyaları, `mcp.clients` config'ten kalktı) → `db5121d` (add = güven, ilk kullanım kartı, `/mcp`).
  - MCP SDK 2.2.0 + sayfalı araç listesi `d934c5b`; STARTUP-COST `3f879c6` (Ink ve MCP server SDK statik grafikten çıktı).
  - MODE-UX G3 `fd3c5e4`; PERSISTENT-APPROVALS G6 `d389bee` (kapsam seçmeli kalıcı onay; tel v17 ve servis kablosu açık).
  - SANDBOX-SPEED G2 `1ed884d`; TERM-UX-1 `3dbbed7`; ANTHROPIC-PROVIDER G8 `50d86ce` (checkpoint A/B açık).
- SHELL-AUTONOMY birleşti: `9dd8dac` + `9679020` (mod gevşetmesi önce, kalıcı onay son); Astra 2170 düzeltmesi `33f0bec` (testler) + `bbd57f0`
  (üç yazım duruşu; CLI MCP başlangıcı `writeFloor` taşır, eşleyicisiz kapalı başarısız). C5 açık → PLAN SHELL-OVERLAY.
- MODES-3 birleşti: `7fbe476` (kod+test) + `5149c1f` (katalog metinleri), birleştirme `36ee9db` → `d8fb13a` (tek yazım duruşu türetimi `450edd9`,
  Landlock oyma tabanı `869c01f`). Kanıt `proof/MODES-3-2026-09-29/`; canlı göç `review.md` §6 (betik `migrate-live-modes.mjs`, önce dry-run).
  Owner checkpoint cevapları 2026-09-29: full-access'te fetch-unlisted deneme; `ask` → standart+askEdits; etkileşimli ilk kurulum owner tasarlar.
- Astra 2169/2170 REVISE (`6a09a76` üzerinde) karşılandı; belge deltası bu commit'te.
- Lead düzeltmeleri: MCP client SDK'sı tembel yükleniyor (`e7d6553`); 0e0ca63 ↔ MCP kayıt dosyası ajan deny listesi (ürün durumu deny'ı + `.deckent/mcp.json`);
  `surfaces/core/terminal` birim bütçesi (2000) aşımı iki bağımlılıksız parçanın taşınmasıyla çözüldü (kart tuş eşlemesi → `terminal-kit`, `ArrowPicker` →
  `terminal-render`); deny eşleyicisi hızlı yolu platformun tek `GLOB_WILDCARD` tanımını kullanıyor; `APPROVAL_SURFACE_RESTRICTED` ve MCP güven/`/mcp`,
  TERM-UX-1 metinleri en/tr + kayıt; MCP güven deposu okunamazsa typed hata.
- lint-arch 0 ihlal (`d8fb13a`, belge güncellemesinde ölçüldü).
- Sonra MCP-VALIDATOR (`f6bd9d3`) ve belge commit'leri eklendi; parti adayı `ce2440f`.

## Sekizinci parti (`integrate/2026-09-29-i`, worktree `/home/alperen/deckent-next-integrate-i`, taban `ce2440f`)
- Birleşenler (her biri `--no-ff`): MCP-PIN-DEF `c30a651` (pinlenmiş tanım `toolDefinition`, -32020 yeniden gönderilmez, structuredContent
  doğrulanır); DEPS-SCHEMA `2947c81` + arch kenarı `59d9403` (kayıt `optionsSchema` Standard Schema v1); DEPS-GOV `1c76748` + `3680370` + `b5369fd`
  (`dependencies.json`, lint-arch dış import kapısı, `deps-watch`, kabul edilmiş riskler; fast-uri girdisi 2026-10-29'da biter); ANTHROPIC-PROFILE
  `3be2c7a` (model yetenek kaydı, `effort`, adapter v2); GIT-NET `37be829` … `b838569` (birleştirme `dda792e`; `protocol.allow=never` +
  `GIT_ALLOW_PROTOCOL=''` + lazy fetch yok). Kanıtlar `proof/<KART>-2026-09-29/`. Belge deltası bu commit'te.

## Dokuzuncu parti (`integrate/2026-09-29-j`, worktree `/home/alperen/deckent-next-integrate-j`, taban `61a5eac`)
- Birleşenler (her biri `--no-ff`): ZOD4-PREP `ab3be14` (zod 3 oracle'ları: config varsayılan/hata şekli golden'ı, MCP `tools/list` inputSchema
  fixture'ı, sınır davranışları; çalışma zamanı değişmedi); MCP-SANDBOX-PATHS `07f9717` + lead takibi `0b24ead` (tipli teşhis
  `MCP_SANDBOX_COMMAND_UNREACHABLE`; turda/`/mcp`'de sessiz başarısızlık yok; `integrations/mcp-start-failures.json`); DEPS-DIST `5b58fa7`
  (`pack:dist` bağımlılıksız tarball + CycloneDX SBOM + `smoke:dist`). Kanıtlar `proof/<KART>-2026-09-29/`.
- Entegrasyon düzeltmesi (`ed8cffd`): MCP-SANDBOX-PATHS i18n deltası (`add` + `followUp`, 13 anahtar en/tr) uygulandı. Ret mesajı teşhis türüne göre
  üç katalog cümlesinden biri (rol etiketi yerelleştirilmiş); adaptör artık metin yazmıyor (`McpStartNotice`), tek render sahibi composition
  (`renderMcpStartNotice`): tur notu servisin locale'inde, `lastStart.text` (`/mcp`, `mcp list|get`) çağıran yüzeyin locale'inde. Testler: en/tr saf
  render, gerçek bwrap tur testi (en servis + tr servis notu, `/mcp` tr/en), kayıt testi reddi en/tr. İki mutasyon (servis locale'i yok sayılır; yüzey
  locale'i geçirilmez) testleri kırdı, geri alındı. Belge deltası (ARCHITECTURE/PLAN/CHANGELOG/current-flow) ayrı commit'te.

## Onuncu parti (`integrate/2026-09-29-k`, worktree `/home/alperen/deckent-next-integrate-k`, taban `9a3ef2c`)
- Birleşenler (her biri `--no-ff`): FASTURI-OUT `178ab19d` (yayın paketinde MCP SDK'nın gömülü ajv/fast-uri'si yok; stub + build kapısı; MCP server
  cf-worker doğrulayıcısıyla), DEPS-TYPES `c8f86a23` (SDK girişi açık liste + envanter testi, 6 canlı zod değeri çıktı — BREAKING; d.ts kapanışı +
  vendored tipler, TS 5.9/6.0/7.0 × NodeNext/Bundler 0 hata), SECRET-K1 `6892a9c0` (`SecretStore` portu, env/file arka uçları, tek üretim çözücüsü,
  `doctor`, `secret list`; arch kenarları `c58ba8a9`), SHELL-OVERLAY `ee854a85` (full-auto kabuk yazım kümesi, bwrap ≥ 0.11; üretimde uykuda).
  Kanıtlar `proof/<KART>-2026-09-29/`.
- Entegrasyon düzeltmeleri:
  - `508fe854` composition bütçesi: 5510 > 5500 → bütçe yükseltilmeden saf host-shell sorumlulukları (`shellWritePosture` + `ShellCallAuthority`,
    `sandboxWriteSetRoot`, `agentShellEffectCommandId`, kabuk sonuç notları + etki reddi metni) `adapters/core/host-shell`'e bayt bayt taşındı →
    5432 satır (68 pay); host-shell birimine `engine/core/shell-classification`, `platform/core/host`, `platform/core/managed-files` kenarları eklendi.
  - `8cb7cbcd` SECRET-K1 i18n deltası: 8 hata metni en/tr (render'lar `error.unknown` yerine kendi anahtarı), `config.field.secrets` metadata,
    `doctor.secretStore` insan satırı, `secret list` yardım satırı (fixture güncellendi). **Sapma:** önerilen metinlerdeki "secret <kelime>" hata
    redaktörüne takılıyordu — derlenmiş CLI'da "The secret [REDACTED] …" (en/tr); metinler "secret-store" / "secret'lar deposu" biçimine çevrildi,
    16 metnin hiçbiri redaktöre takılmıyor; redaktör değişmedi. Diğer üç şeridin i18n deltası yok (SHELL-OVERLAY metinleri modele giden İngilizce).
- Doğrulama (tam verify değil): typecheck 0; eslint değişenlerde 0 hata (önceden var olan 2 uzunluk uyarısı); lint-arch 0 ihlal; `npm run build` ✓;
  hedefli vitest: i18n/yardım/secret/MCP/kabuk/dist 24 dosya 208 geçti + 3 atlandı (yerel `.pack/bwrap` yokken) → `.pack/bwrap/x86_64/bwrap`
  (lock sha `f5112648…` eşleşti, shell-overlay şeridinden kopya) ile overlay testleri 3 dosya 21/21; `runtime-chat-turn` + landlock 76/76;
  izin modu/ürün durumu/scratch 22/22; metin değişikliği sonrası i18n + secret 10 dosya 80/80. Derlenmiş CLI (geçici HOME): env `secret list`
  → `SECRET_STORE_UNSUPPORTED` temiz metin en/tr; file arka ucu 0644 → `doctor` "Secret store: core.secret-store.file@1 (unsafe,
  SECRET_STORE_UNSAFE)" ve `secret list` tipli ret en/tr; 0600 → ad listesi ve "(ready)".
  - Gerçek ikili e2e `kernel-config` SECRET-K1 birleşmesinden beri kırmızıydı (`doctor --json` anahtar listesinde `secretStore` yok) →
    beklenti güncellendi (anahtar, varsayılan env deposu raporu, tr insan satırı); e2e 4 dosya + SDK envanteri 22/22.

## On birinci parti (`integrate/2026-09-29-l`, worktree `/home/alperen/deckent-next-integrate-l`, taban `0a69a70` = onuncu parti adayı)
- Birleşenler (`--no-ff`): MCP-SCHEMA-VALIDATOR `5330cb7e` (kendi JSON Schema doğrulayıcımız cf-worker'ın yerine; arch.json kenarı), BWRAP-SELECT `e194b344`
  (launcher seçimi, gömülü bwrap 0.13, `ShellCapabilities` v2, paketleme, CI iş tanımı). Ayrıntı ve açık owner maddeleri PLAN "On birinci parti".
- Entegrasyon: Astra 2177 kopya testi kendi doğrulayıcıya uyarlandı; SHELL-OVERLAY yazım kümesi `launcher.overlay` ile **üretimde etkin** (Astra 2170 duruş
  testlerinin bwrap full-auto kolu yazım kümesi sonucuna güncellendi); test altyapısı `77d0d2f9` (build gömülü bwrap'ı aşamalar, gerçek-sandbox guard testi,
  vitest geçici `DECKENT_GLOBAL_HOME`); Astra 2180 R2 testi `e1380841` (0a69a70'te kırmızı, burada yeşil; uyarlama notu proof'ta); belge commit'i.
- Doğrulama (tam verify değil, lead koşacak): typecheck 0; eslint değişenlerde 0 hata (önceden var 3 uzunluk uyarısı); lint-arch 0 ihlal 0 uyarı; `npm run build` ✓
  (`bubblewrap=staged from .pack/bwrap/s6-check`, dist kopyası sha `917f8e7f…` = kilit); hedefli vitest (VITEST_MAX_FORKS=2, FORCE_COLOR yok, Docker imajı
  değişkeni) 59 dosya **775/775, 0 atlanan**, `~/.deckent` değişmedi; overlay kanıtı: `runtime-shell-overlay.test.ts` üretim sandbox listesi ve servisin
  kendi ölçümüyle (`write set: applied 6`), `shell-overlay-write-set.test.ts` seçilen launcher ile + overlay'siz ölçülen launcher'ın yazım kümesi isteğini
  reddettiği negatif durum; guard negatif kanıtı: aşamasız 1 başarısız ("/usr/bin/bwrap 0.9.0 < 0.12.0"). build-dist `--bwrap` → `bubblewrap.shipped: true`,
  tarball'da `linux-x64/bwrap` 0755 + NOTICE/lisans/kaynak, cf-worker/ajv kodu yok (yalnız vendored d.ts yorumları); paketlenmiş dist'ten seçim: `bundled`,
  `overlay: true`, kopya 0500; pack-smoke Node 24.21 ✓ ve 26.10 ✓. `deps-watch` (güncellenmiş kayıtla) çıkış 0, HIGH 0, MITIGATED 16.
- Bilinen sınırlar: AppArmor `restricted` yolu gerçek Ubuntu'da ölçülmedi; CI `bwrap-bundle.yml` koşmadı; ana `ci.yml` bwrap aşamalamıyor (guard kısıtsız
  koşucuda düşer); seçilen launcher denemesi düşerse sıradaki adaya geçilmez; MCP sunucu görünümü hâlâ salt okunur (overlay MCP yolu sonraki dilim);
  `format` artık yalnız açıklama; `.pack/bundled-aside` (gitignore) test artığı, owner silebilir.

## On ikinci parti (`integrate/2026-09-29-m`, worktree `/home/alperen/deckent-next-integrate-m`, taban `6bb6f5f` = onuncu + on birinci parti adayı)
- Birleşenler (`--no-ff`): DEPS-P0 `c871a4a6` (LICENSE Apache-2.0, Node `>=24.15.0`, 10 yerde SQLite tabanı, react 19.2.8, CI Node [24, 26]; kilit dosyası
  yeniden üretildi = aynı, `npm ci`), SECRET-WRITE `dd323c0b` (`secret set|delete` servis üzerinden, `secret` policy hücresi, şablon v2; protokol v18).
  Entegrasyon: `f9650fd1` composition 5501 → 5455 (bütçe yükseltilmedi; `@file` indeks önbelleği → workspace-read, dosya etki kimliği → workspace-write;
  arch kenarları), `f73b3f25` i18n en/tr + katalog redaktör testi, belge commit'i. Ayrıntı ve açık maddeler PLAN "On ikinci parti".
- Doğrulama (tam verify değil): typecheck 0; `eslint .` 0 hata (5 uzunluk uyarısı, önceden var + şeritten `service-protocol.test.ts`); lint-arch 0 ihlal;
  lint-core-memory 0; `npm run build` ✓ (`bubblewrap=staged from .pack/bwrap/s6-check`); hedefli vitest (sqlite/ledger, secret, servis protokolü, terminal PTY,
  i18n, dist, MCP, shell overlay; VITEST_MAX_FORKS=2, FORCE_COLOR yok, Docker imajı değişkeni) **151 dosya 972/972, 0 atlanan**; `~/.deckent` değişmedi;
  derlenmiş dist'ten üç yeni metin en/tr redaktörde değişmiyor; build-dist `--bwrap` + pack-smoke Node 24.15.0 (SQLite tam 3.51.3, taban kabul), 24.21.0 ve
  26.10.0 ✓. Kanıt `proof/INTEGRATE-M-2026-09-29/`.
- v18 (lead kararı: v17 push edildi → sürüm artışı): secret işlemleri yalnız v18'de, pencere [18,17] yaşam döngüsüyle sınırlı; commit aşağıda.
- Bilinen sınırlar: mevcut kurulumlarda secret grant'ı elle (§5; canlıda eklendi); v16 servisi canlı geçişte eski CLI ile durduruldu; Node 26 PTY
  kanıtı yalnız şeritte; eski SQLite'lı gerçek Node ile ret yalnız birim testinde (enjekte sürüm); `ci.yml` lead incelemesi bekliyor.

## On üçüncü parti (`integrate/2026-09-29-n`, worktree `/home/alperen/deckent-next-integrate-n`, taban main `0360bab9`)
- Birleşenler (`--no-ff`): REALM-NOTICE `5bd4a3dd`; LANG-CRASH `19d7caee` (`044f7b90` MCP managed-file tipli hata + `dfce9015` sistem istemi v5 yanıt dili,
  özet o dilde); OPEN-SANDBOX `bf21ec73` (`e376f546` + `46148e4f` + `cef933a7`: full-access açık bubblewrap görünümü, yapısal sert taban, owner Y).
  Şerit teslimleri bağımsız inceleme bekliyor.
- Entegrasyon: composition 5506 → 5423 (bütçe 5500 yükseltilmedi): ajan çalışma alanı/ürün durumu duruş türetimi bayt-özdeş
  `adapters/core/agent-workspace-floor`'a taşındı (arch kenarları); belge commit'i (OPEN-SANDBOX + LANG-CRASH deltaları, oturum 1d428e9f analizi PLAN'da).
- Doğrulama (tam verify değil): typecheck 0; değişen dosyalarda eslint 0 hata (1 önceden var uzunluk uyarısı, `runPeerConfiguredChatTurn`); lint-arch 0 ihlal;
  `npm run build` ✓; hedefli vitest (taşınan kod, open-sandbox, full-access, dil/MCP; VITEST_MAX_FORKS=2, FORCE_COLOR yok, Docker imajı değişkeni)
  19 dosya 163/163, 0 atlanan; `~/.deckent` ve `~/.local/state/deckent-next-dev` test sırasında değişmedi.
- Lead kararı (dil, 2026-09-30): B — canlı config `language: tr` bir sonraki canlı yeniden başlatmada; A — protokol v19 `chatTurn.language` bir sonraki
  protokol paketinde; yanıt dili son-kontrolü ayrı kart. Açık bulgu: `mcp add`/`remove` kayıt dosyasını denetimden önce yazıyor.

## Sıradaki
1. On yedinci parti (`integrate/2026-09-30-r`, yukarıda): tam verify → Sol REQUEST_REVIEW → PASS'te push → canlı geçiş; ardından DEV-U2-0 ilk geçişi. Sonra WORKER-CURRENCY-2
   artıkları (`models --help` satırı, terminal `/models`, sohbet yolunun ledger kataloğuna taşınması), K3 → K5/K6 → U2.
2. REALM-NOTICE açığı: MCP ön-başlatma launch kartı gerçek realm'i önceden adlandırmıyor — (a) `usable()` ön-seçimi / (b) olduğu gibi; lead/owner.
3. Owner kararları: SHELL-OVERLAY O1/O3/O5/O6/O7; `format` denetleyicisi, şema korpusu ölçümü, AppArmor kurulum belgesi, CI `bwrap-bundle.yml` ilk koşu;
   DEPS-SCHEMA C1 kanıtı; sabah listesi `proof/MORNING-REPORT-2026-09-29.md` (P1 tasarımları: OTel / uzak MCP, anahtar zinciri K2; zod 4 hata kodları;
   MCP sandbox seçenekleri B/C/D/E + tur başı `notice` olayı; DEPS-DIST yayın engelleri ve DEPS-DIST-B1; ANTHROPIC ilk faturalı duman çağrısı ve legacy
   tarifeler; fast-uri kabul edilmiş riski 2026-10-29); canlı secret deposunun env → dosya geçişi.
4. **Node 26 geçişi (owner, gözden kaçmasın):** Node 26 LTS 2026-10-28'de çıkınca kurulur → tam verify → nvm varsayılanı, CI zorunlu geçidi ve
   canlı servis Node 26; o güne kadar canlı Node 24.21 (PLAN "On ikinci parti").

## Açık kalanlar
- Oturum 1d428e9f açık P1'leri (PLAN "Owner terminal oturumu 1d428e9f"): `/policy` + `/permissions` (POLICY-ADMIN P5); ajan yönetim araçları (yetki isteği
  kartı, MCP durumu); terminal Agent OS komutları (O1) + UI/UX tasarımı; OPEN-SANDBOX-HIDDEN-PATHS takip kartı; MCP kayıt-önce-denetim sırası.
- Owner tasarım onayları (2026-09-29): soru kartları A, terminalden Agent OS O1, DECKENT.md Öneri 1 — uygulama dilimleri bu partiden sonra (owner: yeni iş yok).
- SHELL-AUTONOMY açık owner soruları: C1 program tabanı sandbox'ta, C2 audit event v2 (realm/hücre); `run_shell` model açıklaması sürümü
  (C3 → full-access, C4 → yazım duruşları ile kapandı).
- LEDGER-SINGLETON: model sahip kimliğindeki `custodyId`'yi ledger custody'sinden türetmek; ret kodunda uç nokta/ledger ayrımı.
- Dogfood hattı: canlı execution/adoption profili ve doğrulama config'i; Deckent verify'ının sandbox'ta ölçümü; tek komut döngü; operatör aktivasyonu.
- Temizlik komut listesi (owner çalıştırır): `proof/INTEGRATE-2026-09-27/cleanup-commands.md` + biten şeritler, stash'ler.
