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

## Durum (2026-10-02 akşam, ana oturum Opus 5.5 lead)
Bu bölüm güncel durumdur; önceki parti anlatıları Git geçmişinde (bu dosyanın `aa58f559` sürümü) ve `deckent-refactor-work/proof/` altında.

- **Main / canlı:** `origin/main` = canlı = `aa58f559` (25. parti: B1 APPROVAL-ASSURANCE, PACKAGED-WORKER-BOOTSTRAP, MCP-NO-DECIDE, dogfood D3 portu,
  belge dilimi, B25-R1/R2/N1). Sol 2246 sınırlı PASS; yazar tam verify exact `aa58f559` 541/3908 EXIT0. Canlı sürüm `aa58f55972ed-04f7af80815e`
  (owner RC talimatıyla lead geçirdi; ledger 44). Yerel main `dcaf7683` = bu + owner yetkili skill düzenlemesi `5b019720` (push edilmedi; 26. partiyle gider).
  Kanıt `proof/LIVE-SWITCH-BATCH25-2026-10-02/README.md`. Hosted CI `aa58f559` okunmadı.
- **Dogfood:** resmî OFF. N1 servisi ve K7 köprüsü canlı paketli build'de (`current`); paketli native worker açılışı gözlendi (`probe-packaged-aa58`:
  sonnet-5-5, exit 0, model verified/sealed). N1 havuzu 8 slot, kart profilleri 2 GB, verify 3 GB (yedekli config). S1 kapısı: B1 ✓; A1/A3 şeritte;
  canlı `execution`/`admission` + grant'lar yok; dilim 3, SELF-SOURCE-FLOOR açık (PLAN DOGFOOD-STAGES).
- **26. parti tam verify:** ilk koşu `63abbd04` 28 fail (21 dosya) → entegrasyon düzeltmeleri `c007f933` (config CLI lazy yükleme: Ink/React her CLI/MCP açılışından çıktı), `3525c20a` (A1/A3 yardım 80 sütun + redactor'a takılan hata metni), `9bb43c52` (kabul edilmiş sözleşmelere fixture/golden uyumu) → `9bb43c52` 558 modül/4058 test EXIT0 (`proof/INTEGRATE-2026-10-02-AA-FIX/README.md`). Lead çakışma çözümünde hata bulunmadı. Not: ana checkout'taki bwrap paketi eski kilitte; yeni worktree'lerde verify öncesi bwrap staging gerekir.
- **26. parti** `integrate/2026-10-02-aa` (worktree `/home/alperen/deckent-next-integrate-aa`, taban `dcaf7683`): CATALOG-V3 `b50b8a6e` (Sol 2247 sınırlı PASS),
  PLAN kartları `662812fc`, bu belge dilimi. Tam verify/Sol parti incelemesi şeritler girince.
- **27. parti adayı** `integrate/2026-10-02-ab` (worktree `/home/alperen/deckent-next-integrate-ab`, taban 26. parti adayı `848c8050`, Sol 2251 incelemesinde):
  CLI-HELP `46bc5c77` (Fable PASS) + AOF-DECISION-PORT `2b8bdc31` (Fable PASS). Entegrasyon: A1/A3 `run close|resume`/`task accept|reject` ve `decide`
  komut kataloğuna kayıtlı (yardım 108 yol, üst yardım 27 satır, golden'lar okundu); karar ledger'ı **v45→v46** numaralandı (A1/A3 v45 aynen),
  v44→v45→v46 / v45→v46 yedekli ileri göç testli, batch-26 kodu v46 ledger'ı reddediyor (bayt değişmeden); composition bütçesi korunarak
  query-errors importları birleştirildi; decision config alanına binding/apply eklendi. İlk tam verify `2cb7335c` 42 fail → düzeltme `78231da9`
  (v46 göçü IF NOT EXISTS + birebir CREATE metni denetimi; yayımlanan decision `.d.ts` JSON asset'e bağımlıydı — ürün hatası, giderildi);
  **tam verify exact `78231da9` 568/4151 EXIT 0**. Kanıt: `proof/INTEGRATE-2026-10-02-AB/README.md`. Sıradaki: Sol parti incelemesi (26. partiden sonra).
- **Şeritler (Codex uygulayıcı, lead commit, bağımsız inceleme Fable/Sol):**
  - A1/A3 `lane/run-park-timeout`: `ca753477` + `6d06bb41` + `6a8c3298` + `18d39682` (iki Fable REVISE düzeltmesi); Fable üçüncü inceleme **PASS** exact `18d39682`;
    lead native/dist 7 dosya 82/82; 26. partiye birleştirildi. Lead kararı A3 dönüşü: Jev a8e582fe `typed_return_on_new_evidence`.
  - CONFIG-SURFACE `lane/config-surface` `19a6bb42` → Fable REVISE düzeltmesi `c86d9d33` → i18n `5cbce321`; Fable **PASS** exact `5cbce321`; 26. partiye birleştirildi.
  - CLI-HELP `46bc5c77` ve AOF-DECISION-PORT `2b8bdc31`: Fable PASS, 27. parti adayına birleştirildi. HARDCODE-RATCHET `lane/hardcode-ratchet` (taban `19a6bb42`): Codex'te.
- **Analizler (salt okunur):** HARDCODE-AUDIT (~173 ihlal grubu, P1 19; `proof/HARDCODE-AUDIT-2026-10-02/`), AGENT-OS-FOUNDATIONS
  (`proof/AGENT-OS-FOUNDATIONS-2026-10-02/analysis.md`). Owner sırası Jev e2b81339 (ARCHITECTURE karar günlüğü 2026-10-02).
- **Analiz oturumu (deckent-next-c7, dalga 6):** 1.768/1.768 satır sonuçlandı; MONITOR girdileri `next-graph/deep-harvest/wave6/MONITOR-INPUT.md`
  (A-01 geçişli waiting, A-02/A-03 push yok, A-07 doctor sabit ready); kalan F4/QUESTIONS/Jev/rapor owner kararıyla gece.

## Sıradaki
1. 26. parti (CATALOG-V3 + CONFIG-SURFACE + A1/A3) tam verify → Sol parti incelemesi → push → owner/RC talimatıyla canlı geçiş; ardından AOF-HANDOFF.
2. CONFIG-SURFACE 26. partide; sıradaki HARDCODE-P1 kartı; owner vLLM/Qwen adımları (`proof/CONFIG-SURFACE-2026-10-02/owner-vllm-steps.md`).
3. 27. parti (CLI-HELP + AOF-DECISION-PORT) tam verify sonucu → Sol parti incelemesi (26. partiden sonra); HARDCODE-RATCHET teslimi → bağımsız inceleme; A1/A3 girince AOF-HANDOFF, sonra AOF-WORKER-DECIDE.
4. 26. parti tam verify → Sol → push → owner/RC talimatıyla canlı geçiş.
5. Owner canlı adımları: katalog seed kaydı/aktivasyonu (`proof/MODEL-CATALOG-2026-10-02/owner-commands.sh`), CONFIG-SURFACE sonrası vLLM yeniden adlandırma.
6. **Node 26 geçişi (owner, gözden kaçmasın):** Node 26 LTS 2026-10-28 → tam verify → nvm varsayılanı, CI zorunlu geçidi ve canlı servis Node 26.

## Açık kalanlar
- S1 kapıları (PLAN DOGFOOD-STAGES): canlı execution/admission + grant'lar, dilim 3, SELF-SOURCE-FLOOR, EXEC-RELEASE C1–C3, B05/B07 incelemesi.
- MONITOR dalga 6 girdileri (A-01…A-16) kart sırasına alınacak; LONG-LIVED-AGENTS kartı (20 dk sınırı şimdilik kalır).
- Hosted CI `aa58f559`; Windows/macOS native kök nedenleri (CI-PLATFORM).
- Owner terminal oturumu 1d428e9f açık P1'leri ve SHELL-AUTONOMY/SHELL-OVERLAY owner soruları (PLAN'daki satırlar geçerli).
