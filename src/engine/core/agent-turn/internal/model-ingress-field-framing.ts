import { createHash } from 'node:crypto';

export const MODEL_INGRESS_FIELD_TEXT_ENCODING = 'deckent.model-ingress-field-text.v1';
export const MODEL_INGRESS_MODEL_TEXT_ENCODING = 'deckent.model-ingress-model-text.v1';
export type ModelIngressTextEncoding = typeof MODEL_INGRESS_FIELD_TEXT_ENCODING | typeof MODEL_INGRESS_MODEL_TEXT_ENCODING;
export type ModelIngressTextDigest = {
  readonly encodingVersion: ModelIngressTextEncoding;
  readonly codeUnits: number;
  readonly sha256: string;
};

/** A scratch-buffer size, never an input or product limit. Hash raw code units, including lone surrogates. */
const CHUNK_UNITS = 4096;

/** SHA256(ASCII encodingVersion + NUL + u64BE text.length + original uint16BE units).
 * No UTF-8 conversion, BOM, normalization, surrogate repair, JSON quoting or trailing terminator.
 * This binds a decoded JS field, not its producer identity, original bytes or container extraction.
 * Model-output and raw-field domains stay distinct even for identical text. No projection is performed here.
 */
export function modelIngressTextDigest(text: string, encodingVersion: ModelIngressTextEncoding): ModelIngressTextDigest {
  if (typeof text !== 'string' || (encodingVersion !== MODEL_INGRESS_FIELD_TEXT_ENCODING && encodingVersion !== MODEL_INGRESS_MODEL_TEXT_ENCODING)) {
    throw new TypeError('MODEL_INGRESS_FIELD_ENCODING_INVALID');
  }
  const hash = createHash('sha256').update(encodingVersion, 'ascii').update(new Uint8Array([0]));
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(text.length));
  hash.update(length);
  const chunk = Buffer.allocUnsafe(Math.min(text.length, CHUNK_UNITS) * 2);
  for (let start = 0; start < text.length; start += CHUNK_UNITS) {
    const units = Math.min(text.length - start, CHUNK_UNITS);
    for (let index = 0; index < units; index += 1) chunk.writeUInt16BE(text.charCodeAt(start + index), index * 2);
    hash.update(chunk.subarray(0, units * 2));
  }
  return Object.freeze({ encodingVersion, codeUnits: text.length, sha256: hash.digest('hex') });
}
