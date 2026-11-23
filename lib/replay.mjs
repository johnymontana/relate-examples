// lib/replay.mjs: lib/replay.py's dump() and load() for Relate WASM, in the same JSON format.
//
// The browser cannot read a .rl, and a dump made in a tab has to load natively (and the
// other way round), so this port writes and reads exactly the format lib/replay.py does:
// canon(dump(db)) here is byte-for-byte replay._canon(replay.dump(conn)) there, for one
// graph on one engine version. Read lib/replay.py's docstring first; this file follows
// it trap for trap (the R-ids are examples/01-wasm-extract/NOTES.md's rows):
//
//   Schema constraints and indexes are rebuilt from the SHOW columns, never createStatement,
//          and load() checks the result against the dumped rows (options may gain engine
//          defaults; vector.similarity_function compares case-insensitively). indexProvider
//          is left out of the OPTIONS written, and an index the target already holds by
//          name (the two built-in LOOKUP indexes) is not created again (R9).
//   Order  indexes are created before constraints, and a dumped index on a UNIQUE or KEY
//          constraint's key is dropped: the constraint's backing index serves it (R9).
//   Graph  dump() skips `dependent` constraints and keeps the graph type's elements under
//   types  "graph_type" (SHOW CURRENT GRAPH TYPE minus its CONSTRAINT entries); load() runs
//          ALTER CURRENT GRAPH TYPE SET after the data and before the schema DDL (SET drops
//          existing constraints: R16), refuses a target that has constraints, and checks
//          the elements read back text for text (D18).
//   Ids    nodes are numbered 0..n-1 in a canonical order (business keys from UNIQUE and
//          NODE KEY constraints, else a sha256 content fingerprint); load() maps the numbers
//          through a temporary :__Mig {__k} label with a UNIQUE constraint, whose backing
//          index serves the lookups, removed at the end.
//   Nulls  relationship rows are guarded on the parameter side, dangling endpoints are
//          refused before the first write, and the created counts are checked.
//
// What differs from Python, and why:
//   - Values. Scalars (BOOLEAN, INTEGER, FLOAT, STRING) and lists of them (the only
//     property values Relate stores; a map property is InvalidPropertyType) round-trip.
//     Temporal, POINT, DURATION and VECTOR properties are refused, naming the property: they
//     need lib/replay.py's typed sidecars ("vecs", "typed"), which this port never writes and
//     refuses to load.
//   - Floats. JSON.parse turns 1.0 into 1, and an integral JS number binds as INTEGER (R5).
//     So FLOAT values are held as `Float` objects, parse() keeps the lexical difference
//     (a number token with '.', 'e' or 'E' is a float, as in Python's json), canon() writes
//     them as Python's repr does ("1.0", "1e+16", "1.5e-07", NaN, Infinity), and load() binds
//     them through toFloat(). NaN and +-Infinity reach the envelope as "NaN"/"Inf"/"-Inf"
//     (R4) and travel to the engine, with -0.0, as strings toFloat() parses.
//   - Large integers. Beyond 2^53 parse() returns a BigInt (R4: JSON.parse would round it),
//     canon() writes its digits, and load() binds it as a string through toInteger().
//   - Text. Strings and keys sort by code point and canon() escapes as Python's
//     json.dumps(ensure_ascii=False) does, so digests match.
//
// Never pass a dump through JSON.stringify or postMessage: Float would be lost (its toJSON
// throws to make that loud). Send canon(d) and parse() it on the other side.
//
//   import * as replay from './replay.mjs';
//   const d = replay.dump(db);             // db: Relate WASM's RelateDb (execute(query, paramsJson) -> envelope)
//   const text = replay.canon(d);          // dump.json; lib/replay.py's json.loads reads it
//   replay.load(fresh, replay.parse(text)) // -> {nodes, relationships, constraints, indexes}
//   replay.contentDigest(fresh) === replay.digest(d)
//
// Env-agnostic ESM (Node and browser workers): no imports, no Node APIs, synchronous.

export const FORMAT = 1;
export const MIG_LABEL = '__Mig';
export const MIG_KEY = '__k';
export const MIG_CONSTRAINT = '__mig_k';
export const MIG_INDEX = '__mig_k_range';

/** A dump or load that would lose or invent data; thrown before any write when possible. */
export class ReplayError extends Error {
  constructor(message) { super(message); this.name = 'ReplayError'; }
}

/** The engine refused a statement: `message` is the envelope's error text, `query` the statement. */
export class EngineError extends Error {
  constructor(message, query) { super(message); this.name = 'EngineError'; this.query = query; }
}

/** A FLOAT value, kept apart from INTEGER (R5). valueOf() gives the number. */
export class Float {
  constructor(value) { this.value = Number(value); }
  valueOf() { return this.value; }
  toString() { return pyFloat(this.value); }
  toJSON() {
    throw new ReplayError('a Float cannot go through JSON.stringify (it would come back as an INTEGER); use replay.canon()');
  }
}

const PLAIN = new Set(['BOOLEAN', 'INTEGER', 'FLOAT', 'STRING', 'NOTHING']); // NOTHING: the empty list
const CONSTRAINTS = {
  NODE_PROPERTY_UNIQUENESS: ['NODE', 'IS UNIQUE'],
  NODE_KEY: ['NODE', 'IS NODE KEY'],
  NODE_PROPERTY_EXISTENCE: ['NODE', 'IS NOT NULL'],
  NODE_PROPERTY_TYPE: ['NODE', 'IS :: {propertyType}'],
  RELATIONSHIP_PROPERTY_UNIQUENESS: ['RELATIONSHIP', 'IS UNIQUE'],
  RELATIONSHIP_KEY: ['RELATIONSHIP', 'IS RELATIONSHIP KEY'],
  RELATIONSHIP_PROPERTY_EXISTENCE: ['RELATIONSHIP', 'IS NOT NULL'],
  RELATIONSHIP_PROPERTY_TYPE: ['RELATIONSHIP', 'IS :: {propertyType}'],
};
const KEY_KINDS = new Set(['NODE_PROPERTY_UNIQUENESS', 'NODE_KEY']);
const INDEXES = new Set(['RANGE', 'TEXT', 'POINT', 'VECTOR', 'FULLTEXT', 'LOOKUP']);
const C_COLS = ['name', 'type', 'entityType', 'labelsOrTypes', 'properties', 'propertyType', 'createStatement'];
const I_COLS = ['name', 'type', 'entityType', 'labelsOrTypes', 'properties', 'options', 'createStatement'];
const CASELESS_OPTIONS = new Set(['vector.similarity_function']);
const NON_FINITE = { NaN: NaN, Inf: Infinity, '-Inf': -Infinity }; // how the envelope spells them (R4)

// --- JSON, as Python's json module reads and writes it ------------------------------------------

/** Compare strings by code point, as Python does (JS `<` compares UTF-16 units). */
export function cmp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      const xs = x >= 0xd800 && x <= 0xdfff;
      const ys = y >= 0xd800 && y <= 0xdfff;
      if (xs === ys) return x - y;
      return xs ? 1 : -1; // a surrogate half belongs to a code point above U+FFFF
    }
  }
  return a.length - b.length;
}

/** Python's repr() of a float: shortest round-trip digits, exponent below 1e-4 or from 1e16. */
export function pyFloat(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [mantissa, e] = Math.abs(x).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exp = Number(e);
  const decpt = exp + 1;
  if (decpt > 16 || decpt < -3) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/**
 * json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False), as
 * lib/replay.py's _canon writes it. Float -> a float; a plain integral number -> an int;
 * a plain non-integral number -> a float; BigInt -> its digits.
 */
export function canon(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value instanceof Float) return pyFloat(value.value);
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'bigint': return value.toString();
    case 'number':
      if (Number.isInteger(value)) {
        if (!Number.isSafeInteger(value)) throw new ReplayError(`canon: ${value} is not a safe integer; use a BigInt`);
        return String(value);
      }
      return pyFloat(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
      return `{${Object.keys(value).sort(cmp).map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
    default:
      throw new ReplayError(`canon: cannot write a ${typeof value}`);
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

/**
 * JSON.parse that keeps what Python's json.loads keeps: a number token with '.', 'e' or 'E'
 * becomes a Float, an integer beyond 2^53 a BigInt; NaN, Infinity and -Infinity are accepted.
 */
export function parse(text) {
  let i = 0;
  const fail = (what) => { throw new ReplayError(`JSON: ${what} at offset ${i}`); };
  const ws = () => {
    for (let c = text.charCodeAt(i); c === 32 || c === 9 || c === 10 || c === 13; c = text.charCodeAt(++i));
  };
  const string = () => {
    let j = i + 1;
    for (;;) {
      const q = text.indexOf('"', j);
      if (q < 0) fail('unterminated string');
      let slashes = 0;
      while (text.charCodeAt(q - 1 - slashes) === 92) slashes++;
      if (slashes % 2 === 0) { j = q; break; }
      j = q + 1;
    }
    let s;
    try {
      s = JSON.parse(text.slice(i, j + 1)); // validates escapes and control characters
    } catch (e) {
      fail(`bad string (${e.message})`);
    }
    i = j + 1;
    return s;
  };
  const set = (o, k, v) => {
    if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
    else o[k] = v;
  };
  const word = (w, v) => { if (text.startsWith(w, i)) { i += w.length; return [true, v]; } return [false]; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const o = {};
      ws();
      if (text[i] === '}') { i++; return o; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a key');
        const k = string();
        ws();
        if (text[i++] !== ':') fail("expected ':'");
        set(o, k, value());
        ws();
        const d = text[i++];
        if (d === '}') return o;
        if (d !== ',') fail("expected ',' or '}'");
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      ws();
      if (text[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value());
        ws();
        const d = text[i++];
        if (d === ']') return a;
        if (d !== ',') fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    for (const [w, v] of [['true', true], ['false', false], ['null', null], ['NaN', NaN], ['Infinity', Infinity],
      ['-Infinity', -Infinity]]) {
      const [hit, got] = word(w, v);
      if (hit) return typeof got === 'number' ? new Float(got) : got;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) fail('unexpected character');
    i = NUMBER.lastIndex;
    if (m[1] !== undefined || m[2] !== undefined) return new Float(Number(m[0]));
    const n = Number(m[0]);
    return Number.isSafeInteger(n) ? n : BigInt(m[0]);
  };
  const v = value();
  ws();
  if (i !== text.length) fail('trailing characters');
  return v;
}

// --- sha256 (sync, so dump() and digest() stay synchronous in a worker) --------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Hex sha256 of a string's UTF-8 bytes. */
export function sha256(text) {
  const data = new TextEncoder().encode(text);
  const bits = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

// --- reading --------------------------------------------------------------------------------------

function run(db, cypher, params) {
  const env = parse(db.execute(cypher, params == null ? null : JSON.stringify(params)));
  if (env.error != null) throw new EngineError(String(env.error), cypher);
  return env;
}

const rows = (db, cypher, params) => run(db, cypher, params).rows;
const project = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c] === undefined ? null : row[c]]));
const byName = (a, b) => cmp(a.name, b.name);
const repr = (v) => (typeof v === 'string' ? `'${v}'` : canon(v));

const TYPES = (v) => `[k IN keys(${v}) | [k, valueType(${v}[k])]]`;
const READ_NODES = `MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props, ${TYPES('n')} AS types`;
const READ_RELS = 'MATCH (a)-[r]->(b) RETURN elementId(a) AS s, elementId(b) AS e, type(r) AS type, '
  + `properties(r) AS props, ${TYPES('r')} AS types`;

/** The whole graph and its schema as lib/replay.py's dump format (see the header). */
export function dump(db) {
  const constraints = rows(db, 'SHOW CONSTRAINTS YIELD * RETURN *')
    .filter((r) => r.classification !== 'dependent').map((r) => project(r, C_COLS)).sort(byName);
  const indexes = rows(db, 'SHOW INDEXES YIELD * RETURN *')
    .filter((r) => r.owningConstraint == null).map((r) => project(r, I_COLS)).sort(byName);
  const graphType = renderGraphType(splitGraphType(currentGraphType(db)).elements);
  const keys = keyConstraints(constraints);
  const raw = rows(db, READ_NODES).map((r) => readNode(r, keys));
  const order = new Map(raw.map((n) => [n, canon([identity(n), n.labels, values(n)])]));
  raw.sort((a, b) => cmp(order.get(a), order.get(b)));
  const ordinal = new Map(raw.map((n, k) => [n.id, k]));
  const nodes = raw.map(({ id, ...n }, k) => ({ k, ...n }));
  const rels = rows(db, READ_RELS).map((r) => readRel(r, ordinal));
  const relOrder = new Map(rels.map((r) => [r, canon([r.s, r.e, r.type, values(r)])]));
  rels.sort((a, b) => cmp(relOrder.get(a), relOrder.get(b)));
  return { format: FORMAT, engine: engineVersion(db), constraints, indexes, graph_type: graphType, nodes, relationships: rels };
}

function engineVersion(db) {
  const row = rows(db, 'CALL dbms.components() YIELD name, versions RETURN name, versions')
    .find((r) => r.name === 'Relate');
  return row && row.versions.length ? String(row.versions[0]) : 'unknown';
}

function readNode(row, keys) {
  const labels = [...row.labels].sort(cmp);
  const where = `node :${labels.join(':')}`;
  if (labels.includes(MIG_LABEL) || Object.hasOwn(row.props, MIG_KEY)) {
    throw new ReplayError(`${where} carries ${MIG_LABEL}/${MIG_KEY}, the scratch names load() uses; `
      + 'is this the target of an interrupted load?');
  }
  const n = { id: row.id, labels, key: null, ...split(row.props, row.types, where) };
  n.key = businessKey(labels, values(n), keys);
  return n;
}

function readRel(row, ordinal) {
  return { s: ordinal.get(row.s), e: ordinal.get(row.e), type: row.type,
    ...split(row.props, row.types, `relationship :${row.type}`) };
}

/** 'LIST<DATE NOT NULL> NOT NULL' -> ['DATE', true]; 'FLOAT NOT NULL' -> ['FLOAT', false]. */
function baseType(valueType) {
  let t = valueType.endsWith(' NOT NULL') ? valueType.slice(0, -9) : valueType;
  if (t.startsWith('LIST<') && t.endsWith('>')) {
    t = t.slice(5, -1);
    return [t.endsWith(' NOT NULL') ? t.slice(0, -9) : t, true];
  }
  return [t, false];
}

function plainValue(value, base, where, key) {
  if (base === 'FLOAT') {
    if (value instanceof Float) return value;
    if (typeof value === 'string' && Object.hasOwn(NON_FINITE, value)) return new Float(NON_FINITE[value]);
    if (typeof value === 'number') return new Float(value);
  } else if (base === 'INTEGER') {
    if (typeof value === 'bigint' || Number.isSafeInteger(value)) return value;
  } else if (base === 'STRING' ? typeof value === 'string' : base === 'BOOLEAN' ? typeof value === 'boolean' : false) {
    return value;
  }
  throw new ReplayError(`${where}: property ${repr(key)} of type ${base} reads back as ${repr(String(value))}`);
}

function split(props, types, where) {
  const plain = {};
  for (const [key, valueType] of types) {
    const [base, isList] = baseType(valueType);
    if (!PLAIN.has(base)) {
      throw new ReplayError(`${where}: property ${repr(key)} has type ${valueType}, which replay.mjs does not handle `
        + '(temporal, POINT, DURATION and VECTOR values need lib/replay.py)');
    }
    const value = props[key];
    plain[key] = isList ? value.map((x) => plainValue(x, base, where, key)) : plainValue(value, base, where, key);
  }
  const sorted = Object.fromEntries(Object.keys(plain).sort(cmp).map((k) => [k, plain[k]]));
  return { props: sorted, vecs: [], typed: [] };
}

// --- identity and digest ---------------------------------------------------------------------------

function keyConstraints(constraints) {
  const keys = constraints.filter((c) => KEY_KINDS.has(c.type) && c.entityType === 'NODE')
    .map((c) => [c.labelsOrTypes[0], [...c.properties]]);
  return keys.sort(([la, pa], [lb, pb]) => cmp(la, lb) || cmpList(pa, pb));
}

function cmpList(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = cmp(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

function businessKey(labels, vals, keys) {
  for (const [label, props] of keys) {
    if (labels.includes(label) && props.every((p) => Object.hasOwn(vals, p))) {
      return { label, props: Object.fromEntries(props.map((p) => [p, vals[p]])) };
    }
  }
  return null;
}

/** Every property of a dumped node or relationship; typed ones as their sidecar entry. */
function values(entry) {
  const out = { ...entry.props };
  for (const side of [...(entry.vecs || []), ...(entry.typed || [])]) {
    const { k, ...rest } = side;
    out[k] = rest;
  }
  return out;
}

function identity(node) {
  if (node.key != null) return node.key;
  return { content: sha256(canon([node.labels, values(node)])) };
}

/** sha256 over the canonical node and relationship lines of a dump (schema excluded); = replay.digest. */
export function digest(d) {
  const ident = new Map(d.nodes.map((n) => [canon(n.k), identity(n)]));
  const nodes = d.nodes.map((n) => canon([ident.get(canon(n.k)), [...n.labels].sort(cmp), values(n)])).sort(cmp);
  const rels = d.relationships.map((r) => canon([r.type, ident.get(canon(r.s)), ident.get(canon(r.e)), values(r)]))
    .sort(cmp);
  return sha256(['nodes', ...nodes, 'relationships', ...rels].map((line) => `${line}\n`).join(''));
}

/** digest(dump(db)): equal for two databases that hold the same graph. */
export function contentDigest(db) {
  return digest(dump(db));
}

// --- schema DDL ------------------------------------------------------------------------------------

const q = (name) => `\`${name.replaceAll('`', '``')}\``;
const pattern = (entity, names) => {
  const alts = names.map(q).join('|');
  return entity === 'NODE' ? `(n:${alts})` : `()-[n:${alts}]-()`;
};
const propList = (names) => names.map((p) => `n.${q(p)}`).join(', ');

function literal(value) {
  if (value === true || value === false) return String(value);
  if (value instanceof Float || typeof value === 'number' || typeof value === 'bigint') return canon(value);
  if (typeof value === 'string') return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${q(k)}: ${literal(v)}`).join(', ')}}`;
  throw new ReplayError(`cannot write ${repr(value)} as a Cypher literal`);
}

/** CREATE CONSTRAINT for one dumped SHOW CONSTRAINTS row, built from its columns. */
export function constraintDdl(row) {
  const kind = row.type;
  if (!Object.hasOwn(CONSTRAINTS, kind)) {
    throw new ReplayError(`constraint ${repr(row.name)} has kind ${repr(kind)}, which replay does not handle`);
  }
  const [entity, predicate] = CONSTRAINTS[kind];
  if ((row.entityType ?? entity) !== entity) throw new ReplayError(`constraint ${repr(row.name)}: kind ${kind} on a ${row.entityType}`);
  const req = predicate.replace('{propertyType}', String(row.propertyType));
  return `CREATE CONSTRAINT ${q(row.name)} FOR ${pattern(entity, row.labelsOrTypes)} REQUIRE (${propList(row.properties)}) ${req}`;
}

/** CREATE ... INDEX for one dumped SHOW INDEXES row, built from its columns (never createStatement). */
export function indexDdl(row) {
  const kind = row.type;
  const name = q(row.name);
  if (!INDEXES.has(kind)) throw new ReplayError(`index ${repr(row.name)} has kind ${repr(kind)}, which replay does not handle`);
  if (kind === 'LOOKUP') {
    return row.entityType === 'NODE' ? `CREATE LOOKUP INDEX ${name} FOR (n) ON EACH labels(n)`
      : `CREATE LOOKUP INDEX ${name} FOR ()-[n]-() ON EACH type(n)`;
  }
  const on = kind === 'FULLTEXT' ? `ON EACH [${propList(row.properties)}]` : `ON (${propList(row.properties)})`;
  const options = ddlOptions(row.options || {});
  const tail = Object.keys(options).length ? ` OPTIONS ${literal(options)}` : '';
  const keyword = kind === 'RANGE' ? '' : `${kind} `;
  return `CREATE ${keyword}INDEX ${name} FOR ${pattern(row.entityType, row.labelsOrTypes)} ${on}${tail}`;
}

/**
 * The OPTIONS map to write, as lib/replay.py's _ddl_options: without indexProvider (the engine reports
 * it in its own column and refuses it in OPTIONS: only indexConfig is accepted there), and none at all
 * for an empty indexConfig. A dump made by an older engine can carry {indexProvider: 'range-1.0'}.
 */
function ddlOptions(options) {
  const out = Object.fromEntries(Object.entries(options).filter(([k]) => k !== 'indexProvider'));
  const keys = Object.keys(out);
  const emptyConfig = keys.length === 1 && keys[0] === 'indexConfig' && isMap(out.indexConfig) && !Object.keys(out.indexConfig).length;
  return keys.length === 0 || emptyConfig ? {} : out;
}

/** The schema statements load() runs after the data and the graph type: indexes, then constraints. */
export function ddl(d) {
  return [...d.indexes.map(indexDdl), ...d.constraints.map(constraintDdl)];
}

// --- graph types (D18) ------------------------------------------------------------------------------

const CONSTRAINT_ITEM = /^CONSTRAINT\s/i;

/**
 * {elements, constraints} of a graph-type specification as SHOW CURRENT GRAPH TYPE prints it
 * ('{}' -> both empty). Items split at top-level commas, so a backticked name holding a comma or
 * a brace stays whole; CONSTRAINT items mirror SHOW CONSTRAINTS. = replay.split_graph_type.
 */
export function splitGraphType(spec) {
  const s = typeof spec === 'string' ? spec.trim() : '';
  if (!s.startsWith('{') || !s.endsWith('}')) throw new ReplayError(`graph type ${repr(spec)} is not a {...} specification`);
  const body = s.slice(1, -1);
  const items = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length && depth >= 0; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\' && quote !== '`') i++;
      else if (ch === quote) quote = null; // a doubled backtick closes and reopens at once
    } else if (ch === '`' || ch === "'" || ch === '"') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { items.push(body.slice(start, i).trim()); start = i + 1; }
  }
  const tail = body.slice(start).trim();
  if (quote || depth || (items.length && !tail) || items.some((x) => !x)) {
    throw new ReplayError(`graph type ${repr(spec)}: unbalanced quotes or brackets, or an empty item`);
  }
  if (tail) items.push(tail);
  return { elements: items.filter((x) => !CONSTRAINT_ITEM.test(x)), constraints: items.filter((x) => CONSTRAINT_ITEM.test(x)) };
}

/** A specification in the engine's own layout: '{}', or one element per line. */
export function renderGraphType(elements) {
  return elements.length ? `{\n  ${elements.join(',\n  ')}\n}` : '{}';
}

/** ALTER CURRENT GRAPH TYPE SET for a dump's graph type, or null when it has none. */
export function graphTypeDdl(d) {
  const elements = dumpedElements(d);
  return elements.length ? `ALTER CURRENT GRAPH TYPE SET ${renderGraphType(elements)}` : null;
}

function dumpedElements(d) {
  if (d.graph_type == null) return []; // a dump made before graph types (D18)
  const { elements, constraints } = splitGraphType(d.graph_type);
  if (constraints.length) {
    throw new ReplayError(`graph_type holds CONSTRAINT entries (${repr(constraints[0])}, ...); constraints belong in dump.constraints`);
  }
  return elements;
}

function currentGraphType(db) {
  return rows(db, 'SHOW CURRENT GRAPH TYPE YIELD specification RETURN specification')[0].specification;
}

function checkGraphType(db, d) {
  if (d.graph_type == null) return;
  const have = splitGraphType(currentGraphType(db)).elements;
  const want = dumpedElements(d);
  if (canon(have) !== canon(want)) {
    throw new ReplayError(`graph type differs after load: ${repr(renderGraphType(have))} != ${repr(renderGraphType(want))}`);
  }
}

// --- writing ---------------------------------------------------------------------------------------

// Each property travels as [key, value, conversion]: 'f'/'F' a FLOAT or a FLOAT list through
// toFloat() (R5), 'i'/'I' an INTEGER or an INTEGER list sent as strings through toInteger() (R4),
// null as is. Pairs, not a map, as in lib/replay.py (its Maps trap).
const SET_PROPS = (v) => `FOREACH (p IN row.props | SET ${v}[p[0]] = CASE p[2]
  WHEN 'f' THEN toFloat(p[1]) WHEN 'F' THEN [x IN p[1] | toFloat(x)]
  WHEN 'i' THEN toInteger(p[1]) WHEN 'I' THEN [x IN p[1] | toInteger(x)]
  ELSE p[1] END)`;
const LOAD_NODES = `UNWIND $rows AS row\nCREATE (m:${MIG_LABEL} {${MIG_KEY}: row.k})\nSET m:$(row.labels)\n${SET_PROPS('m')}`;
const LOAD_RELS = 'UNWIND $rows AS row\nWITH row WHERE row.s IS NOT NULL AND row.e IS NOT NULL\n'
  + `MATCH (a:${MIG_LABEL} {${MIG_KEY}: row.s}), (b:${MIG_LABEL} {${MIG_KEY}: row.e})\n`
  + `CREATE (a)-[rel:$(row.type)]->(b)\n${SET_PROPS('rel')}`;

function wire(x, where, key) {
  if (x instanceof Float) { // NaN, +-Infinity and -0.0 (JSON.stringify(-0) is "0") travel as text toFloat() parses
    return Number.isFinite(x.value) && !Object.is(x.value, -0) ? ['f', x.value] : ['f', pyFloat(x.value)];
  }
  if (typeof x === 'bigint') return ['i', x.toString()];
  if (typeof x === 'number' && !Number.isSafeInteger(x) && Number.isInteger(x)) {
    throw new ReplayError(`${where}: property ${repr(key)} holds ${x}, beyond 2^53; parse() the dump to keep it exact`);
  }
  if (typeof x === 'number' && !Number.isFinite(x)) return ['f', pyFloat(x)];
  if (x === null || typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number') return [null, x];
  const what = Array.isArray(x) ? 'nested list' : x !== null && typeof x === 'object' ? 'map' : typeof x;
  throw new ReplayError(`${where}: property ${repr(key)} holds a ${what}, which replay.mjs does not handle`);
}

function propPair(key, value, where) {
  if (!Array.isArray(value)) {
    const [kind, v] = wire(value, where, key);
    return [key, v, kind];
  }
  const items = value.map((x) => wire(x, where, key));
  const kinds = new Set(items.map(([kind]) => kind).filter((k) => k));
  if (kinds.size > 1) throw new ReplayError(`${where}: property ${repr(key)} mixes FLOAT and INTEGER items`);
  const [kind] = [...kinds];
  if (kind === 'i') return [key, items.map(([, v]) => String(v)), 'I'];
  return [key, items.map(([, v]) => v), kind ? kind.toUpperCase() : null];
}

function loadRow(entry, where) {
  for (const v of entry.vecs || []) throw new ReplayError(`${where}: VECTOR property ${repr(v.k)} needs lib/replay.py`);
  for (const t of entry.typed || []) throw new ReplayError(`${where}: ${t.type} property ${repr(t.k)} needs lib/replay.py`);
  const keys = Object.keys(entry.props).sort(cmp);
  return { props: keys.map((k) => propPair(k, entry.props[k], where)) };
}

function relRows(rels, known) {
  return rels.map((r, i) => {
    if (!known.has(canon(r.s ?? null)) || !known.has(canon(r.e ?? null))) {
      throw new ReplayError(`relationship ${i} :${r.type} points at node ${repr(r.s ?? null)} -> ${repr(r.e ?? null)}, `
        + 'which the dump does not contain');
    }
    return { ...loadRow(r, `relationship ${i} :${r.type}`), s: r.s, e: r.e, type: r.type };
  });
}

function batched(db, cypher, list, size, stat) {
  let made = 0;
  for (let i = 0; i < list.length; i += size) made += run(db, cypher, { rows: list.slice(i, i + size) }).stats[stat] || 0;
  return made;
}

/**
 * Replay a dump into `db` (normally a fresh store) and return what was created, as lib/replay.py's
 * load() does: everything validated before the first write; data, then the graph type, then
 * indexes and constraints; the schema checked against the dump. WASM has no transactions (R2), so
 * on an error after the first write, throw the target away.
 */
/**
 * Names of dumped RANGE indexes that duplicate a dumped UNIQUE/KEY constraint's key. The constraint's
 * own backing index serves lookups, and a second index on its key is refused (R9): a dump an older
 * engine made can carry such an index beside its UNIQUE, and both must not be replayed (the constraint is).
 */
function shadowedIndexes(d) {
  const backed = new Set(['NODE_PROPERTY_UNIQUENESS', 'RELATIONSHIP_PROPERTY_UNIQUENESS', 'NODE_KEY', 'RELATIONSHIP_KEY']);
  const keys = new Set(d.constraints.filter((c) => backed.has(c.type))
    .map((c) => JSON.stringify([c.entityType ?? 'NODE', c.labelsOrTypes, c.properties])));
  return new Set(d.indexes.filter((i) => i.type === 'RANGE' && !i.owningConstraint
    && keys.has(JSON.stringify([i.entityType, i.labelsOrTypes, i.properties]))).map((i) => i.name));
}

export function load(db, d, { batch = 500 } = {}) {
  if (d.format !== FORMAT) throw new ReplayError(`dump format ${repr(d.format ?? null)}, expected ${FORMAT}`);
  const shadowed = shadowedIndexes(d);
  if (shadowed.size) d = { ...d, indexes: d.indexes.filter((i) => !shadowed.has(i.name)) };
  const statements = ddl(d);
  const alter = graphTypeDdl(d);
  const nodes = d.nodes.map((n) => ({ ...loadRow(n, `node ${canon(n.k)}`), k: n.k, labels: [...n.labels] }));
  const rels = relRows(d.relationships, new Set(d.nodes.map((n) => canon(n.k))));
  if (alter) {
    const held = rows(db, 'SHOW CONSTRAINTS YIELD name RETURN name').map((r) => r.name).sort(cmp);
    if (held.length) {
      throw new ReplayError(`the target already has constraints (${held.join(', ')}), which ALTER CURRENT GRAPH TYPE SET `
        + 'would drop; load into a fresh database');
    }
  }
  // The UNIQUE's own backing index serves the __Mig key lookups (R9).
  run(db, `CREATE CONSTRAINT ${MIG_CONSTRAINT} FOR (m:${MIG_LABEL}) REQUIRE m.${MIG_KEY} IS UNIQUE`);
  const madeNodes = batched(db, LOAD_NODES, nodes, batch, 'nodes_created');
  const madeRels = batched(db, LOAD_RELS, rels, batch, 'relationships_created');
  if (madeNodes !== nodes.length || madeRels !== rels.length) {
    throw new ReplayError(`created ${madeNodes}/${nodes.length} nodes and ${madeRels}/${rels.length} relationships`);
  }
  run(db, `MATCH (m:${MIG_LABEL}) REMOVE m:${MIG_LABEL}, m.${MIG_KEY}`);
  run(db, `DROP CONSTRAINT ${MIG_CONSTRAINT}`);
  if (alter) {
    run(db, alter); // validates the data just written; a violation throws here
    checkGraphType(db, d);
  }
  // Every store starts with two LOOKUP indexes (one on labels, one on types) under fixed names, so a
  // dump lists them too: an index the target already holds by name is not created again (an explicit
  // CREATE of the same name would turn the built-in into a named index, and a later equivalent LOOKUP
  // index would then be refused as EquivalentSchemaRuleAlreadyExists).
  const present = new Set(rows(db, 'SHOW INDEXES YIELD name RETURN name').map((r) => r.name));
  const todo = [...d.indexes.filter((i) => !present.has(i.name)).map(indexDdl), ...statements.slice(d.indexes.length)];
  for (const statement of todo) run(db, statement);
  checkSchema(db, d);
  return { nodes: madeNodes, relationships: madeRels, constraints: d.constraints.length, indexes: d.indexes.length };
}

export const replay = load; // an alias

function checkSchema(db, d) {
  const haveC = new Map(rows(db, 'SHOW CONSTRAINTS YIELD * RETURN *').map((r) => [r.name, r]));
  const haveI = new Map(rows(db, 'SHOW INDEXES YIELD * RETURN *').filter((r) => r.owningConstraint == null)
    .map((r) => [r.name, r]));
  const problems = [];
  for (const c of d.constraints) {
    const have = shapeC(haveC.get(c.name));
    if (have !== shapeC(c)) problems.push(`constraint ${c.name}: ${have} != ${shapeC(c)}`);
  }
  for (const i of d.indexes) {
    const why = indexMismatch(haveI.get(i.name), i);
    if (why) problems.push(`index ${i.name}: ${why}`);
  }
  if (haveC.has(MIG_CONSTRAINT)) problems.push(`the scratch constraint ${MIG_CONSTRAINT} is still there`);
  if (haveI.has(MIG_INDEX)) problems.push(`the scratch index ${MIG_INDEX} is still there`);
  if (problems.length) throw new ReplayError(`schema differs after load: ${problems.join('; ')}`);
  checkGraphType(db, d);
}

const sortedNames = (xs) => [...(xs || [])].sort(cmp);
const shapeC = (r) => (r == null ? 'None' : canon([r.type, r.entityType, sortedNames(r.labelsOrTypes),
  [...(r.properties || [])], r.propertyType ?? null]));
const shapeI = (r) => (r == null ? 'None' : canon([r.type, r.entityType, sortedNames(r.labelsOrTypes), [...(r.properties || [])]]));

function indexMismatch(have, want) {
  if (have == null) return 'missing after load';
  if (shapeI(have) !== shapeI(want)) return `${shapeI(have)} != ${shapeI(want)}`;
  const diffs = optionDiffs(ddlOptions(want.options || {}), have.options || {});
  return diffs.length ? `options differ: ${diffs.join('; ')}` : null;
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Float);
const num = (v) => (v instanceof Float ? v.value : typeof v === 'bigint' ? Number(v) : v);

function same(a, b) { // Python ==: 1 == 1.0, lists and maps compared deeply
  a = num(a);
  b = num(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isMap(a) && isMap(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return a === b;
}

/** '<path>: dump <value>, target <value>' for each dumped option the target lacks or holds otherwise. */
function optionDiffs(want, have, path = '', key = '') {
  if (isMap(want)) {
    if (!isMap(have)) return [`${path || 'options'}: dump ${repr(want)}, target ${repr(have ?? null)}`];
    const out = [];
    for (const [k, v] of Object.entries(want)) {
      const where = path ? `${path}.${k}` : k;
      if (Object.hasOwn(have, k)) out.push(...optionDiffs(v, have[k], where, k));
      else out.push(`${where}: dump ${repr(v)}, target has no such option`);
    }
    return out;
  }
  const ok = CASELESS_OPTIONS.has(key) && typeof want === 'string' && typeof have === 'string'
    ? want.toLowerCase() === have.toLowerCase() : same(want, have);
  return ok ? [] : [`${path || 'options'}: dump ${repr(want)}, target ${repr(have ?? null)}`];
}
