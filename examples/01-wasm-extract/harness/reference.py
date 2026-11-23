#!/usr/bin/env python3
"""Record data/reference/gliner2-small.json: GLiNER2.5-small-v1 through Python gliner2 2.0.0.

This is the reference harness/model.mjs holds gliner-rs's WASM build to (G7, G10, G11):
the same texts, schema and threshold, run by the model's own Python package on torch (CPU,
one thread). The fixture is committed; nothing in a normal run needs Python.

    python3 -I examples/01-wasm-extract/harness/reference.py            # (re)write the fixture
    python3 -I examples/01-wasm-extract/harness/reference.py --check    # regenerate, compare, write nothing

Needs uv and the verified weights (scripts/fetch-gliner.sh small). The script runs in two stages:

1. Under any python3 (stdlib only): build or reuse a uv side env in .cache/gliner-ref-env/venv
   holding exactly REQUIREMENTS (Python 3.12, torch CPU), and a model directory
   .cache/gliner-ref-env/model-small@7132dc4/ that links the verified files and adds a
   patched tokenizer_config.json (G2: transformers 4.x cannot read the checkpoint's own, which
   lists extra_special_tokens as a list; the copy renames it additional_special_tokens and drops
   backend and is_local).
2. Re-run itself in that env with -I, HF_HUB_OFFLINE=1, TRANSFORMERS_OFFLINE=1 and a private
   HF_HOME, so nothing is downloaded and no user site or cache leaks in, and write the fixture.

Cases: four sentences of an earlier Financial Services sample, written for this example and kept
here as they were (data/samples/ccg/financial-services.md has since been rewritten; the fixture does
not follow it), under the schema the page asks for create-context-graph's Financial Services domain
(pipeline.modelSchema of data/ontologies/ogs/ccg/financial-services.ontology.yaml:
nine kinds by label text, five of them with a description and four bare, and twelve links between
their endpoints; harness/model.mjs checks it is still that schema). The four sentences one by one
and as one text, with entities and relations; an emoji offsets case; the second sentence with
entities only (one span, two labels); and 8 copies of the body, 736 tokens, entities only (G10).
Threshold 0.10, the inference cache's floor (D7), so the fixture holds every candidate the pipeline
stores. Offsets are code points. (Earlier recordings used edgextract's company_news ontology and
its 13_northwind golden note.)
"""
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXAMPLE = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(EXAMPLE))
OUT = os.path.join(EXAMPLE, "data", "reference", "gliner2-small.json")

REPO = "fastino/gliner2.5-small-v1"
REVISION = "7132dc4561c3f94563c6147e75ffa8ef34c4964a"
PIN = os.path.join(ROOT, "ci", "gliner2.5-small-v1.sha256")
WEIGHTS = os.path.join(ROOT, ".cache", "gliner", f"gliner2.5-small-v1@{REVISION[:7]}")
ENV = os.path.join(ROOT, ".cache", "gliner-ref-env")
VENV = os.path.join(ENV, "venv")
MODEL = os.path.join(ENV, f"model-small@{REVISION[:7]}")
PYTHON = "3.12"
# gliner2 2.0.0 and everything it resolved to on 2026-10-08, pinned so the fixture can be regenerated.
REQUIREMENTS = """\
gliner2==2.0.0
torch==2.14.1
transformers==4.57.6
tokenizers==0.22.2
huggingface-hub==0.36.2
safetensors==0.8.0
accelerate==1.15.0
peft==0.21.2
numpy==2.5.3
pydantic==2.14.0
pydantic-core==2.50.0
annotated-types==0.8.0
typing-extensions==4.16.0
typing-inspection==0.4.4
regex==2026.9.29
pyyaml==6.0.3
packaging==26.3
psutil==7.2.2
filelock==4.0.12
fsspec==2026.9.0
hf-xet==1.7.0
requests==2.34.2
urllib3==2.8.0
idna==3.20
certifi==2026.7.22
charset-normalizer==3.5.2
tqdm==4.70.1
jinja2==3.1.6
markupsafe==3.0.4
mpmath==1.3.0
sympy==1.14.0
networkx==3.7
setuptools==84.0.0
"""

# The kinds of create-context-graph's Financial Services as the page asks them (pipeline.modelSchema): a label
# text, with "<subtype> in <domain>" for a domain kind and nothing for a base kind (None: no description).
TYPES = {
    "person": None,
    "organization": None,
    "location": None,
    "event": None,
    "account": "financial account in financial services",
    "transaction": "financial transaction in financial services",
    "decision": "decision in financial services",
    "policy": "regulation in financial services",
    "security": "financial instrument in financial services",
}
# Its links as the page asks them: each link's phrase between its endpoints' label texts.
RELATIONS = ["person works for organization", "organization located at location", "person participated in event",
             "person owns account", "transaction transferred to account", "transaction transferred from account",
             "transaction involves security", "decision caused transaction", "decision applied policy policy",
             "decision advised by person", "person manages account", "decision preceded by decision"]
SENTENCES = [
    "Dana Whitlock works for Halvorsen Pryce Wealth, a wealth manager located in Edinburgh.",
    "Arjun Mehta owns account ACC-2207, and Colm Brady manages account ACC-2207 under a discretionary mandate signed in 2024.",
    "Rebalancing decision D-118 caused transaction TX-4471 and raised the fund's weight in the portfolio to 14 percent.",
    "The file shows that decision D-118 was advised by Colm Brady and approved by the investment committee on 19 September.",
]
BODY = " ".join(SENTENCES)
# The body's entities as the model names them (surface text, label), for the long-input count (G10).
GOLD = [["Dana Whitlock", "person"], ["Halvorsen Pryce Wealth", "organization"], ["Edinburgh", "location"],
        ["Arjun Mehta", "person"], ["ACC-2207", "account"], ["Colm Brady", "person"], ["TX-4471", "transaction"],
        ["decision D-118", "decision"]]
COPIES = 8
THRESHOLD = 0.1
CASES = (
    [{"id": f"sentence-{i + 1}", "text": s, "with_relations": True} for i, s in enumerate(SENTENCES)]
    + [{"id": "body", "text": BODY, "with_relations": True},
       {"id": "offsets", "text": "\U0001F680 Zoë Müller owns account ACC-2207.", "with_relations": True},
       {"id": "two-labels", "text": SENTENCES[1], "with_relations": False},
       {"id": "long", "text": " ".join([BODY] * COPIES), "with_relations": False,
        "repeat": {"unit": BODY, "copies": COPIES, "separator": " "}}]
)


def die(msg):
    sys.exit(f"reference.py: {msg}")


def say(msg):
    print(f"reference.py: {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- stage 1: env and model dir

def read_pin():
    pins = {}
    with open(PIN) as f:
        for line in f:
            sha, path = line.split()
            pins[path] = sha
    return pins


def ensure_weights():
    marker = os.path.join(WEIGHTS, ".verified")
    with open(PIN, "rb") as f:
        pin = f.read()
    try:
        with open(marker, "rb") as f:
            ok = f.read() == pin
    except OSError:
        ok = False
    if not ok:
        die(f"no verified weights in {os.path.relpath(WEIGHTS, ROOT)}; run scripts/fetch-gliner.sh small")


def patched_tokenizer_config(raw):
    cfg = json.loads(raw)
    cfg.pop("backend", None)
    cfg.pop("is_local", None)
    if isinstance(cfg.get("extra_special_tokens"), list):
        cfg["additional_special_tokens"] = cfg.pop("extra_special_tokens")
    return json.dumps(cfg, indent=2) + "\n"


def ensure_model_dir():
    """A fresh directory of links to the verified files plus the patched tokenizer_config.json."""
    tmp = MODEL + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(tmp, "encoder_config"))
    for f in ("config.json", "encoder_config/config.json", "model.safetensors", "tokenizer.json"):
        os.symlink(os.path.join(WEIGHTS, f), os.path.join(tmp, f))
    with open(os.path.join(WEIGHTS, "tokenizer_config.json")) as f:
        patched = patched_tokenizer_config(f.read())
    with open(os.path.join(tmp, "tokenizer_config.json"), "w") as f:
        f.write(patched)
    shutil.rmtree(MODEL, ignore_errors=True)
    os.rename(tmp, MODEL)


def ensure_env():
    """The uv side env with exactly REQUIREMENTS; rebuilt when the pins change."""
    stamp = os.path.join(VENV, ".requirements")
    want = f"python {PYTHON}\n{REQUIREMENTS}"
    py = os.path.join(VENV, "bin", "python")
    try:
        with open(stamp) as f:
            if f.read() == want and os.path.exists(py):
                return py
    except OSError:
        pass
    if not shutil.which("uv"):
        die("needs uv (https://docs.astral.sh/uv/) to build the reference env")
    say(f"building {os.path.relpath(VENV, ROOT)} (gliner2 2.0.0, torch CPU; a few minutes once)")
    shutil.rmtree(VENV, ignore_errors=True)
    os.makedirs(ENV, exist_ok=True)
    subprocess.run(["uv", "venv", "--quiet", "--python", PYTHON, VENV], check=True)
    req = os.path.join(ENV, "requirements.txt")
    with open(req, "w") as f:
        f.write(REQUIREMENTS)
    cmd = ["uv", "pip", "install", "--quiet", "--python", py, "-r", req]
    if sys.platform.startswith("linux"):
        cmd += ["--torch-backend", "cpu"]  # PyPI's Linux torch pulls CUDA
    subprocess.run(cmd, check=True)
    with open(stamp, "w") as f:
        f.write(want)
    return py


def outer(argv):
    check = "--check" in argv
    bad = [a for a in argv if a != "--check"]
    if bad:
        die(f"unknown argument {bad[0]}; usage: reference.py [--check]")
    ensure_weights()
    py = ensure_env()
    ensure_model_dir()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("PYTHON", "HF_", "TRANSFORMERS_"))}
    env.update(HF_HOME=os.path.join(ENV, "hf"), HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
               HF_HUB_DISABLE_TELEMETRY="1", PYTHONDONTWRITEBYTECODE="1", PYTHONHASHSEED="0",
               OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", TOKENIZERS_PARALLELISM="false")
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "gliner2-small.json")
        with open(os.path.join(tmp, "stderr.txt"), "w") as err:
            rc = subprocess.run([py, "-I", os.path.abspath(__file__), "--inner", MODEL, dest],
                                env=env, cwd=tmp, stderr=err).returncode
        if rc != 0:
            with open(os.path.join(tmp, "stderr.txt")) as f:
                sys.stderr.write(f.read()[-4000:])
            die(f"the reference run failed (exit {rc})")
        with open(dest, "rb") as f:
            new = f.read()
    try:
        with open(OUT, "rb") as f:
            old = f.read()
    except OSError:
        old = None
    rel = os.path.relpath(OUT, ROOT)
    if check:
        if new != old:
            die(f"a fresh recording differs from {rel}")
        say(f"{rel}: a fresh recording is byte-identical")
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT + ".tmp", "wb") as f:
        f.write(new)
    os.replace(OUT + ".tmp", OUT)
    say(f"{rel}: {'unchanged' if new == old else 'written'} ({len(new)} bytes)")


# ---------------------------------------------------------------- stage 2: the recording

def fmt(value, indent=0):
    """JSON with one line per row: lists of scalars (or of short lists) stay on one line."""
    pad = " " * indent
    def flat(v):
        return isinstance(v, list) and all(not isinstance(x, (dict, list)) or
                                           (isinstance(x, list) and all(not isinstance(y, (dict, list)) for y in x))
                                           for x in v)
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [f'{pad} {json.dumps(k, ensure_ascii=False)}: {fmt(v, indent + 1)}' for k, v in value.items()]
        return "{\n" + ",\n".join(items) + f"\n{pad}}}"
    if isinstance(value, list):
        if not value:
            return "[]"
        if all(flat(x) for x in value) and any(isinstance(x, list) for x in value):
            rows = [f"{pad} {json.dumps(x, ensure_ascii=False)}" for x in value]
            return "[\n" + ",\n".join(rows) + f"\n{pad}]"
        if flat(value):
            return json.dumps(value, ensure_ascii=False)
        rows = [f"{pad} {fmt(x, indent + 1)}" for x in value]
        return "[\n" + ",\n".join(rows) + f"\n{pad}]"
    return json.dumps(value, ensure_ascii=False)


def inner(model_dir, dest):
    import gliner2
    import tokenizers
    import torch
    import transformers
    from gliner2 import AutoExtractor
    from importlib import metadata

    torch.set_num_threads(1)
    model = AutoExtractor.from_pretrained(model_dir)
    model.eval()
    tok = tokenizers.Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
    lrank = {k: i for i, k in enumerate(TYPES)}
    rrank = {k: i for i, k in enumerate(RELATIONS)}
    cases = []
    for c in CASES:
        schema = model.create_schema().entities(dict(TYPES))
        if c["with_relations"]:
            schema = schema.relations(list(RELATIONS))
        with torch.no_grad():
            r = model.extract(c["text"], schema, threshold=THRESHOLD, include_confidence=True, include_spans=True)
        ents = [[label, it["start"], it["end"], it["text"], float(it["confidence"])]
                for label, items in r.get("entities", {}).items() for it in items]
        rels = []
        for phrase, items in (r.get("relation_extraction") or {}).items():
            for it in items:
                h, t = it["head"], it["tail"]
                if h["confidence"] != t["confidence"]:
                    raise SystemExit(f"{c['id']}: head and tail confidence differ for {phrase}; record both")
                rels.append([phrase, [h["start"], h["end"], h["text"]], [t["start"], t["end"], t["text"]],
                             float(h["confidence"])])
        for e in ents:
            if c["text"][e[1]:e[2]] != e[3]:
                raise SystemExit(f"{c['id']}: span {e[1]}:{e[2]} is not {e[3]!r} (offsets are not code points?)")
        ents.sort(key=lambda e: (e[1], e[2], lrank[e[0]], -e[4]))
        rels.sort(key=lambda x: (rrank[x[0]], x[1][0], x[1][1], x[2][0], x[2][1], -x[3]))
        case = {"id": c["id"], "text": c["text"], "with_relations": c["with_relations"],
                "tokens": len(tok.encode(c["text"], add_special_tokens=False).ids)}
        if "repeat" in c:
            case["repeat"] = c["repeat"]
        case["entities"] = ents
        case["relations"] = rels
        cases.append(case)
        print(f"{c['id']}: {len(ents)} entities, {len(rels)} relations", file=sys.stderr, flush=True)

    pins = read_pin()
    doc = {
        "generator": "examples/01-wasm-extract/harness/reference.py",
        "about": "GLiNER2.5-small-v1 through Python gliner2 on torch (CPU, 1 thread): the reference "
                 "harness/model.mjs compares gliner-rs's WASM build with. Offsets are Unicode code points; "
                 "a relation's score is its head's confidence, which equals its tail's.",
        "source": "texts from data/samples/ccg/financial-services.md (written for example 01); the schema is "
                  "pipeline.modelSchema of data/ontologies/ogs/ccg/financial-services.ontology.yaml "
                  "(create-context-graph 707b168, Apache-2.0)",
        "model": {"repo": REPO, "revision": REVISION,
                  "sha256": {k: pins[k] for k in ("model.safetensors", "tokenizer.json", "config.json",
                                                  "encoder_config/config.json")}},
        "tokenizer_config": "G2: a copy with extra_special_tokens renamed additional_special_tokens, "
                            "backend and is_local dropped (transformers 4.x)",
        "versions": {"python": platform.python_version(), "gliner2": metadata.version("gliner2"),
                     "torch": torch.__version__, "transformers": transformers.__version__,
                     "tokenizers": tokenizers.__version__},
        "host": f"{platform.system().lower()}-{platform.machine().lower()}",
        "torch_threads": torch.get_num_threads(),
        "options": {"threshold": THRESHOLD, "include_confidence": True, "include_spans": True,
                    "overlap": "the checkpoint's (flat)"},
        "schema": {"entities": [[k, v] for k, v in TYPES.items()], "relations": RELATIONS},
        "gold": GOLD,
        "cases": cases,
    }
    with open(dest, "w", encoding="utf-8") as f:
        f.write(fmt(doc) + "\n")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--inner"]:
        inner(sys.argv[2], sys.argv[3])
    else:
        outer(sys.argv[1:])
