#!/usr/bin/env node
// @ts-check
/**
 * harness/vendor-studio.mjs: Neo4j's solution packages (github.com/neo4j/studio-agent-use-cases),
 * vendored verbatim into data/ontologies/studio/<package>/ at one pinned commit (D21, ADR-0020).
 *
 *   node harness/vendor-studio.mjs --commit <sha>     online, by hand: fetch through `gh api`, write the files
 *                                                    and data/ontologies/studio/manifest.json
 *   node harness/vendor-studio.mjs --check            offline: every file's sha256 against the manifest, and
 *                                                    the name guard; exit 1 on any difference
 *
 * Only the allowlisted files of each package are taken (ALLOW): the reference ontology, its queries,
 * its human description and, when it has one, its NOTICE (FIBO's copyright lines travel with the
 * packages adapted from FIBO). Never TESTS.md, SETUP.md, SKILL.md, implementation guidance, sample
 * data or the repository's skills.
 *
 * The name guard. The engine's earlier product name must never appear in this repository (AGENTS.md,
 * "Names"), and two files upstream spell it. This script never writes the name: it refuses any file
 * in which a run of letters and digits, lower-cased, holds a window whose sha256 is NAME_DIGEST.
 *
 * The licence: the repository has no licence file; these files are used with Neo4j's permission
 * (THIRD_PARTY.md, ADR-0020).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EX = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(EX, 'data/ontologies/studio');
const MANIFEST = join(DIR, 'manifest.json');
export const REPOSITORY = 'neo4j/studio-agent-use-cases';
/** The 13 packages with a reference ontology, in directory order. */
export const PACKAGES = Object.freeze([
  'attack-path-analysis', 'business-entities', 'competitive-intelligence', 'configurable-bom', 'ev-route-planning',
  'identity-validation', 'insurance-claims-fraud', 'loans-and-mortgages', 'multi-omics', 'patient-journey',
  'regulatory-dependency-mapping', 'retail-banking', 'securities-reference-data',
]);
/** The files taken from each package; NOTICE.md only where the package has one. */
export const ALLOW = Object.freeze(['ONTOLOGY.json', 'QUERIES.md', 'human_description.md', 'NOTICE.md']);
const OPTIONAL = new Set(['NOTICE.md']);
/** sha256 of the engine's earlier product name, lower case (see the header). */
export const NAME_DIGEST = 'e48b4b186c316ac789a362ce390d061245b6fb1eae45bef6803b86b6d95fa76f';
const NAME_LENGTH = 10;

const sha256 = (/** @type {Buffer|string} */ b) => createHash('sha256').update(b).digest('hex');

/**
 * Does this text hold the earlier product name (see the header)?
 * @param {string} text
 */
export function holdsEarlierName(text) {
  for (const run of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    for (let i = 0; i + NAME_LENGTH <= run.length; i++) {
      if (sha256(run.slice(i, i + NAME_LENGTH)) === NAME_DIGEST) return true;
    }
  }
  return false;
}

/** A file of the repository at a commit, through `gh api` (null when it does not exist). @param {string} path @param {string} ref */
function fetchFile(path, ref) {
  try {
    const out = execFileSync('gh', ['api', `repos/${REPOSITORY}/contents/${path}?ref=${ref}`, '--jq', '.content'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return Buffer.from(out.replace(/\s+/g, ''), 'base64');
  } catch (e) {
    const msg = String(/** @type {any} */ (e)?.stderr ?? e);
    if (/HTTP 404|Not Found/.test(msg)) return null;
    throw new Error(`vendor-studio: gh api ${path}@${ref}: ${msg.trim()}`);
  }
}

function vendor(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('vendor-studio: --commit takes a full 40-character sha');
  const date = execFileSync('gh', ['api', `repos/${REPOSITORY}/commits/${commit}`, '--jq', '.commit.committer.date'], { encoding: 'utf8' }).trim();
  /** @type {Record<string, string>} */
  const files = {};
  for (const pkg of PACKAGES) {
    for (const f of ALLOW) {
      const bytes = fetchFile(`${pkg}/${f}`, commit);
      if (bytes === null) {
        if (OPTIONAL.has(f)) continue;
        throw new Error(`vendor-studio: ${pkg}/${f} is missing at ${commit}`);
      }
      if (holdsEarlierName(bytes.toString('utf8'))) throw new Error(`vendor-studio: ${pkg}/${f} spells the engine's earlier product name; it is not vendored`);
      mkdirSync(join(DIR, pkg), { recursive: true });
      writeFileSync(join(DIR, pkg, f), bytes);
      files[`${pkg}/${f}`] = sha256(bytes);
      process.stderr.write(`vendor-studio: ${pkg}/${f} ${bytes.length} bytes\n`);
    }
  }
  const manifest = { repository: REPOSITORY, commit, committed: date, files };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`vendor-studio: ${Object.keys(files).length} files at ${commit.slice(0, 7)} (${date})\n`);
}

/**
 * The offline check: [problem, …] (empty when every file matches the manifest and none spells the name).
 * @returns {string[]}
 */
export function checkVendored() {
  if (!existsSync(MANIFEST)) return ['data/ontologies/studio/manifest.json is missing: run node harness/vendor-studio.mjs --commit <sha>'];
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const problems = [];
  for (const [path, want] of Object.entries(m.files)) {
    const p = join(DIR, path);
    if (!existsSync(p)) {
      problems.push(`${path}: missing`);
      continue;
    }
    const bytes = readFileSync(p);
    if (sha256(bytes) !== want) problems.push(`${path}: sha256 differs from the manifest (vendored files are never edited)`);
    if (holdsEarlierName(bytes.toString('utf8'))) problems.push(`${path}: spells the engine's earlier product name`);
  }
  for (const pkg of PACKAGES) {
    for (const f of ALLOW) if (!OPTIONAL.has(f) && !Object.hasOwn(m.files, `${pkg}/${f}`)) problems.push(`${pkg}/${f}: not in the manifest`);
  }
  return problems;
}

/** The manifest (repository, commit, committed, files). */
export function manifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args[0] === '--commit' && args[1]) vendor(args[1]);
  else if (args[0] === '--check') {
    const p = checkVendored();
    for (const x of p) process.stderr.write(`vendor-studio: ${x}\n`);
    if (p.length) process.exit(1);
    process.stderr.write(`vendor-studio: ${Object.keys(manifest().files).length} files match the manifest\n`);
  } else {
    process.stderr.write('usage: node harness/vendor-studio.mjs --commit <sha> | --check\n');
    process.exit(2);
  }
}
