// Offline, deterministic generator. Supply retained source files from the manifest; no fetch/latest lookup.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { expandCldrStringRange, parseCldrValidity, parseEmojiVariations, parseUnicodeRanges } from './model-ingress-unicode-data.mjs';

export { expandCldrStringRange, parseCldrValidity, parseEmojiVariations, parseUnicodeRanges };

const manifest = JSON.parse(readFileSync(new URL('./data/model-ingress-unicode-sources.json', import.meta.url), 'utf8'));
const assetPath = fileURLToPath(new URL('../src/domain/core/text/data/model-ingress-unicode-17-cldr48-2.json', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sortedSet = values => [...new Set(values)].sort();
const pairs = rows => rows.map(([first, last]) => [first, last]);

/** Validate every supplier byte before parsing; missing/drifted sources never produce a replacement asset. */
export function generateModelIngressUnicode(sourceDir) {
  const archive = sourceDir === undefined
    ? JSON.parse(readFileSync(new URL('./data/model-ingress-unicode-sources.gzip-base64.json', import.meta.url), 'utf8')) : undefined;
  if (archive && archive.encoding !== 'gzip-base64') throw new Error('MODEL_INGRESS_SOURCE_ARCHIVE_INVALID');
  const sources = new Map();
  for (const entry of manifest.sources) {
    const bytes = archive ? gunzipSync(Buffer.from(archive.files[entry.file], 'base64')) : readFileSync(resolve(sourceDir, entry.file));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`MODEL_INGRESS_SOURCE_MISMATCH:${entry.file}`);
    sources.set(entry.file, bytes.toString('utf8'));
  }
  const joiningText = sources.get('derived-joining-type-17.txt');
  const defaults = [...joiningText.matchAll(/^#\s*@missing:\s*(.+)$/gm)].map(match => match[1].trim());
  if (defaults.length !== 1 || defaults[0] !== '0000..10FFFF; Non_Joining') throw new Error('MODEL_INGRESS_JOINING_DEFAULT_INVALID');
  const ranges = file => parseUnicodeRanges(sources.get(file));
  const emoji = ranges('emoji-data-17.txt'), joining = ranges('derived-joining-type-17.txt');
  const combining = ranges('derived-combining-class-17.txt'), category = ranges('derived-general-category-17.txt');
  const indic = ranges('indic-syllabic-category-17.txt');
  const region = parseCldrValidity(sources.get('cldr-region-48-2.xml'), 'region');
  const subdivision = parseCldrValidity(sources.get('cldr-subdivision-48-2.xml'), 'subdivision');
  const data = {
    schemaVersion: 1, ucdVersion: manifest.ucdVersion, emojiVersion: manifest.emojiVersion,
    cldrVersion: manifest.cldrVersion, cldrCommit: manifest.cldrCommit,
    emojiPropertyRanges: emoji.filter(row => ['Emoji', 'Emoji_Presentation', 'Emoji_Modifier', 'Emoji_Modifier_Base'].includes(row[2])),
    emojiVariationSequences: parseEmojiVariations(sources.get('emoji-variation-sequences-17.txt')),
    joiningTypeRanges: joining, joiningTypeDefault: 'U',
    viramaRanges: pairs(combining.filter(row => row[2] === '9')),
    nonzeroCombiningClassRanges: pairs(combining.filter(row => row[2] !== '0')),
    letterRanges: pairs(category.filter(row => row[2].startsWith('L'))),
    nonspacingMarkRanges: pairs(category.filter(row => row[2] === 'Mn')),
    dependentVowelRanges: pairs(indic.filter(row => row[2] === 'Vowel_Dependent')),
    validAlpha2FlagRegions: sortedSet([...region.regular, ...region.deprecated].filter(value => /^[A-Z]{2}$/.test(value)).concat(['EU', 'UN'])),
    validNumericTagRegions: sortedSet([...region.regular, ...region.deprecated, ...region.macroregion].filter(value => /^[0-9]{3}$/.test(value))),
    validTagSubdivisions: sortedSet([...subdivision.regular, ...subdivision.deprecated]),
    scope: 'Minimum structural lookup proposal, not complete legitimate-natural-language classification; no LRM/RLM rule or contextual-policy allowlist embedded.',
  };
  const text = JSON.stringify(data, Object.keys(data).sort()) + '\n';
  if (Buffer.byteLength(text) !== manifest.assetBytes || sha256(text) !== manifest.assetSha256) throw new Error('MODEL_INGRESS_GENERATED_ASSET_MISMATCH');
  return text;
}

export function runModelIngressUnicodeGenerator(args) {
  const check = args.length === 1 && args[0] === '--check';
  const external = args.length === 4 && args[0] === '--source-dir' && args[2] === '--out';
  const out = args.length === 2 && args[0] === '--out';
  if (args.length !== 0 && !check && !external && !out) throw new Error('MODEL_INGRESS_GENERATOR_ARGUMENTS');
  const text = generateModelIngressUnicode(external ? resolve(args[1]) : undefined);
  // Complete generation/validation happens before the one output write. Source acquisition is a separate operator action.
  if (check) {
    if (readFileSync(assetPath, 'utf8') !== text) throw new Error('MODEL_INGRESS_CHECKED_ASSET_MISMATCH');
  } else writeFileSync(external ? resolve(args[3]) : out ? resolve(args[1]) : assetPath, text, 'utf8');
  process.stdout.write(`model-ingress unicode: ${Buffer.byteLength(text)} bytes sha256 ${sha256(text)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runModelIngressUnicodeGenerator(process.argv.slice(2));
