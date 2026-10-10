# Optional secret helpers

A trusted customer distribution can use an external credential source through the existing
SecretStore v1 port. `deckent/extensions` exports `createSecretHelperFactory` and
`registerSecretStoreBackend`. Register the resulting factory before starting any composed
entry, then select its store id with the existing secret-store picker or
`deckent secret store switch`. Core ships no vendor helper or automatically discovered command.
The encrypted-file store remains the installation default.

## Registration and policy

The distribution supplies `SecretHelperOptions`: a non-Core versioned store `id`, absolute
`executable` and `cwd`, fixed non-secret `args`, `timeoutMs`, `maxOutputBytes`, and an
`authorize` application port. Registration snapshots those constants. Config holds only
`secrets.store`; it cannot provide a command, arguments, environment variables or helper options.
Project config cannot redirect the installation's store. Late registration is refused.

The owning application binds `authorize({ backend, name })` to the current verified principal,
scope and policy and returns the existing typed policy decision. Every lookup, including a
probe, must receive `effect: allow` before a helper starts. A deny, require-approval, thrown
exception or missing decision is `SECRET_HELPER_DENIED`. This adapter has no approval surface
and never interprets a pending decision as permission. The application remains responsible
for its policy/audit context. Registration itself grants no authority and adds no policy rule.
Selection separately uses the existing governed `secret` / `switch` operation and audit.

Install helper code and its dependencies outside worker-writable locations; the executable,
arguments and working directory must contain no credentials. The helper receives an empty
environment, including no inherited HOME, API keys, tokens, PATH or loader settings. Use an
absolute executable and explicit non-secret locations for required assets. The helper retrieves
its own credentials through its trusted external source; Deckent never passes a secret to it.
This is a trusted host adapter, not an untrusted worker or a general shell-execution surface.
Worktree separation does not confine its filesystem/network access or protect against the same
OS user replacing trusted helper code. Installation ownership must enforce those boundaries.

## Protocol v1 and bounds

Deckent directly spawns the executable with the registered argument array, without a shell.
It sends `NAME` followed by LF on stdin and closes stdin. The response on stdout is one UTF-8
secret value, optionally followed by a single LF or CRLF. Empty output means the name is absent.
An absent name never falls back to environment or another store. Multiple lines, NUL bytes,
invalid UTF-8 and values over the SecretStore 64 KiB byte limit are `SECRET_VALUE_INVALID`.
Whitespace within the value is preserved. There is no value cache: each read sees the current source.

`timeoutMs` is a positive safe integer within Node's timer range; it includes authorization,
process startup and pipe completion. `maxOutputBytes` is a positive integer at most 65,538
(the port's 65,536 bytes plus CRLF), counting stdout and stderr together. stderr is discarded
without interpretation. No helper output, command path, raw exception or cause appears in the
adapter's errors, logs, audit or health view. Authorized values return only through the port;
existing config secret provenance and surface redaction apply.

A registered factory admits one lookup at a time across all store instances, refusing concurrent
reads with `SECRET_STORE_BUSY`; it has no queue. Linux and macOS invocations get a separate process
group. Completion, timeout and refusal kill that group, including descendants retaining pipes,
and destroy the local pipes. There are no retries. A helper that deliberately escapes its group
is outside this trusted-adapter contract. An authorization callback that finishes after its
deadline cannot start a child. SecretStore v1 has no caller cancellation signal; the deadline
bounds each lookup. JavaScript strings and external helper memory are not guaranteed zeroized.

## Typed outcomes and selection limits

| Code | Meaning |
|---|---|
| `SECRET_HELPER_INVALID` | Invalid registered command definition or bounds |
| `SECRET_HELPER_DENIED` | No allowed authorization decision |
| `SECRET_HELPER_TIMEOUT` | Lookup deadline expired |
| `SECRET_HELPER_OUTPUT_LIMIT` | Combined output exceeded its registered byte bound |
| `SECRET_HELPER_FAILED` | Spawn/pipe failure, non-zero exit or signal |
| `SECRET_VALUE_INVALID` | Invalid response framing or UTF-8 |
| `SECRET_STORE_UNAVAILABLE` | Unsupported/mismatched host platform |

The helper is read-only and cannot enumerate external names. `set` / `delete` return
`SECRET_STORE_READ_ONLY`; `listNames` returns `SECRET_STORE_UNSUPPORTED`. Health inspection
executes no helper and reports availability as unproven (`unavailable`); only an authorized
lookup proves a value can be retrieved. A general doctor command may load config references
through the normal resolver before it requests this health view.

The existing switch cannot migrate stored entries into a read-only helper or prove external
name availability for an environment store with configured secret references. Those selections
remain refused. A helper can be selected from an empty source, with explicit confirmation for
an unranked store; provision keys externally before adding provider references. Migration or
external-name discovery requires a separate contract and is not supplied here. Native Windows
is refused before process creation; Windows use is through WSL2. Local tests do not establish
macOS, hosted CI, vendor-helper, service/MCP extension startup or live acceptance.
