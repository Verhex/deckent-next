# Platform, katman, başlangıç maliyeti ve donanım ratchet — modül notu

Layer/package listing, startup cost, entries and hardcode ratchet (ARCHITECTURE.md "Packages (current implementation)" taşındı 2026-10-05).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 565–617, 843–854, 1649–1662; text below is verbatim.


```text
src/platform/       config, errors/i18n, identity/host, product paths, bootstrap state and shared metadata
src/domain/         pure versioned task/run/policy, provider catalog/binding, model activation and invocation contracts
src/capabilities/   evaluation evidence contracts and validation; no AI semantic acceptance
src/engine/         application transitions and ports for runs/attempts, scheduling, workspaces, installation, runtime,
                    provider inspection, model activation and durable invocation admission/inspection
src/adapters/       SQLite stores/migrations, Git/Docker execution, local runtime socket/native bridge,
                    installation custody/evidence and provider-native adapters
src/surfaces/       shared CLI and MCP parsing/rendering/tool contracts
src/composition/    executable SDK/CLI/MCP/runtime wiring and adapter selection
```

The implemented product includes installed Git/Docker runtime execution and recovery, authenticated local runtime
control, recoverable custom-profile installation, declared provider/model inspection, scoped model activation and
durable native model invocation through runtime-backed SDK/CLI/MCP, task-admission approval, Linux
live sessions, and reference-only Git delivery/recovery. Three subscription coding providers have
recorded real local parallel execution evidence at `652d1c2`; this is not general provider, platform
or dogfood acceptance. The former `b1e430f` A3A-only snapshot is historical, not current capability.
General tool mediation, Brain semantic acceptance and DOGFOOD closure remain open.

Current transport is explicit: CLI Run/Task execution and approval use the runtime client; installation,
worker inspection and patch/integration operations use direct composition. MCP stdio uses runtime for
Run/Task/approval/model/spend and direct composition for catalog/activation. SDK exposes both configured
applications and a runtime client. One application/state owner does not imply one transport; direct SDK
access alone is not evidence of a policy bypass. Further custody/parity changes need their own proof.
Only CLI (including its `terminal` line/rich views) and MCP surfaces are shipped here; the MCP client reaches the owner's local stdio
servers and, since T3 (2026-10-07), Streamable HTTP servers (https; plain http only on loopback); Desktop/HTTP API surfaces, MCP OAuth and IFS
connectors remain targets. Unused translation keys are not handlers or evidence of a shipped surface.

**Startup cost (STARTUP-COST, seventh batch).** A process entry's static import graph is paid on every run. Heavy packages (`ink`,
`react`, `@modelcontextprotocol/server|client`) load only on the entry path that uses them and through dynamic `import()`: the terminal UI
loads with `deckent terminal` / the arg-less TTY opening (`workSurfaceLabels`/`runtimeBuildSkew` live in the `work-labels` unit since TUI1; the
launch itself is `cli-terminal`'s lazy `launchTerminal` since TERMINAL-LAUNCH, 2026-10-07),
`surfaces/index.ts` offers `loadMcpSurface()` instead of `createMcpServer`, and the MCP client SDK loads with the first MCP server start.
`tests/contracts/composition/startup-graph.test.ts` (on `dist`, static edges only) holds this for the SDK and CLI entries and "no Ink/React/
MCP client" for the stdio MCP entry. Measured by the lane: `deckent --version` 468 → 247 ms, SDK import 311 → 237 ms. Next: the whole
`adapters/index.js` barrel on process entries (remaining cost is ESM compile/resolve); a compile cache is a separate decision.

The shared-ledger `model-invocation-process` contract test (whose temporary 45 s bound this slice removed to the 30 s default) exceeded
that default on a GitHub runner roughly 2× slower than local; `DECKENT_TEST_STARTUP_COST=1` records each phase (SDK import/client, CLI
client, runtime ready/stop, invoke-to-provider, durable settlement, MCP ready/call/close, cleanup) opt-in. The measured root cause was 64
sequential process launches inside one `it` (CI-FIX F6, sixteenth batch); the file is now five steps sharing one `beforeAll` fixture and
process-identical assertion counts, longest step ≈ 7 s locally (`b9b2ce15`). The earlier 22–23 s single-test measurement predates the
split and is no longer current evidence; a real GitHub runner run is the open proof.

CI preparation (CI-FIX F1–F3): the required Linux job pulls the Docker test fixture by digest (`bash scripts/ci-docker-fixture.sh`:
`node@sha256:8ec5d755…`, local image id checked and exported as `DECKENT_TEST_DOCKER_IMAGE` through `GITHUB_ENV`; a failed daemon, pull,
identity check or unprivileged container run fails preparation — tests are never skipped). It then builds bubblewrap in check mode, stages it
(`scripts/build-bwrap.mjs --arch x86_64 --out …`, `--stage-dev …`), builds the product and runs `scripts/ci-shell-realm.mjs`, which checks both
staged trees against the lock, places the launcher through the service path and requires the compiled `doctor.shellRealm` to select usable
bubblewrap (only the ephemeral runner enables user namespaces via its AppArmor sysctl; not a product installation step; `realm-arm64` stays
disabled). Workflow expressions are checked locally with actionlint v1.7.7 (`go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`,
then `actionlint -shellcheck= -pyflakes= .github/workflows/*.yml`; no npm dependency).

Domain cannot import platform or other packages, host modules or ambient host globals. The purity gate also rejects
composition access to domain decision functions while allowing schema/type wiring; static analysis does not prove
all semantic purity. Surfaces may consume public platform/domain/capabilities/engine APIs and never adapters.
Engine consumes public platform/domain/capabilities contracts; adapters implement engine ports. Composition is the
only layer that wires adapters to applications and surfaces. Cross-unit dependencies and cycles are declared and
gated in `arch.json`; package imports use public `index.ts` barrels and `internal/` remains package-private.

Current compiled entries include the CLI and MCP composition binaries; the CLI starts the local runtime service. SDK, CLI and
MCP share the implemented inspection, activation, installation and runtime-control contracts; capability-specific
linked execution evidence defines where parity is complete. New package names have no compatibility import aliases.

HARDCODE-P1-B (landed, `e3dc5ff2`; owner order Jev e2b81339 2026-10-02, built in the D4 night 2026-10-03): `models.json` schema 2 owns the top-level effort vocabulary
in declared ascending order and Anthropic `metering.promptOverheadTokens` / `thinkingBudgetMinTokens`.
The adapter derives its runtime enum/rank from this vocabulary; model levels must be a strictly ascending subset,
with a declared default and any off ceiling in the vocabulary. Runtime admission still checks the pinned row;
TypeScript effort strings no longer encode a second closed vocabulary. Missing parameters and old asset versions
throw typed `ZodError` at module load; no silent defaults. Positive safe integers and schema/order constraints remain code.
The shipped vocabulary, 2048 local prompt reservation allowance and 1024 manual-thinking minimum are preserved.
The minimum/effort sources were verified 2026-10-03; model rows retain their 2026-09-29 snapshot as the asset note states.
OpenAI-chat owns `internal/metering.json` schema 1: request/message/tool estimate overheads 64/16/32,
validated once at load and read by its existing UTF-8-byte estimate. These overheads are local estimate policy,
not vendor-count guarantees; the provider counter remains the separate counting path when available. No config, ledger,
provider protocol or public surface is added. Proof: `proof/HARDCODE-P1-B-2026-10-03/`; independent review and landing remain open.

**Mimari kapılar (ARCH-GUARDS, 2026-10-06; geliştirme kapısı, ürün davranışı değişmez).** `scripts/lint-arch.mjs` yeni kurallar: `src-boundary`, `test-host-import`, `host-word`, `slug-cap`, `tier-direction` (paketler arası), `tier-budget`, `effect-flow`. `arch.json` yeni `guards` bölümü, `budgets.tierLines` ve `literals.allowUnits` taşır; `markdown.writerModule` kaldırıldı (src hiç `.md` yazmaz). `test:host` artık `n1-card-wire.test.mjs`'i içerir ve derlenmiş `dist` gerektirir (verify sırası build → test:host zaten doğru). Kalan: G-f (kapalı z.enum), G-i/G-j/G-k (SDK/overlay), içerik tabanlı G-h; host-word allowlist'indeki 3 i18n/yorum girdisinin düzeltilmesi; `slugCaps` küçültme (engine 23, domain 3); `effectFlows.frozen` 21 dosya C11 göçüyle azalacak. Karar noktaları: composition 6500 + enterprise tier ayrı bütçe anahtarı (4000); `qwen-decision.README.md` markdown kapısı kararı.

**Kurulum bağı v2 (IDENTITY-BINDING-V2, 2026-10-06, `wave/2`).** Yazım expand/contract: platform makine bağı alpha.6 v1 şeklinde yazılır; v2 kaydı `binding.schemaVersion: 2`, `strength: 'machine' | 'weak'`, `source: 'configured' | 'platform' | 'location'`; kimlik kaydı `schemaVersion: 2` kalır, eski v1 (makine gücü) okunur ve eşleştiği sürece yeniden yazılmaz. Ham makine değeri kayıt/çıktı/loga girmez; yalnız sabit uygulama anahtarlı HMAC (`deckent.installation-binding.v1`). Yapılandırılmış kaynak: mutlak yol, salt okunur, symlink izlenir (secret/downward API `..data`), normal dosya, `identityProbe.outputBytes` sınırı, 16–256 karakter `[A-Za-z0-9._:-]` belirteç, tek tekrar eden karakter/sıfırlar reddedilir; bozuksa okuma ve yazma yolunda `INSTALLATION_IDENTITY_SOURCE_INVALID`. Karşılaştırma (engine `assessInstallationBinding`): konum farkı → RELOCATED; makine kaydı + makine yakalama → digest; makine kaydı + yalnız zayıf yakalama → RELOCATED (alpha.6 atlıyordu); zayıf + zayıf → eşleşme; zayıf kayıt + aynı konumda makine yakalama → yazma yolunda güçlendirme. Yükseltme: read yolu `pendingWrite` bildirir, dosya/dizin/kilit yazmaz; bağsız v1 kayıt yalnız zayıf bağ mümkün ortamda sonraki yazma yolunda (kimlik yazma kilidi altında, kilit içinde yeniden yakalama) v2 zayıfa yükselir; makine kimlikli ortamda açık `--keep/--new` değişmedi. `installation.requireMachineBinding` true iken makine kanıtı yoksa her kuruluma bağlı yazma (ilk oluşturma, bağlama, güçlendirme, `--keep/--new`) tipli `INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED`; okumalar raporlar, taşınmış makine kaydında önce RELOCATED. `InstallationIdentityRead` eki `binding: { strength, source }`, `pendingWrite`; `bindingCapability: 'supported'` artık herhangi bir bağ demektir. Doctor EN+TR bağ gücü/kaynağı ve requireMachineBinding sonucu; JSON `installationBinding: { capability, strength, source, required }`. `init policy --apply` kimlik deposunu yerleşik yapılandırmanın installation ayarlarıyla kurar. Yazma kabulü (Astra 2382 P1-3): `init policy --apply` ve `init apply/resume` kimlik yazma kurallarını `InstallationIdentityStore.admitWrite()` ile ilk kalıcı etkiden (journal, policy, bindings, config, ledger) önce salt okuma olarak uygular; apply/resume journal kilidi altında hedeflerden önce yeniden uygular; ret durumunda dosya veya journal yazılmaz. Config alanları: `installation.machineIdentity.source` (`null` | mutlak yol; değer gösterilmez/loglanmaz), `installation.requireMachineBinding` (boolean, varsayılan `false`). Rollback: platform makine bağlı kurulumlar etkilenmez; weak/configured kayıtlar alpha.6'da INVALID okunur (kurtarma owner-decisions'ta). Proof `proof/W2-BINDING-V2-2026-10-06/`; Astra incelemesi bekliyor.

**Hata kataloğu temizliği ve doctor birimi (`wave/2`).** `src/platform/core/errors` registry'sinde numaralı legacy kod yoktur (80 `DECKENT_Exxx` + `INVALID_RUN_ID`, `INVALID_PHASE`, `CONFIG_ALIAS_CONFLICT` silindi; `DECKENT_E004` → `CONFIG_FILE_INVALID`, çıkış 78); `errors-output` sözleşme testi src'de başvurulmayan her kodu reddeder; bilinmeyen kod `error.unknown` metnine düşer. `LAYOUT_*` (5 kod) EN/TR `governance.json` cümleleriyle `validate/issues.ts` render noktasında `KOD: cümle` olur, `issues[].reason` ham kod kalır; `LayoutError` doğrudan çağrıda hâlâ yalın kod taşır (açık takip). `DispatchError` kodları (`DISPATCH_ARTIFACT_REQUIRED|CONFLICT|NOT_ADMITTED|PROFILE_VALIDATION_REQUIRED`) registry'ye eklendi; `queryFailure` tipli kodu yalnız registry'de varsa korur, sahte `{code}` taşıyan hata `INVENTORY_UNAVAILABLE` kalır. SDK `createCrossVerifyContractError`, `createExecutionAuthorityError`, `createExecutionAdmissionError`, `createDockerLifecycleError` export'tan çıktı. `src/surfaces/core/doctor` (bağımlılık: engine/toolchain-currency, platform/i18n) `renderDoctorReport`, `shellRealmLines`, `installationBindingLines`, `imageRefreshText` taşır; toplama `cli`'da kalır (doctor→cli bağımlılığı döngü olurdu); cli birimi 2003 → 1976 satır, bütçe 2000.
