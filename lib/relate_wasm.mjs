/**
 * Relate's WASM bundle, from Node and from the browser (example 33).
 *
 * Which bundle. npm's `@relate/relate-wasm`, pinned to an exact version in the example's
 * package.json and package-lock.json (npm ci checks the tarball's sha512 integrity, which is
 * the pin): relate.js (the wasm-bindgen glue), relate_bg.wasm, trap.js and the
 * snippets/relate-wasm-<hash>/js/opfs.js the glue imports. Node finds it in $RELATE_WASM_DIR,
 * else in the nearest node_modules/@relate/relate-wasm above the working directory, else in
 * examples/33-wasm-extract/node_modules; a page serves the same files from its own origin
 * and imports the glue itself. This file imports nothing at top level, so a page or a worker
 * can import it too: the Node helpers load node: modules when first called.
 *
 * Node only (async):
 *   find(ver)        the package directory (whether or not it exists)
 *   check(ver)       {ok, reason, version, dir, wasmSha256} without loading anything: the
 *                    package's version is <ver>, its file set is the published one, npm
 *                    recorded the lockfile's integrity for it (node_modules/.package-lock.json
 *                    against the example's package-lock.json) and the .wasm embeds
 *                    `Relate<ver>`. reason says what to run when !ok.
 *   loadNode(ver, {fresh})  the glue module after check(), initialised with
 *                    initSync({module: bytes}), refused unless CALL dbms.components()
 *                    reports Relate <ver>. One WASM instance per module URL: fresh: true
 *                    imports another copy of the glue, so another instance.
 * Both sides (db is a RelateDb from the glue):
 *   exec(db, query, params, {allowNull})    one statement -> {columns, rows, stats}
 *   script(db, text, params, {allowNull})   executeScript -> one {columns, rows, stats}
 *                    per statement; the first error throws, carrying .index and the
 *                    .results of the statements before it (they committed: NOTES.md R2)
 *   version(db)      the Relate row of CALL dbms.components(), e.g. '1.2.0'
 *   classify(text)   the first line of an engine message -> locked | readonly |
 *                    constraint | syntax | semantic | type | other
 *   isTrap(err)      the bundle's trap.js isWasmTrap, plus the follow-up error (R14)
 *   RelateWasmError  {category, message (the first line), detail (the whole
 *                    message, caret excerpt included), index?, results?}
 *
 * Rules the bundle keeps (examples/33-wasm-extract/NOTES.md has one row each, with a repro):
 *   - No transaction control (R2): BEGIN is a syntax error, every execute()
 *     autocommits, and executeScript() keeps the statements before a failing one.
 *   - Null and missing parameters (R3): exec() and script() refuse a top-level parameter
 *     that is null, undefined, NaN or Infinity (JSON sends those as null or drops them),
 *     and a $name in the text with no key in params, unless {allowNull: true}. The
 *     engine itself refuses a missing one (ParameterMissing), and from Relate 1.2.0 a
 *     null in a property map matches nothing; the refusal stays as defence in depth, so
 *     a forgotten argument is a clear error rather than an empty answer. Nested values
 *     (UNWIND $rows) are the caller's: guard with WHERE r.k IS NOT NULL.
 *   - R5: an integral JS number binds as INTEGER (0.0 and 3.0 too, since JSON has one
 *     number type). A VECTOR-indexed property now stores [0.9, 0] as a float list, but other
 *     properties keep the INTEGER: use toFloat() in the Cypher for every float parameter.
 *   - R4: results arrive as JSON. Rows are objects keyed by column name (keys sorted);
 *     nodes are {id, kind, labels, properties}, relationships {id, kind, type, start_node,
 *     end_node, properties}, paths flat lists; integers above 2^53 lose precision; DDL
 *     gives an empty result. An unaliased column is named by its text: alias them.
 *   - R14: a trap (a Rust panic, or deep nesting overflowing the stack) throws from
 *     the call itself, never as an envelope: exec() lets it through unchanged. The
 *     handle that trapped then throws `recursive use of an object detected...` on
 *     every call, which trap.js's isWasmTrap misses. Free the handle and replace the
 *     instance (in a page, the worker); isTrap() says when.
 *   - R11, R15: one opener per OPFS store, read-only or not; the refusal is an Error
 *     named RelateLocked, `storage locked: opfs://<name>`: classify(err.message) gives
 *     'locked'. A read-only handle refuses each write it would perform ('readonly':
 *     `semantic error: WriteOnReadOnlyAccessDatabase: No write operations are allowed
 *     on this database…`), and reset() throws `database is read-only`.
 * The CLI's exit codes and JSON error object and its agent-mode row cap do not exist here:
 * an error is the envelope's `error` string, and every row comes back.
 */

/** First-line patterns, most specific first; anything else is 'other'. */
const CATEGORIES = [
  ['locked', /(?:^|: )storage locked(?::|$)/],
  // a read-only write says Neo4j's message (WriteOnReadOnlyAccessDatabase: No write
  // operations are allowed…, prefixed 'semantic error: '); reset() throws the short form.
  ['readonly', /(?:^|: )(?:database is read-only\b|WriteOnReadOnlyAccessDatabase\b)/],
  // a graph type ALTER that existing data breaks: `semantic error: ConstraintCreationFailed: ConstraintValidationFailed: ...`
  ['constraint', /^(?:[a-z]+ error: )?(?:ConstraintCreationFailed: )?ConstraintValidationFailed\b/],
  ['syntax', /^syntax error: /],
  ['semantic', /^semantic error: /],
  ['type', /^type error: /],
];

/** An error envelope from the engine, or a refusal it threw (open, reset). */
export class RelateWasmError extends Error {
  /**
   * @param {string} detail  the engine's whole message
   * @param {{index?: number, results?: Array<object>}} [extra]
   */
  constructor(detail, extra = {}) {
    const text = String(detail);
    const first = text.split('\n')[0];
    super(first);
    this.name = 'RelateWasmError';
    this.category = classify(first);
    this.detail = text;
    Object.assign(this, extra);
  }
}

/**
 * @param {string} text  an engine message; only its first line is read
 * @returns {'locked'|'readonly'|'constraint'|'syntax'|'semantic'|'type'|'other'}
 */
export function classify(text) {
  const first = String(text).split('\n')[0];
  for (const [category, re] of CATEGORIES) if (re.test(first)) return category;
  return 'other';
}

/**
 * Whether `err`, thrown by a call into the bundle, means the instance trapped and the
 * handle cannot be used again: trap.js's isWasmTrap plus the follow-up `recursive use of an
 * object` error of a handle that trapped before (R14).
 * @param {unknown} err
 */
export function isTrap(err) {
  if (err instanceof RelateWasmError) return false;
  if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /unreachable|memory access out of bounds|call stack exhausted|maximum call stack size|recursive use of an object/i
    .test(message);
}

/** The $names a query refers to, outside strings, comments and quoted identifiers. */
function paramNames(text) {
  const names = new Set();
  const s = String(text);
  const ident = /[\p{L}\p{N}_]/u;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
    } else if (c === '`') {
      i = s.indexOf('`', i + 1);
      if (i < 0) break;
    } else if (c === '/' && s[i + 1] === '/') {
      i = s.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else if (c === '$') {
      if (s[i + 1] === '`') {
        const end = s.indexOf('`', i + 2);
        if (end < 0) break;
        names.add(s.slice(i + 2, end));
        i = end;
      } else {
        let j = i + 1;
        while (j < s.length && ident.test(s[j])) j++;
        if (j > i + 1) names.add(s.slice(i + 1, j));
        i = j - 1;
      }
    }
  }
  return names;
}

/** True when JSON would send `v` as null, or drop it. */
function sendsNull(v) {
  if (v === null || v === undefined || typeof v === 'function' || typeof v === 'symbol') return true;
  if (typeof v === 'number') return !Number.isFinite(v);
  if (typeof v === 'object' && typeof v.toJSON === 'function') return (JSON.stringify(v) ?? 'null') === 'null';
  return false;
}

/** params -> the JSON string the bundle takes, refusing null and missing values (R3). */
function wireParams(text, params, allowNull) {
  if (params !== undefined && params !== null &&
      (typeof params !== 'object' || Array.isArray(params))) {
    throw new TypeError('relate_wasm: params must be a plain object');
  }
  const p = params ?? {};
  if (!allowNull) {
    const bad = [];
    for (const name of paramNames(text)) if (!Object.hasOwn(p, name)) bad.push(`$${name} not supplied`);
    for (const [name, v] of Object.entries(p)) if (sendsNull(v)) bad.push(`$${name} is ${String(v)}`);
    if (bad.length) {
      throw new TypeError(`relate_wasm: refused (${bad.join('; ')}): a null or missing parameter is ` +
        'never what a caller meant. Guard it on the parameter side and pass {allowNull: true}');
    }
  }
  return params === undefined || params === null ? null : JSON.stringify(params);
}

function result(env) {
  return { columns: env.columns, rows: env.rows, stats: env.stats };
}

/**
 * One statement. An error envelope throws RelateWasmError; a trap throws as is.
 * @param {object} db  a RelateDb
 * @param {string} query
 * @param {object|null} [params]
 * @param {{allowNull?: boolean}} [opts]
 * @returns {{columns: string[], rows: Array<Object<string, any>>, stats: Object<string, number>}}
 */
export function exec(db, query, params = null, { allowNull = false } = {}) {
  const env = JSON.parse(db.execute(query, wireParams(query, params, allowNull)));
  if (env.error != null) throw new RelateWasmError(env.error);
  return result(env);
}

/**
 * A script of statements (executeScript): one result per statement, none for a blank
 * script. The engine stops at the first error, which throws RelateWasmError with
 * .index (the failing statement) and .results (the statements before it, committed).
 * @returns {Array<{columns: string[], rows: Array<Object<string, any>>, stats: Object<string, number>}>}
 */
export function script(db, text, params = null, { allowNull = false } = {}) {
  const envs = db.executeScript(text, wireParams(text, params, allowNull));
  const results = [];
  for (const [index, raw] of envs.entries()) {
    const env = JSON.parse(raw);
    if (env.error != null) throw new RelateWasmError(env.error, { index, results });
    results.push(result(env));
  }
  return results;
}

/** The engine version a handle reports (the Relate row of dbms.components()), or null. */
export function version(db) {
  const { rows } = exec(db, 'CALL dbms.components() YIELD name, versions RETURN name, versions');
  const row = rows.find((r) => r.name === 'Relate');
  return row ? row.versions[0] : null;
}

// ---- Node only -------------------------------------------------------------------

const PACKAGE = '@relate/relate-wasm';
/** The files npm publishes in the package (README.md and the .d.ts files aside). */
const REQUIRED = ['package.json', 'relate.js', 'relate_bg.wasm', 'trap.js', 'opfs.js'];

let node = null;
async function nodeMods() {
  if (!node) {
    const [fs, path, url, crypto] = await Promise.all(
      ['node:fs', 'node:path', 'node:url', 'node:crypto'].map((m) => import(m)));
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
    node = { fs, path, url, crypto, root };
  }
  return node;
}

/**
 * The package directory: $RELATE_WASM_DIR, else the nearest node_modules/@relate/relate-wasm
 * above the working directory, else examples/33-wasm-extract's (whether or not it exists).
 * @param {string} [ver]  unused (the version is the package's; check() compares it)
 * @returns {Promise<string>}
 */
// eslint-disable-next-line no-unused-vars
export async function find(ver) {
  const { fs, path, root } = await nodeMods();
  if (process.env.RELATE_WASM_DIR) return path.resolve(process.env.RELATE_WASM_DIR);
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...PACKAGE.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) break;
  }
  return path.join(root, 'examples', '33-wasm-extract', 'node_modules', ...PACKAGE.split('/'));
}

/**
 * The package at find(ver), checked without loading it.
 * @returns {Promise<{ok: boolean, reason: string, version: string, dir: string, wasmSha256: string|null}>}
 */
export async function check(ver) {
  const { fs, path, crypto, root } = await nodeMods();
  const dir = await find(ver);
  const info = { ok: false, reason: '', version: ver, dir, wasmSha256: null };
  const fail = (reason) => Object.assign(info, { reason });
  const shown = path.relative(root, dir).startsWith('..') ? dir : path.relative(root, dir);
  const fix = 'npm ci --omit=peer (in examples/33-wasm-extract)';
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    return fail(`no ${PACKAGE} at ${shown}: run '${fix}'` + (process.env.RELATE_WASM_DIR ? ' (or fix RELATE_WASM_DIR)' : ''));
  }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) {
    return fail(`${shown}/package.json does not parse (${e.message}): run '${fix}'`);
  }
  if (pkg.name !== PACKAGE || pkg.version !== ver) {
    return fail(`${shown} holds ${pkg.name}@${pkg.version}, not ${PACKAGE}@${ver}: run '${fix}'`);
  }
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(dir, f)));
  const snippets = path.join(dir, 'snippets');
  const opfs = fs.existsSync(snippets)
    ? fs.readdirSync(snippets).filter((d) => d.startsWith('relate-wasm-') && fs.existsSync(path.join(snippets, d, 'js', 'opfs.js')))
    : [];
  if (opfs.length !== 1) missing.push('snippets/relate-wasm-<hash>/js/opfs.js');
  if (missing.length) return fail(`${shown} is not the published package (missing: ${missing.join(', ')}): run '${fix}'`);
  // npm ci writes the lockfile's integrity for every package it installs into
  // node_modules/.package-lock.json; compare it with the lockfile beside node_modules.
  const modules = path.dirname(path.dirname(dir));
  const lockFile = path.join(path.dirname(modules), 'package-lock.json');
  const hidden = path.join(modules, '.package-lock.json');
  if (fs.existsSync(lockFile) && fs.existsSync(hidden)) {
    const key = `node_modules/${PACKAGE}`;
    const want = JSON.parse(fs.readFileSync(lockFile, 'utf8')).packages?.[key];
    const got = JSON.parse(fs.readFileSync(hidden, 'utf8')).packages?.[key];
    if (!want || !got || want.version !== ver || want.integrity !== got.integrity) {
      return fail(`${shown} was not installed from the lockfile's ${PACKAGE}@${ver} (integrity ` +
        `${got?.integrity?.slice(0, 19) ?? 'none'}, package-lock.json pins ${want?.integrity?.slice(0, 19) ?? 'none'}): run '${fix}'`);
    }
  }
  const wasm = fs.readFileSync(path.join(dir, 'relate_bg.wasm'));
  info.wasmSha256 = crypto.createHash('sha256').update(wasm).digest('hex');
  if (!wasm.includes(Buffer.from(`Relate${ver}`))) return fail(`${shown}/relate_bg.wasm does not embed Relate${ver}`);
  return Object.assign(info, { ok: true });
}

let instances = 0;

/**
 * The checked glue module, initialised in this process.
 * @param {string} ver
 * @param {{fresh?: boolean}} [opts]  fresh: import another copy (another WASM instance)
 */
export async function loadNode(ver, { fresh = false } = {}) {
  const { fs, path, url } = await nodeMods();
  const info = await check(ver);
  if (!info.ok) throw new Error(`relate_wasm: ${info.reason}`);
  const href = url.pathToFileURL(path.join(info.dir, 'relate.js')).href +
    (fresh ? `?instance=${++instances}` : '');
  const mod = await import(href);
  mod.initSync({ module: fs.readFileSync(path.join(info.dir, 'relate_bg.wasm')) });
  const db = new mod.RelateDb();
  let got;
  try { got = version(db); } finally { db.free(); }
  if (got !== ver) throw new Error(`relate_wasm: the bundle at ${info.dir} reports Relate ${got}, not ${ver}`);
  return mod;
}
