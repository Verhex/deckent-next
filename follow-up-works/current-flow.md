# Anlık iş akışı — devir, sıradaki adım, kanıt (2026-09-26 akşam, Opus 5.5)

Bu belge yalnız güncel durumu tutar; geçmiş bölümler `deckent-refactor-work/archive/current-flow-2026-09-26-before-reset.md`,
durum raporu `deckent-refactor-work/STATUS-REFAKTOR-DURUM-2026-09-26.md` ve `proof/` dizinlerinde.

## Durum
- origin/main `5fa0812` (owner izniyle push, 2026-09-26; tam verify `f7a9631`'de exit 0: 332 dosya / 2.169 test, native 25, host 55, smoke).
- Yerelde push sonrası: `6786bc2` owner kararları (belge), `2900a8d` Astra 2106 düzeltmesi, `b92d906` cli bölünmesi (W0-7), belge paketi.
- Canlı servis v13'te (eski build). Canlı yeniden başlatma + `grant-edit-shell.mjs` owner kararıyla **Astra PASS sonrası**.
- DOGFOOD OFF.

## Owner kararları 2026-09-26 (PLAN "Önemli açık bulgular" başında)
- Ajan yazımı yalıtımı (2094 R2): belgelenmiş son kontrol–rename yarışı kabul; native/Landlock yazıcı yok.
- Uzun istek (2106 R2): serviste pay (yanıt × 4 bayt + girdi payı), istemci ön denetimi, tipli ret; protokol değişmez.
- Dilim 4 izin modu: policy katmanında (kişi başına overlay, şirket policy'si 'mod-uygun' işaretlemedikçe etkisiz) — Cursor devri.
- Canlı etkinleştirme: Astra PASS sonrası.

## Astra inceleme sırası (hiçbiri tüketilmedi; son Astra yanıtı 2106, 18:11Z)
`2100` 2094 dosya yazımı · `2101` 3a sınıflandırıcı · `2102` 3b yürütme · `2103` 3c-i `run_shell` · `2104` 3c-ii canlı çıktı ·
`2105` 3c-iii temizleme · `2107` 2106 düzeltmesi. Kanal 2011 (Fable'a) dokunulmaz.

## Sıradaki adımlar (Fable durum analizi sırası, owner 2026-09-26)
1. Belge paketinin kalanı: README yüzey iddiaları (HTTP API yok, Docker var, terminal), ARCHITECTURE "Package contract" eski paket adları,
   core-memory `MEMORY.md:6` sayısı — ayrı küçük belge dilimi.
2. Astra PASS'leri (2100–2107) → REVISE gelirse önce düzeltme → owner push izni → yalnız incelenen sha.
3. Canlı: build + governed yeniden başlatma (ledger v37→v38 yedekli) + `! node /home/alperen/deckent-refactor-work/proof/F26-T-L4-LIVE-GRANTS-2026-09-26/grant-edit-shell.mjs`;
   owner senaryosu (hata bul → diff onayı → testi kabukta koştur → sonucu oku).
4. Cursor devir prompt'u: dilim 4 (policy katmanında izin modları) + T-L5 kalanı (`@dosya`, `/compact`, proje belgeleri bağlamda); yapma listesi.
5. Opus ana hatta: M1 Hat B (C12 genel, A04, H34, IFS tasarımı, FOUNDATION registry) — owner ile ayrı checkpoint.

## Açık sınırlar (bu oturumda kaydedilen, ARCHITECTURE'da)
- Ajan yazımı: son kontrol–rename arası aynı kullanıcı yarışı (kabul edildi); başka yazar version kontrolü–rename arası.
- Kabuk: sandbox değil; dolaşma/git nesne okumaları `low` → sorar; servis çökerse çalışan komut sahipsiz kalır; PowerShell yok (Windows her komutta sorar).
- T-L5: `compacted` olayı tek çerçeveye sığmazsa tur iptal; eşiğin üstünde kalan kuyruk her turda yeniden özetlenir.
- Temizleyici: işçi transkripti ve hata bildirimleri kapsam dışı.

## Kanıt dizinleri (`deckent-refactor-work/proof/`)
`F26-T-L4A-FIX-2092` (mutasyon 1–7, verify-a4604fc) · `F26-T-L5-FIX-2091` · `F26-T-L5-FIX-2106` · `F26-T-L4B-FIX-2094` ·
`F26-T-L4C-SHELL-3A` · `F26-T-L4C-SHELL-3B` · `F26-T-L4C-SHELL-3C` (+ verify-f7a9631) · `F26-T-L4C-SHELL-3C-II` · `F26-T-L4C-SHELL-3C-III` ·
`F26-T-L4-LIVE-GRANTS-2026-09-26` (owner betiği).

## Jev kayıtları
Bu oturum: 46cfa6c6 (2092), 4a702440 (2091), 3d6703e5 (2094), d6909e28 (3a), 52f9b6f9 (3b), 82858581 (3c-i) — karar + sonuç yazıldı.
Fable analizi (q1–q10 + bileşik c331f6af): sonuçlar aşağıdaki belge dilimiyle birlikte yazıldı.
