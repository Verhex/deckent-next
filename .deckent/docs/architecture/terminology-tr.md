# Türkçe terim sözlüğü (terminal ve izleyici)

Kullanıcıya görünen Türkçe metinlerde bu terimler kullanılır; i18n kataloğunda (`tr/*.json`) başka karşılık yazılmaz.
Komut adları, bayraklar, kimlik alanı adları (`runId`, `/run`, `/workers`) ve kod belirteçleri çevrilmez.

| Kavram (İngilizce) | Türkçe | Not |
|---|---|---|
| Run | iş | "Koşu" kullanılmaz. Çoğul: işler. Başlık/sekme: "İşler". |
| Task | görev | Bir işin parçası. |
| worker | işçi | "worker" ham biçimde yazılmaz. Çoğul: işçiler; "işçi 2". |
| attempt | deneme | |
| approval | onay | |
| scope | kapsam | Katalog metinlerinde "scope" yazılmaz. |
| permission mode | izin modu | Değerler (`standart`, `full-auto`) komut girdisidir, çevrilmez. |
| transcript | döküm | |
| installation | kurulum | |
| project / company | proje / şirket | |

Durum sözlüğü (iş ve görev evreleri): pending = bekliyor, active = çalışıyor, evaluating = değerlendiriliyor,
accepted = kabul edildi, failed = başarısız, cancelled = iptal edildi, reconciling = uzlaştırılıyor,
skipped = atlandı, awaiting-decision = karar bekliyor.

Bildirim önekleri (renkten bağımsız): Bilgi, Uyarı, Hata.
