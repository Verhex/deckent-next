# Yetki sınırı ve karar disiplini

Değişiklik öncesi ilgili Next mimarisi (`ARCHITECTURE.md`) ve legacy ADR kanıtı okunur. Kabul edilmiş kararlar sessizce ihlal edilmez; yeni çelişkide neden, seçenek ve etkileriyle amendment sunulur. Canlı owner talimatı üstündür.

- Onay approved-DAG sınırındadır: yeni scope, authority, destructive veya dış etki owner checkpoint ister. Mevcut izin tekrar sorulmaz; onaysız atlama yasaktır (amend. 2026-08-17).
- Yalnız owner-admitted outcome `PLAN.md` kapsamında ilerler. Bulgu otomatik iş veya kapsam genişletmesi değildir (amend. 2026-08-17): mevcut işi engelleyen bulgu çözülür, diğeri etkisiyle raporlanır. Legacy MASTER Next işi başlatmaz.
- Otonomi ürün hedefidir; hostta izinsiz sprint, worker veya subagent başlatma yetkisi değildir. Gözlem config veya yetki sınırını otomatik genişletmez.
- Yetki devri açık olmalıdır: fallback hedefi güncel config, erişim ve kanıttan seçilir; sessiz model veya sahip ikamesi yoktur. Doküman okumak ya da summary almak yürütme yetkisi devretmez. Gerçek devrin sahibi, sürümü, kanıtı ve kalan etkileri açıktır; mevcut policy ve owner sınırı korunur.
- Legacy runtime/recall komutu çalıştırılmaz; kaynaklar salt okunur incelenir. Legacy package A/B, makine isimleri ve eski branch kuralları Next yetkisi değildir.

Legacy ders: PREPARED → VERIFIED → COMMITTED devir zinciri ve owner recovery ayrımı tasarım dersidir; Next'te varmış gibi ilan edilmez.
