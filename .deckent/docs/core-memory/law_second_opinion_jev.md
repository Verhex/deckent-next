# İkinci görüş, Jev ve inceleme kanalı

Ciddi kök-neden veya tasarım belirsizliğinde ikinci görüş alınır. İkinci görüş karar, yetki veya kabul devri değildir; HOLD/UNCLEAR kapanış değildir.

- Belirsiz geliştirme kararında logged Jev hazırlaması kullanılır (`.agents/refactor/jev-review.mjs`): ortak north star, süreç, kanıt ve iki ayrı çekimser seçenek (none_of_the_above, insufficient_information) zorunludur; olasılıklar ayrı raporlanır. Jev olasılıksal danışmandır; bağımsız PASS, test veya owner kabulü yerine geçmez.
- Next inceleme kanalı (owner 2026-09-23, `CLAUDE.md`): Opus uygular, Astra `.agents/refactor/channel.mjs` ile inceler; alıcılar işlenmiş kayıtları tüketir. Fable'ın Next rolü yürütücü ve salt-okunur auditor'dür (`.claude/rules/auditor.md`). Bağımsız inceleme uydurulmaz; Jev veya self-review bağımsız PASS değildir.
- Legacy cross-provider xverify kanalı (Fable → Sol) kapalıdır ve Next'te açılmaz; tarihsel receipt'leri Next kanıtı değildir. Bu iki kanal farklı şeylerdir; biri diğerinin durumunu belirlemez.
