# Anlık iş akışı — geçici

İş: WORKER-OBSERVATION + Next yürütme host geçişi. Durum: kapsam doğrulandı; owner commit/push için onay verdi. Aşağıdaki tekil test bulgusu açık.
Owner: deckent-next tek yürütme/operatör çalışma alanı; deckent-dev yalnız okunabilir referans.
DOGFOOD_MODE=OFF. Owner 2026-09-21: doğrulanan mevcut dilimi tamamen commit/push et, sonra devam et.
Yayın sonucu Git kaydı ve dış proof içindeki publication.json üzerinden doğrulanır.

## Çalışan yerel yüzey

`deckent` ve `deckent-mcp` PATH girişleri Next `.agents/refactor/next-entry.mjs` üzerinden
çalışır. Global npm Deckent bağlantısı ve Claude kayıtlı Deckent MCP girişi de Next'e taşındı.
Launcher CLI/MCP/SDK için Next cwd ve `.deckent/host/global` global ayar alanını sabitler.
Ortak `DECKENT_GLOBAL_HOME`, proje `layout.root`/`DECKENT_HOME` alanından bağımsızdır.
Launcher devralınan DECKENT_HOME'u kaldırır; host HOME ve kimlik bilgileri taşınmaz.
Eski iki MCP süreci exact PID/start-time/entry denetimiyle SIGTERM aldı ve kapandı;
worker süreçlerine sinyal verilmedi. Açık istemciler yeniden bağlanmalıdır.
Eski Git geçmişi, referans skill yolları ve uygulama oturum geçmişi yürütme olarak taşınmadı.

Kullanım: `deckent workers list --scope pilot --json` veya
`deckent workers watch --scope pilot`; Ctrl+C yalnız görünümü durdurur.
SDK scripti: `node .agents/refactor/next-entry.mjs node /absolute/script.mjs`.
Merkez config `.deckent/config.json`; gözlem ledger/policy `.deckent/observability`.
Merkez yalnız pilot scope inspect yetkili; yeni iş admission/çalıştırma kurulumu yok.

## Worker yeri ve izleme

Worker Docker'da doğar; /workspace yalnız attempt'e özel bağımsız Git checkout'u mount eder.
Host yolu `<layout.root>/workspaces/<attempt-hash>/tree`; HOME/socket worker'a açılmaz.
worker.hb/.log/.result aynı attempt'in host parent dizininde, mount dışında tutulur.
Heartbeat ve sonuç mevcut dispatch/daemon gözleminin projeksiyonudur, yeni durum sahibi değil.
Host log yalnız güvenli yapılandırılmış durum/terminal olayları; ham native çıktı taşınmaz.

SDK inspectConfiguredWorkers ve CLI workers list/watch aynı uygulama servisini kullanır.
inspection.workers.sources: açık id/kind/path/scopeId, next-project veya legacy-tasks.
Merkez scope inspect; her Next kaynak kendi policy'si; ayrıntıda attempt read-output gerekir.
Sınırlı dosya/worker/byte ve sayfalama; geniş HOME/tmp keşfi yok.
Ledger terminal, Docker process, heartbeat freshness ve dosya durumu ayrı eksenlerdir.
Legacy PID yalnız doğrulanmamış gözlem; .result iddiası görev kabulü değildir.
Ham log yerine hata/auth/rate-limit/timeout kategorileri ve güvenli olay alanları döner.
Worker izleme için Desktop/MCP/uzak/Windows yüzeyi bu dilimde eklenmedi.

Yerel kaynaklar: Next içindeki `.deckent/worker-observation/project`, üç native sağlayıcının
geçici proof projeleri, `/tmp/deckent/-home-alperen-deckent-dev` ve
`/home/alperen/.local/state/deckent/runtime`. Son iki exact dizinde task sidecar bulunmadı;
boş kaynak görünür, alt dizinler otomatik taranmaz. Legacy'de yeni yürütme yapılmadı.

## Kanıt

Önceki NATIVE-PATCH-PREVIEW: full verify1498 ürün/258dosya, native24, host29, atlanan0.
Üç gerçek sağlayıcı küçük dosya değişikliği → immutable patch → release sonrası preview geçti.
Proof: /home/alperen/deckent-refactor-work/proof/NATIVE-PATCH-PREVIEW/verification.json

WORKER-OBSERVATION ilk tam paket: 1502 ürün/260dosya, native24, host29, atlanan0 geçti.
Gerçek Docker/derlenmiş CLI: canlı/terminal worker, kapsam reddi, watch SIGINT ardından
worker'ın devamı. Next içindeki gerçek pilot note.txt değişti, kaynak değişmedi, container bırakıldı.
Merkez CLI list/watch bütün seçili kaynakları okudu; Next MCP PATH ve Claude girişleri bağlandı.
Son tam verify: 1504 ürün/261 dosya, native24, host30; atlanan0, lint/build/smoke geçti;
26 core-memory dosyası canonical ile aynı. Komut VITEST_MAX_FORKS=2,
DECKENT_TEST_DOCKER_IMAGE ve DECKENT_CORE_MEMORY_CANONICAL ile çalıştı.
SDK Next launcher üzerinden üç sağlayıcının release edilmiş patch kaydını aynı receipt ile açtı.

Önceki başarısız koşular saklandı: README ölçüm sırasında düzenlendiği için paket değişikliği
koruması tetiklendi; sabit dosyalı koşulda bu test geçti. Ayrı bir koşulda native harcama
fixture'ı iki POST yerine bir gördü. Kök neden doğrulanmadı. İki çağrıya responded assertion
eklendi; dar dosya 5 ayrı koşuda ve son tam pakette geçti. Retry veya beklenti gevşetme yok.
Bu tekil HTTP bulgusu kapatılmadı; tekrarında doğrudan invocation outcome ile tanı koyulacak.

Jev e344e6de-7dc6-4ece-a25c-734f07be8349: scoped_observer1.0, none0, insufficient0.
Jev 02d8c3d9-52ba-4bd8-87e1-ef49d97fe91c: separate_global.99, none0, insufficient.01.
Jev d9ee2cca-f379-400d-a65b-f02416406fec: retain_finding.98, none0, insufficient.02.
Üç danışmada da abstention seçilmedi. Tavsiye test/owner onayı değildir. Fable kapalı.
Proof: /home/alperen/deckent-refactor-work/proof/WORKER-OBSERVATION/

Sonraki iş: tekil HTTP bulgusunu takipte tutmak; çalışan gözlem/patch temelinden kaynak
HEAD/WIP değişikliklerini koruyan kontrollü patch uygulama ve çakışma gösterimini tasarlamak. Otomatik apply, görev kabulü ve DOGFOOD henüz yok.
