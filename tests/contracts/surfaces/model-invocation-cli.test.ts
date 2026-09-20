import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';
import { parseModelInvocationCancellationReceipt } from '#domain/core/model-invocation/index.js';
import { parseProviderSpendReservation, providerSpendQuoteDigest } from '#engine/index.js';
import { clearConfigCache } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const query = { schemaVersion: 2, scopeId: 'scope', invocationId: 'call', reference };
const command = { schemaVersion: 1, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog',
  expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) },
  nativeRequest: { messages: [{ role: 'user', content: 'response-content-must-not-render' }] } };
const purgedReceipt = { claim: { invocationId: 'call', commandId: 'command' }, outcome: { state: 'responded' } };
const purgeReceipt = { command: { invocationId: 'call' } };
function spending(state: 'held' | 'released-not-sent' | 'settled-local' | 'settled-provider-reported', reason: 'unknown' | 'missing-usage' | 'overrun' = 'missing-usage') {
  const quote = { schemaVersion: 1 as const, scopeId: 'scope', requestDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    pricing: { id: 'price', version: 1, digest: '291f395a66cb728f57612b09b06f9512815b982e9a5d65e3fafec28256ff0aa9', definition: { schemaVersion: 1, kind: 'synthetic-price' } }, meter: { id: 'meter', version: 1, evidenceDigest: '446658cc1c39184b672f423a7f970bffab0e8f38e851c5b5dacd3f38eb85051f', evidence: { schemaVersion: 1, kind: 'synthetic-meter' } },
    currency: 'USD', maxChargeMinorUnits: 99 };
  const overrun = state === 'held' && reason === 'overrun';
  const measurement = { schemaVersion: 1 as const, basis: 'provider-reported' as const, currency: 'USD', exactMinorUnits: overrun ? '99.02' : '0.02', roundedMinorUnits: overrun ? 100 : 1,
    quoteDigest: providerSpendQuoteDigest(quote), requestDigest: quote.requestDigest, profileDigest: quote.profileDigest, responseContentDigest: 'c'.repeat(64),
    source: { id: 'provider', version: 1, field: 'usage.cost', generationId: 'generation', modelId: 'model', numericSource: overrun ? '0.9902' : '0.0002', minorUnitsPerCurrencyUnit: 100,
      bodyDigest: 'd'.repeat(64), responseDigest: 'e'.repeat(64), requestBodyDigest: 'f'.repeat(64), tariffDigest: quote.pricing.digest, selectedEndpointTag: 'chat' } };
  return parseProviderSpendReservation({ schemaVersion: 2, descriptor: { schemaVersion: 1, scopeId: 'scope', invocationId: 'call',
    budgetId: 'budget', budgetRevision: 1, currency: 'USD', quoteDigest: providerSpendQuoteDigest(quote), quote },
  disposition: state === 'held' ? { state, reason, observedMinorUnits: reason === 'overrun' ? 100 : null, evidenceDigest: 'e'.repeat(64) }
    : state === 'released-not-sent' ? { state, evidenceDigest: 'e'.repeat(64) }
      : state === 'settled-provider-reported' ? { state, amountMinorUnits: 1, evidenceDigest: 'e'.repeat(64) }
        : { state, amountMinorUnits: 40, evidenceDigest: 'e'.repeat(64) },
  measurement: state === 'settled-provider-reported' || overrun ? measurement : null });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-invocation-cli-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home); await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ cli: { invocationInputMaxBytes: 1024 } }));
  return { root, env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}
it('reads file and stdin queries through one inspection contract and renders EN/TR states', async () => {
  const f = await fixture(), path = join(f.root, 'query.json'); await writeFile(path, JSON.stringify(query));
  for (const language of ['en', 'tr']) {
    let output = '', calls = 0;
    const code = await main(['models', 'invocation', '--input', language === 'en' ? path : '-', '--lang', language], {
      ...f, stdin: Readable.from([JSON.stringify(query)]), stdout: { write(text) { output += text; } },
      inspectModelInvocation: async (_root, input) => { calls++; expect(input).toEqual(query); return { ...input, schemaVersion: 7,
        historyIntegrity: 'not-recorded' as const, invocation: null, control: null, contentStatus: null, purge: null, spending: null }; },
    });
    expect(code).toBe(0); expect(calls).toBe(1); expect(output).toContain(language === 'en' ? 'No invocation receipt' : 'Çağrı kaydı bulunamadı');
  }
});
it('renders purged replay and inspection outcomes without claiming retained or showing response content', async () => {
  const f = await fixture(), invokePath = join(f.root, 'invoke.json'), queryPath = join(f.root, 'purged-query.json');
  await Promise.all([writeFile(invokePath, JSON.stringify(command)), writeFile(queryPath, JSON.stringify(query))]);
  let invokeOutput = '', inspectionOutput = '';
  const invokeCode = await main(['models', 'invoke', '--input', invokePath], { ...f, stdout: { write(text) { invokeOutput += text; } },
    invokeModel: async (_root, input) => { expect(input).toEqual(command); return {
      replayed: true, receipt: purgedReceipt, response: null, contentStatus: 'purged', purge: purgeReceipt,
    } as never; },
  });
  const inspectionCode = await main(['models', 'invocation', '--input', queryPath], { ...f, stdout: { write(text) { inspectionOutput += text; } },
    inspectModelInvocation: async (_root, input) => { expect(input).toEqual(query); return {
      ...input, invocation: purgedReceipt, contentStatus: 'purged', purge: purgeReceipt,
    } as never; },
  });
  for (const output of [invokeOutput, inspectionOutput]) {
    expect(output).toContain('native response received; response content has been purged');
    expect(output).toContain('Invocation content purged: call.');
    expect(output).toContain('Logical purge does not erase');
    expect(output).not.toContain('retained separately');
    expect(output).not.toContain('response-content-must-not-render');
  }
  expect(invokeCode).toBe(0); expect(inspectionCode).toBe(0);
  expect(invokeOutput).toContain('Existing receipt returned; request was not sent again.');
});
it('renders pre-permission cancellation as never sent without remote-cancellation language', async () => {
  const f = await fixture(), path = join(f.root, 'not-sent-query.json'); await writeFile(path, JSON.stringify(query));
  for (const [language, expected] of [['en', 'never sent; cancellation cancel prevented dispatch before permission'],
    ['tr', 'hiç gönderilmedi; cancel iptali izin öncesinde gönderimi engelledi']] as const) {
    let output = '';
    const receipt = { claim: { invocationId: 'call', commandId: 'command' }, outcome: { state: 'not-sent',
      reason: 'cancelled-before-permission', cancellationCommandId: 'cancel', content: null } };
    const code = await main(['models', 'invocation', '--input', path, '--lang', language], { ...f,
      stdout: { write(text) { output += text; } }, inspectModelInvocation: async input => ({ ...input,
        historyIntegrity: 'not-recorded', invocation: receipt, contentStatus: 'not-captured', purge: null, spending: null }) as never });
    expect(code).toBe(0); expect(output).toContain(expected); expect(output).not.toContain('remote');
    expect(output).toContain(language === 'en' ? 'local total call quota' : 'yerel toplam çağrı kotasında');
    expect(output).toContain(language === 'en' ? 'in-flight slot has been released' : 'eşzamanlı çalışma yuvası serbest bırakıldı');
    expect(output).not.toContain(language === 'en' ? 'Response content, if captured' : 'inspect-content');
  }
});
it('renders only the invocation reservation state in EN/TR without exposing native content or claiming an invoice', async () => {
  const f = await fixture(), path = join(f.root, 'spending-query.json'); await writeFile(path, JSON.stringify(query));
  const expected = {
    en: { held: 'Local reservation held: up to 99 minor units (USD), using recorded tariff price v1; reason: usage is missing.', 'released-not-sent': 'Local reservation released before sending: up to 99 minor units (USD), using recorded tariff price v1.',
      'settled-local': 'Local calculated amount: 40 minor units (USD) (quoted maximum: 99 minor units (USD)) using recorded tariff price v1.' },
    tr: { held: 'Yerel rezervasyon bekletildi: en fazla 99 alt birim (USD); kayıtlı tarife price v1 kullanıldı; neden: kullanım bilgisi eksik.', 'released-not-sent': 'Yerel rezervasyon gönderimden önce serbest bırakıldı: en fazla 99 alt birim (USD); kayıtlı tarife price v1 kullanıldı.',
      'settled-local': 'Yerel hesaplanan tutar: 40 alt birim (USD) (teklif üst sınırı: 99 alt birim (USD)); kayıtlı tarife price v1 kullanıldı.' },
  } as const;
  for (const state of ['held', 'released-not-sent', 'settled-local'] as const) for (const language of ['en', 'tr'] as const) {
    let output = '';
    const code = await main(['models', 'invocation', '--input', path, '--lang', language], { ...f, stdout: { write(text) { output += text; } },
      inspectModelInvocation: async input => ({ ...input, schemaVersion: 7, historyIntegrity: 'not-recorded', invocation: purgedReceipt, control: null, contentStatus: 'purged',
        purge: purgeReceipt, spending: spending(state) }) as never });
    expect(code).toBe(0); expect(output).toContain(expected[language][state]); expect(output).toContain(language === 'en' ? 'not a provider invoice' : 'sağlayıcı faturası değildir');
    expect(output).toContain(language === 'en' ? 'No persisted full-history audit result is available' : 'Kalıcı bir tam geçmiş denetim sonucu yok');
    expect(output).not.toContain('response-content-must-not-render'); expect(output).not.toContain('scope budget');
  }
});
it('renders the provider-reported exact minor-unit amount separately from its per-invocation rounding projection', async () => {
  const f = await fixture(), path = join(f.root, 'reported-spending-query.json'); await writeFile(path, JSON.stringify(query));
  const expected = {
    en: 'Provider-reported charge: exact 0.02 minor units (USD); local per-invocation rounding projection: 1 minor units (USD)',
    tr: 'Sağlayıcı tarafından bildirilen tutar: tam olarak 0.02 alt birim (USD); çağrı başına yerel yuvarlama gösterimi: 1 alt birim (USD)',
  } as const;
  for (const language of ['en', 'tr'] as const) {
    let output = '';
    const code = await main(['models', 'invocation', '--input', path, '--lang', language], { ...f, stdout: { write(text) { output += text; } },
      inspectModelInvocation: async input => ({ ...input, schemaVersion: 7, historyIntegrity: 'not-recorded', invocation: purgedReceipt, control: null,
        contentStatus: 'purged', purge: purgeReceipt, spending: spending('settled-provider-reported') }) as never });
    expect(code).toBe(0); expect(output).toContain(expected[language]);
    expect(output).toContain(language === 'en' ? 'not a local tariff calculation or external invoice verification' : 'yerel tarife hesabı veya harici fatura doğrulaması değildir');
    expect(output).not.toContain(language === 'en' ? 'scope budget' : 'kapsam bütçesi');
  }
});
it('localizes held spending reasons in Turkish without exposing enum values', async () => {
  const f = await fixture(), path = join(f.root, 'held-reason-query.json'); await writeFile(path, JSON.stringify(query));
  for (const [reason, label] of [['unknown', 'kullanım bilinmiyor'], ['overrun', 'yerel tutar teklif üst sınırını aştı']] as const) {
    let output = '';
    const code = await main(['models', 'invocation', '--input', path, '--lang', 'tr'], { ...f, stdout: { write(text) { output += text; } },
      inspectModelInvocation: async input => ({ ...input, schemaVersion: 7, historyIntegrity: 'not-recorded', invocation: purgedReceipt, control: null,
        contentStatus: 'purged', purge: purgeReceipt, spending: spending('held', reason) }) as never });
    expect(code).toBe(0); expect(output).toContain(label); expect(output).not.toContain(reason);
  }
});
it('states that missing spending evidence is neither free nor zero cost', async () => {
  const f = await fixture(), path = join(f.root, 'no-spending-query.json'); await writeFile(path, JSON.stringify(query));
  for (const [language, expected] of [['en', 'does not mean it was free or zero cost'], ['tr', 'ücretsiz veya sıfır maliyetli olduğu anlamına gelmez']] as const) {
    let output = '';
    const code = await main(['models', 'invocation', '--input', path, '--lang', language], { ...f, stdout: { write(text) { output += text; } },
      inspectModelInvocation: async input => ({ ...input, schemaVersion: 7, historyIntegrity: 'not-recorded', invocation: purgedReceipt, control: null,
        contentStatus: 'purged', purge: purgeReceipt, spending: null }) as never });
    expect(code).toBe(0); expect(output).toContain(expected); expect(output).not.toContain('0 USD');
  }
});
it('preserves the same spending record in inspection JSON without ANSI', async () => {
  const f = await fixture(), path = join(f.root, 'spending-json-query.json'); await writeFile(path, JSON.stringify(query));
  const result = { ...query, schemaVersion: 7, historyIntegrity: 'not-recorded', invocation: purgedReceipt, control: null, contentStatus: 'purged', purge: purgeReceipt,
    spending: spending('settled-local') } as never;
  let output = '';
  const code = await main(['models', 'invocation', '--input', path, '--json', '--no-color'], { ...f, stdout: { write(text) { output += text; } },
    inspectModelInvocation: async (_root, input) => { expect(input).toEqual(query); return result; } });
  expect(code).toBe(0); expect(output).toBe(`${JSON.stringify(result)}\n`); expect(output).not.toContain(String.fromCharCode(27));
});
it('rejects invalid/oversized/interactive input before an application call without echoing its content', async () => {
  const f = await fixture(); let calls = 0;
  for (const input of ['{"nativeRequest":"sensitive-marker"}', 'sensitive-marker'.repeat(100)]) {
    let errors = '';
    const code = await main(['models', 'invoke', '--input', '-', '--json'], { ...f, stdin: Readable.from([input]),
      stderr: { write(text) { errors += text; } }, stdout: { write() {} }, invokeModel: async () => { calls++; throw new Error('UNREACHABLE'); } });
    expect(code).not.toBe(0); expect(errors).not.toContain('sensitive-marker');
  }
  expect(await main(['models', 'invoke', '--input', '-'], { ...f, stdin: Object.assign(Readable.from([]), { isTTY: true }),
    stderr: { write() {} } })).not.toBe(0); expect(calls).toBe(0);
});
it('rejects duplicate or unsupported flags and provides help without opening config or transport', async () => {
  for (const argv of [['models', 'invoke', '--input', '-', '--input', '-'], ['models', 'invoke', '--prompt', 'hidden']]) {
    expect(await main(argv, { stderr: { write() {} } })).not.toBe(0);
  }
  let output = ''; expect(await main(['models', 'invoke', '--help'], { stdout: { write(text) { output += text; } } })).toBe(0);
  expect(output).toContain('--input');
});
it('parses and renders purge-content without exposing retained payloads', async () => {
  const f = await fixture(), path = join(f.root, 'purge.json');
  const purge = { schemaVersion: 1, commandId: 'purge-command', scopeId: 'scope', invocationId: 'call', reference,
    expectedContentDigest: 'a'.repeat(64) };
  await writeFile(path, JSON.stringify(purge)); let output = '', calls = 0;
  const code = await main(['models', 'purge-content', '--input', path], { ...f, stdout: { write(text) { output += text; } },
    purgeModelInvocationContent: async (_root, input) => { calls++; expect(input).toEqual(purge); return { replayed: false,
      receipt: { schemaVersion: 1, command: purge, actor: { id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'os-user' },
        authorization: { revision: 'allow', ruleId: 'purge-content' }, purgedAtMs: 1 } }; },
  });
  expect(code).toBe(0); expect(calls).toBe(1); expect(output).toContain('Invocation content purged: call.');
  expect(output).toContain('Logical purge does not erase'); expect(output).not.toContain('native');
});

it('records cancellation through the exact command input without claiming remote completion', async () => {
  const f = await fixture(), path = join(f.root, 'cancel.json');
  const cancel = { schemaVersion: 1, commandId: 'cancel-command', scopeId: 'scope', targetCommandId: 'command', reference,
    expectedRequestDigest: 'a'.repeat(64) };
  await writeFile(path, JSON.stringify(cancel)); let output = '', calls = 0;
  const code = await main(['models', 'cancel', '--input', path], { ...f, stdout: { write(text) { output += text; } },
    cancelModelInvocation: async (_root, input) => { calls++; expect(input).toEqual(cancel); return { replayed: false,
      receipt: { schemaVersion: 1, command: cancel, claim: { scopeId: 'scope', commandId: 'command', invocationId: 'call',
        requestDigest: cancel.expectedRequestDigest, profileDigest: 'b'.repeat(64) }, actor: { id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'os-user' },
      authorization: { revision: 'allow', ruleId: 'cancel-invocation' }, requestedAtMs: 1, disposition: 'requested' } } as never; },
  });
  expect(code).toBe(0); expect(calls).toBe(1); expect(output).toContain('Cancellation recorded for invocation: call.');
  expect(output).toContain('does not prove that a provider received, stopped, or completed work');
});

it('renders each parsed cancellation disposition with its actor in EN/TR and preserves JSON exactly without ANSI', async () => {
  const f = await fixture();
  const ansi = String.fromCharCode(27);
  const expected = {
    en: {
      prevented: 'Cancellation cancel-prevented: prevented before sending. Requested by actor-prevented.',
      requested: 'Cancellation cancel-requested: requested; provider stop is unconfirmed. Requested by actor-requested.',
      'already-terminal': 'Cancellation cancel-already-terminal: the invocation outcome was already recorded when cancellation was requested. Requested by actor-already-terminal.',
    },
    tr: {
      prevented: 'İptal cancel-prevented: istek gönderilmeden önlendi. İsteyen: actor-prevented.',
      requested: 'İptal cancel-requested: talep kaydedildi; sağlayıcının durduğu doğrulanmadı. İsteyen: actor-requested.',
      'already-terminal': 'İptal cancel-already-terminal: talep geldiğinde çağrının sonucu zaten kaydedilmişti. İsteyen: actor-already-terminal.',
    },
  } as const;
  for (const disposition of ['prevented', 'requested', 'already-terminal'] as const) {
    const cancel = { schemaVersion: 1 as const, commandId: `cancel-${disposition}`, scopeId: 'scope', targetCommandId: 'command', reference,
      expectedRequestDigest: 'a'.repeat(64) };
    const receipt = parseModelInvocationCancellationReceipt({ schemaVersion: 1, command: cancel, claim: { scopeId: 'scope', commandId: 'command',
      invocationId: `call-${disposition}`, requestDigest: cancel.expectedRequestDigest, profileDigest: 'b'.repeat(64) }, actor: { id: `actor-${disposition}`,
      issuer: 'issuer', subject: 'subject', assurance: 'os-user' }, authorization: { revision: 'allow', ruleId: 'cancel-invocation' },
      requestedAtMs: 1, disposition });
    const path = join(f.root, `${disposition}.json`); await writeFile(path, JSON.stringify(cancel));
    for (const language of ['en', 'tr'] as const) {
      let output = '';
      const code = await main(['models', 'cancel', '--input', path, '--lang', language, '--no-color'], { ...f,
        stdout: { write(text) { output += text; } }, cancelModelInvocation: async (_root, input) => {
          expect(input).toEqual(cancel); return { replayed: false, receipt }; },
      });
      expect(code).toBe(0); expect(output).toContain(expected[language][disposition]); expect(output).toContain(receipt.actor.id);
      expect(output).not.toContain(`${ansi}[`);
    }
    let json = '';
    const result = { replayed: false, receipt };
    const jsonCode = await main(['models', 'cancel', '--input', path, '--json', '--no-color'], { ...f,
      stdout: { write(text) { json += text; } }, cancelModelInvocation: async (_root, input) => {
        expect(input).toEqual(cancel); return result; },
    });
    expect(jsonCode).toBe(0); expect(json).toBe(`${JSON.stringify(result)}\n`); expect(json).not.toContain(`${ansi}[`);
  }
});
