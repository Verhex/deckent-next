// Independent expected outcomes, transcribed from the owner-accepted floor, never from aiAuthorityFloor's answer.
// Security/protocol fixtures only; this inventory grants no runtime authority.
export const floorFamilies = [
  { id: 'spend-reconcile', en: 'Provider spend reconciliation (settle, release, write-off)', tr: 'Sağlayıcı harcama uzlaştırması (settle, release, write-off)',
    whyEn: 'Owner Q-SPEND (b), 2026-10-26: no AI may reconcile held spend, even with an earlier grant. Normal call settlement remains available.',
    whyTr: 'Owner Q-SPEND (b), 2026-10-26: eski izin olsa da hiçbir AI bekleyen harcamayı uzlaştıramaz. Olağan çağrı hesaplaşması devam eder.',
    routes: [['provider-spend-account', 'fixture-target', 'reconcile']] },
  { id: 'administration', en: 'Policy administration execute/compensate', tr: 'Politika yönetimi execute/compensate',
    whyEn: 'Grants, bindings, delegation, restrictions, duties and standing grants must not let an AI enlarge its own authority.',
    whyTr: 'Grant, rol bağı, devir, kısıtlama, görev ayrılığı ve kalıcı izin AI tarafından yetki genişletmeye dönüşmemeli.',
    routes: ['execute', 'compensate'].map(action => ['operation', 'policy.administer', action]) },
  { id: 'identity', en: 'Authority documents, authenticators and approval assurance: all mutations', tr: 'Yetki belgeleri, authenticator ve onay güvencesi: tüm değişimler',
    whyEn: 'An actor cannot replace the identity or approval verifier that constrains it; inspect/list remain policy governed.',
    whyTr: 'Aktör kendisini sınırlayan kimliği veya onay doğrulayıcısını değiştiremez; inspect/list politika kapsamındadır.',
    routes: ['authority-document', 'authenticator', 'approval-assurance'].flatMap(kind =>
      ['write', 'register', 'activate', 'remove', 'future-mutation'].map(action => [kind, 'fixture-record', action])) },
  { id: 'backup', en: 'Backup restore', tr: 'Yedeği geri yükleme', whyEn: 'A restore can replace authority data.', whyTr: 'Geri yükleme yetki verisini değiştirebilir.',
    routes: [['backup', 'fixture-backup', 'restore']] },
  { id: 'host', en: 'Execution environment install and installation repair', tr: 'Yürütme ortamı kurma ve kurulum onarımı',
    whyEn: 'Both change the host outside the sandbox (Docker group membership is root-equivalent); only a person at a terminal runs them (owner 2026-10-19).',
    whyTr: 'İkisi de sandbox dışında host’u değiştirir (Docker grubu root eşdeğeridir); yalnız terminaldeki kişi çalıştırır (owner 2026-10-19).',
    routes: [['execution-environment', 'fixture-target', 'install'], ['installation', 'fixture-target', 'repair']] },
  { id: 'uninstall', en: 'Installation uninstall and purge', tr: 'Kurulumu kaldırma ve verisini silme',
    whyEn: 'Removing the installation or purging its data cannot be undone by Deckent; only the person at their own terminal confirms it (alpha.56 U10B).',
    whyTr: 'Kurulumu kaldırmayı ya da verisini silmeyi Deckent geri alamaz; yalnız kendi terminalindeki kişi onaylar (alpha.56 U10B).',
    routes: [['installation', 'fixture-target', 'uninstall'], ['installation', 'fixture-target', 'purge']] },
  { id: 'mode', en: 'Permission mode set, including full access', tr: 'Full access dahil izin kipi değiştirme',
    whyEn: 'An AI must not choose a weaker permission mode for itself.', whyTr: 'AI kendi izin kipini gevşetemez.',
    routes: ['standart', 'full-auto', 'full-access'].map(id => ['permission-mode', id, 'set']) },
  { id: 'secret', en: 'Every secret action, including read/resolve', tr: 'Read/resolve dahil bütün sır işlemleri',
    whyEn: 'Reading, changing or moving credentials would bypass the secret boundary; read/resolve are defensive cells, not public secret-read APIs.',
    whyTr: 'Kimlik bilgisini okumak, değiştirmek veya taşımak sır sınırını aşar; read/resolve savunma hücreleridir, açık sır-okuma API’leri değildir.',
    routes: ['set', 'delete', 'switch', 'read', 'resolve', 'inspect', 'list', 'future-action'].map(action => ['secret', 'FIXTURE_SECRET', action]) },
  { id: 'cards', en: 'Authority approval cards', tr: 'Yetki onay kartları', whyEn: 'Deciding an authority card is another authority-changing route.',
    whyTr: 'Yetki kartını karara bağlamak da yetki değiştiren bir yoldur.',
    routes: ['identity-profile', 'policy-mcp-capability', 'policy-template-upgrade', 'audit-rebaseline', 'policy-recovery'].map(id => ['approval', id, 'decide']) },
  { id: 'audit', en: 'Audit actions except inspect/verify', tr: 'Inspect/verify dışındaki audit işlemleri',
    whyEn: 'An AI must not rewrite the baseline that detects authority drift.', whyTr: 'AI yetki kaymasını saptayan referans kaydını yeniden yazamaz.',
    routes: ['rebaseline', 'write', 'delete', 'future-action'].map(action => ['audit', 'fixture-scope', action]) },
  { id: 'tools', en: 'edit-authority and edit-floor tool-call cells', tr: 'edit-authority ve edit-floor araç çağrısı hücreleri',
    whyEn: 'Editing a protected boundary would otherwise circumvent the operation gate.', whyTr: 'Korunan sınırı düzenlemek operasyon kapısını dolanabilir.',
    routes: ['edit-authority', 'edit-floor'].map(id => ['agent-tool-call', id, 'invoke']) },
  { id: 'memory', en: 'Memory verify, retire, contest and purge', tr: 'Hafıza doğrulama, emekliye ayırma, itiraz ve silme',
    whyEn: 'Verified memory needs a person or an independent evaluation record, never the AI itself (law-audit fold 6); retiring is the same knowledge change; purging content is a person\'s act (S4B A11); verify and contest pass the floor only for the memory evaluator workload (S4B-3 A5), which these cells do not name.',
    whyTr: 'Doğrulanmış hafıza bir kişi ya da bağımsız değerlendirme kaydı ister, AI kendisi asla (kanun denetimi madde 6); emekliye ayırmak da aynı bilgi değişikliğidir; içerik silme (purge) insanındır (S4B A11); doğrulama ve itiraz tabandan yalnız hafıza değerlendirici iş kimliği için geçer (S4B-3 A5); bu hücreler onu adlandırmaz.',
    routes: ['verify', 'retire', 'contest', 'purge'].map(action => ['memory', 'fixture-target', action]) },
  { id: 'recovery', en: 'Standing approval of a Nervous stop action or a lost-task continuation', tr: 'Nervous durdurma eylemi ya da kayıp görev devamı için kalıcı onay',
    whyEn: 'The recovery broker applies a sealed Nervous proposal, and the recovery system continues a lost task in a new Attempt, only under the owner\'s standing grant (K-B, S6R-3/S6R-4); no AI holds it, Nervous itself only proposes.',
    whyTr: 'Kurtarma aracısı mühürlü Nervous önerisini uygular, kurtarma sistemi kayıp görevi yeni Attempt ile sürdürür; ikisi de yalnız sahibin kalıcı izniyle (K-B, S6R-3/S6R-4); bu izni hiçbir AI taşımaz, Nervous yalnız önerir.',
    routes: ['fixture-target', 'fence-attempt', 'stop-orphan', 'hand-to-human', 'continue-new-attempt'].flatMap(id => ['apply', 'future-action'].map(action => ['recovery-action', id, action])) },
  { id: 'nervous-rule', en: 'Promoting a Nervous rule to live', tr: 'Bir Nervous kuralını canlıya alma',
    whyEn: 'Only a person promotes an exact measured rule and version (alpha.56 G2, owner Q-A1); an AI holding this would let its own detections stop and release workers.',
    whyTr: 'Ölçülmüş bir kuralı ve sürümünü yalnız bir kişi canlıya alır (alpha.56 G2, owner Q-A1); bunu taşıyan bir AI kendi tespitleriyle işçileri durdurup bırakabilirdi.',
    routes: ['container-gone@1', 'fixture-target'].flatMap(id => ['promote', 'future-action'].map(action => ['nervous-rule', id, action])) },
  { id: 'signers', en: 'Signer key enrol, add, revoke and log repair', tr: 'İmza anahtarı ekleme, kaydetme, iptal ve kayıt onarımı',
    whyEn: 'Only a person adds or revokes the keys AI and system principals sign catalog actions with (S8-5, owner 2026-10-23); an AI holding this would grant itself signing authority.',
    whyTr: 'AI ve sistem kimliklerinin katalog eylemlerini imzaladığı anahtarları yalnız bir kişi ekler ya da iptal eder (S8-5, owner 2026-10-23); bunu taşıyan bir AI kendine imza yetkisi verirdi.',
    routes: ['enrol', 'add', 'revoke', 'repair', 'future-action'].map(action => ['skill-signer', 'fixture-target', action]) },
  { id: 'hub-sources', en: 'Hub source add and remove', tr: 'Hub kaynağı ekleme ve kaldırma',
    whyEn: 'Pinning or dropping a Hub source (its root key) is a person\'s trust decision (BeUser E-05, owner 2026-10-28 "only the person"); an AI holding this could make itself trust any publisher.',
    whyTr: 'Bir Hub kaynağını (kök anahtarını) sabitlemek ya da kaldırmak kişinin güven kararıdır (BeUser E-05, owner 2026-10-28 "yalnız kişiye"); bunu taşıyan bir AI kendini her yayıncıya güvendirebilirdi.',
    routes: ['sources.add', 'sources.remove'].map(action => ['hub', 'fixture-target', action]) },
  { id: 'catalog', en: 'Catalog suggestions and rule narrowing (every AI but the catalog aggregator)', tr: 'Katalog önerisi ve kural daraltması (katalog toplayıcı dışındaki her AI)',
    whyEn: 'Only the catalog aggregator writes suggestions and the automatic narrowing, each signed by its own key (S8-3, §9); another AI writing them could steer which agent runs without a card.',
    whyTr: 'Önerileri ve otomatik daraltmayı yalnız katalog toplayıcı, kendi anahtarıyla imzalayarak yazar (S8-3, §9); bunları yazan başka bir AI hangi ajanın kartsız çalışacağını yönlendirebilirdi.',
    routes: ['suggest', 'narrow'].map(action => ['agent-catalog', 'fixture-target', action]) },
];
export const protectedPaths = ['policy', 'approvals', 'identity', 'security', 'storage', 'service', 'paths', 'shell', 'network', 'layout', 'execution',
  'installation', 'company', 'enforce_principal_assurance', 'secrets', 'admission', 'operations', 'audit', 'memory', 'memoryAutomation', 'runRuntime.recovery', 'runRuntime.nervous', 'models.headless', 'toolchains.image', 'toolchains.currency.registryEndpoint', 'catalogEvolution',
  'terminal.shell.realm', 'terminal.shell.environment', 'terminal.fetch.egress', 'terminal.fetch.allowedHosts'];
floorFamilies.push({ id: 'configuration', en: 'Protected configuration subtrees, descendants and whole-object ancestors',
  tr: 'Korunan ayar ağaçları, alt yolları ve bütün nesneyi değiştiren üst yolları',
  whyEn: 'Security, isolation, admission, operations, audit, the recovery and Nervous modes, shell environment and network egress cannot be weakened through configuration.',
  whyTr: 'Güvenlik, yalıtım, admission, operasyon, audit, kurtarma ve Nervous modları, shell ortamı ve ağ çıkışı ayarla gevşetilemez.',
  routes: [...new Set(['', ...protectedPaths.flatMap(path => [path, `${path}.fixture`, `${path}[0]`,
    ...path.split('.').slice(0, -1).map((_part, index) => path.split('.').slice(0, index + 1).join('.'))])])]
    .flatMap(path => ['project', 'global'].map(layer => ['config', `${layer}:${path}`, 'write'])) });

export const nonFloorRoutes = [
  ...['authority-document', 'authenticator', 'approval-assurance'].flatMap(kind => ['inspect', 'list'].map(action => [kind, 'fixture-record', action])),
  ...['inspect', 'verify'].map(action => ['audit', 'fixture-scope', action]),
  ...['terminal.theme', 'terminal.shell.timeoutMs', 'terminal.fetch.timeoutMs', 'terminal.chat', 'language', 'max_workers', 'executionLookalike']
    .map(path => ['config', `project:${path}`, 'write']),
];

export function inventory(vocabulary) {
  const routes = new Map();
  const add = (route, floor, family) => { const [kind, id, action] = route; routes.set(JSON.stringify(route), { kind, id, action, floor, family }); };
  for (const { kind, actions } of vocabulary.resources) for (const action of actions)
    add([kind, kind === 'config' ? 'project:language' : 'fixture-target', action], kind === 'secret' || kind === 'backup' && action === 'restore'
      || kind === 'permission-mode' && action === 'set' || kind === 'execution-environment' && action === 'install' || kind === 'installation' && ['repair', 'uninstall', 'purge'].includes(action), 'vocabulary');
  nonFloorRoutes.forEach(route => add(route, false, 'boundary-control'));
  floorFamilies.forEach(family => family.routes.forEach(route => add(route, true, family.id)));
  return [...routes.values()].sort((a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; });
}

export function floorTable(locale) {
  const tr = locale === 'tr';
  return [tr ? '| Devredilemeyen sınır | Kaynaktaki hücreler | Neden |' : '| Non-delegable boundary | Source cells | Why |', '|---|---|---|',
    ...floorFamilies.map(family => `| ${tr ? family.tr : family.en} | ${family.id === 'configuration' ? protectedPaths.map(path => `\`${path}\``).join(', ')
      : [...new Set(family.routes.map(([kind, id, action]) => `\`${kind}/${id}/${action}\``))].join(', ')} | ${tr ? family.whyTr : family.whyEn} |`)].join('\n');
}
