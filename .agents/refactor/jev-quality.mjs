// Offline lint of authored context only. These heuristics neither score sufficiency nor prove claims.
const normalize = value => value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
const sameRefs = values => values.length > 1 && new Set(values.map(v => [...v.evidenceIds].sort().join('|'))).size === 1;
const performanceClaim = /\b(faster|fastest|lower latency|higher throughput|cheaper|scalable|scales to)\b|daha hızlı|daha ucuz|gecikmey[iı] azalt|ölçeklenebilir|\d+(?:[.,]\d+)?\s*(?:ms|seconds?|saniye|%|rps|tokens?\/s)(?=$|[\s.,;:)])/i;
const measurement = /\d+(?:[.,]\d+)?\s*(?:ms|seconds?|saniye|%|rps|tokens?\/s)(?=$|[\s.,;:)])/i;
const unverified = /^\s*(?:\[[^\]]*\]\s*)*\[(?:plan|assumption|hypothesis|proposal|unknown|varsayım|hipotez|öneri|bilinmeyen)\]/i;
// Observation class tags (authoring guidance, review config authoringGuidance). A tag classifies; it proves nothing.
const classTag = /^\s*(?:\[[^\]]*\]\s*)*\[(?:observed-source|retained-run|proposal|assumption|hypothesis|plan|unknown|gözlenen-kaynak|saklı-koşum|öneri|varsayım|hipotez|bilinmeyen)\]/i;
const noCounterevidence = /\bno counterevidence (?:was )?found\b|karşı kanıt bulunamadı/i;
const counterTag = /^\s*(?:\[[^\]]*\]\s*)*\[(?:counterevidence|karşı-kanıt)\]/i;
const rejected = /\brejected alternatives?\b|\bruled out\b|\bnot applicable\b|reddedilen alternatif|elenen alternatif|uygulanamaz/i;
const gains = /\bgain\b|\bbenefit\b|kazanım|kazanç|fayda/i;
const losses = /\bloss\b|\bcost\b|\brisk\b|kayıp|maliyet|bedel/i;
const openQuestion = /^(?:which|what|how|why|who|where|when)\b|^(?:hangi|nasıl|neden|kim|nerede|ne zaman)(?:\s|[?:]|$)/iu;

// Shared proposition hygiene for authored checks and the configured sufficiency template.
export function propositionRisks(text) {
  const codes = [];
  if (openQuestion.test(text.trim())) codes.push('CHECK_NOT_BINARY');
  if ((text.match(/\?/g) || []).length > 1) codes.push('CHECK_MULTIPLE_QUESTIONS');
  return codes;
}

// Called only after schema validation. No evidence source is opened or automatically uploaded.
export function sufficiencyRisks(c) {
  const warnings = [];
  const add = (code, path, message) => warnings.push({ code, path, message });
  const linked = ids => c.evidence.filter(e => ids.includes(e.id));
  for (const [i, o] of c.options.entries()) {
    const path = `options[${i}]`;
    if (!o.evidenceIds.length) add('OPTION_WITHOUT_EVIDENCE', `${path}.evidenceIds`, 'Seçeneğin dayanağı yok; ilgili gözlemi bağlayın veya varsayım olduğunu yazın.');
    const tradeoffs = o.tradeoffs.join(' ');
    if (!gains.test(tradeoffs) || !losses.test(tradeoffs)) add('TRADEOFF_BALANCE_UNCLEAR', `${path}.tradeoffs`, 'Kazanç ve kayıp açıkça tanınamadı; iki yönü de somutlaştırın. Dil sezgiseldir, doğruluk denetimi değildir.');
    if (performanceClaim.test([o.action, tradeoffs, o.northStarImpact].join(' '))
      && !linked(o.evidenceIds).some(e => !unverified.test(e.observation) && measurement.test(e.observation))) {
      add('MEASUREMENT_SUPPORT_UNCLEAR', path, 'Performans/maliyet iddiasına bağlı sayısal ölçüm tanınamadı. Ölçüm, iş yükü, ortam ve sürümü yazın; ölçülmediyse hipotez olarak sınırlayın.');
    }
  }
  if (!sameRefs(c.options)) {
    for (const [i, o] of c.options.entries()) {
      const others = c.options.filter((_, j) => j !== i);
      if (o.evidenceIds.length && o.evidenceIds.every(id => others.every(other => other.evidenceIds.includes(id)))) {
        add('OPTION_SPECIFIC_SUPPORT_UNCLEAR', `options[${i}].evidenceIds`, 'Bu seçeneğin her kanıtı diğer bütün seçeneklerde de var; onu ayıran gözlemi bağlayın veya ortak kanıtın seçenekleri nasıl ayırdığını yazın.');
      }
    }
  }
  if (sameRefs(c.options)) add('OPTIONS_SHARE_ALL_EVIDENCE', 'options', 'Bütün seçenekler aynı kanıtlara bağlı. Her gözlemin seçenekleri nasıl ayırdığını açıklayın; ortak kanıt tek başına hata değildir.');
  if (sameRefs(c.checks)) add('CHECKS_SHARE_ALL_EVIDENCE', 'checks', 'Bütün kontroller aynı kanıtlara bağlı. Her kontrol için ilgili gözlemi ve kalan boşluğu belirtin; referans varlığı anlamsal bağ kanıtı değildir.');
  for (const [i, q] of c.checks.entries()) {
    const risks = propositionRisks(q.instructions);
    if (risks.includes('CHECK_NOT_BINARY')) {
      add('CHECK_NOT_BINARY', `checks[${i}].instructions`, 'Kontrol Noul (evet/hayır) derlenir; bu ifade seçenek, liste veya açıklama istiyor olabilir. İlgili seçeneği/kanıtı adlandırıp tek evet/hayır önermesi yazın. Bu dil sezgisi otomatik düzeltme veya ret değildir.');
    }
    if (risks.includes('CHECK_MULTIPLE_QUESTIONS')) {
      add('CHECK_MULTIPLE_QUESTIONS', `checks[${i}].instructions`, 'Bir Noul içinde birden fazla soru tanındı. Her önermeyi ayrı kontrol yapın; aynı çağrıdaki kontroller bağımsızdır.');
    }
    const observations = linked(q.evidenceIds);
    if (observations.every(e => unverified.test(e.observation))) {
      add('CHECK_ONLY_UNVERIFIED_EVIDENCE', `checks[${i}].evidenceIds`, 'Kontrol yalnız plan/varsayım/hipotez olarak etiketlenmiş gözlemlere bağlı; gerçekleşmiş kanıt ile beklenen davranışı ayırın.');
    }
  }
  for (const [i, e] of c.evidence.entries()) {
    // A source locator alone is invisible evidence to Jev: the compiler does not retrieve it.
    if (normalize(e.observation) === normalize(e.source)
      || /^(?:https?:\/\/\S+|(?:\.{0,2}\/|[a-z][\w-]*\/)[^\s]+)$/i.test(e.observation.trim())) {
      add('EVIDENCE_LOCATOR_ONLY', `evidence[${i}].observation`, 'Dosya/URL içeriği otomatik okunmaz. Kararı ayıran temizlenmiş gözlem veya kısa alıntıyı yazın.');
    }
  }
  const untagged = c.evidence.filter(e => !classTag.test(e.observation)).length;
  if (untagged) add('OBSERVATION_CLASS_UNTAGGED', 'evidence', `${untagged} gözlemde sınıf etiketi yok ([observed-source], [retained-run], [proposal], [assumption], [unknown]). Etiket sınıfı adlandırır, doğruluğu kanıtlamaz.`);
  if (!c.evidence.some(e => counterTag.test(e.observation)) && !noCounterevidence.test(c.constraints.join(' '))) add('COUNTEREVIDENCE_UNCLEAR', 'evidence', 'Karşı kanıt etiketi ([counterevidence]) yok. Önde gelen seçeneği zayıflatan gözlemi ekleyin; bulunamadıysa bunu constraints içinde yazın. Kanıt uydurmayın.');
  if (new Set(c.options.map(o => normalize(o.action))).size !== c.options.length) add('DUPLICATE_OPTION_ACTION', 'options', 'Aynı eylem metni birden fazla seçenekte var; seçeneklerin davranış farkını kontrol edin.');
  if (new Set(c.options.map(o => normalize(o.northStarImpact))).size === 1) add('IDENTICAL_NORTH_STAR_IMPACT', 'options', 'North star etkisi bütün seçeneklerde aynı; ilgili kazanç, kayıp ve kanıt açığını seçenek bazında belirtin.');
  const decisionContext = [...c.constraints, ...c.process.acceptedDecisions, c.process.currentState,
    ...c.evidence.map(e => e.observation), ...c.options.flatMap(o => o.tradeoffs)].join(' ');
  if (!rejected.test(decisionContext)) add('REJECTED_ALTERNATIVES_UNCLEAR', 'process', 'Reddedilen/elenen alternatif ve gerekçesi tanınamadı. Varsa yazın; yoksa uygulanamaz olduğunu belirtin. Yeni bir alternatif uydurmayın.');
  if (!c.unknowns.length) add('NO_EXPLICIT_UNKNOWNS', 'unknowns', 'Bilinmeyenler boş; karar için gerekli bilinmeyenlerle kapsam dışı ölçümleri ayrı değerlendirin. Boş olması hata değildir.');
  return { version: 3, mode: 'advisory-only', semanticQuality: 'not-measured', warnings };
}
