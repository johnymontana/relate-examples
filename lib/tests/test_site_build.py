"""site/build.mjs: the GitHub Pages site for the repo's browser examples.

Each test builds a fake repo in tmp_path (examples/<name>/site.json + a dist/) and runs
`node site/build.mjs --root <tmp> --out <dir>`:
- two examples are collected into <out>/<path>/ byte for byte, and the index lists both,
  sorted by path, with escaped text, beside an empty .nojekyll;
- a card shows `summary` and the example's `screenshot`, published under a name that carries
  its content; without them it shows `description` and no picture;
- an example's `build` runs in its directory unless --no-build or SITE_PREBUILT=1;
- every bad site.json, unsafe path, root-absolute or protocol-relative URL, missing or misplaced
  Content-Security-Policy <meta>, a directive a meta policy ignores, an uncovered connect origin,
  missing index.html, symlink, duplicate path and empty tree fails with a clear message and
  leaves no output;
- the output is deterministic;
- example 01's page and the index template carry the policy Pages cannot send as a header, and
  01's allows the measured HF Hub hosts and nothing broader.
Needs node on PATH (skips otherwise); no network.
"""

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BUILD = REPO / "site" / "build.mjs"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="node is not on PATH")

HF = ["https://huggingface.co", "https://*.hf.co"]
CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; "
       "connect-src 'self' https://huggingface.co https://*.hf.co; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; base-uri 'self'; object-src 'none'")


def page(body, csp=CSP, head=""):
    """An HTML page with the policy in a <meta> in its <head>, before any script."""
    meta = f'<meta http-equiv="Content-Security-Policy" content="{csp}">' if csp is not None else ""
    return f"<!doctype html><html><head>{meta}{head}</head><body>{body}</body></html>\n"


def site_json(path, title, *, connect=None, **extra):
    d = {
        "title": title,
        "description": f"{title}: an example <b>page</b> & more",
        "path": path,
        "build": "npm run build",
        "dist": "dist",
        "connect": HF if connect is None else connect,
        "requires": ["wasm", "browser"],
    }
    d.update(extra)
    return d


def write_example(root, name, site, files=None):
    ex = root / "examples" / name
    ex.mkdir(parents=True, exist_ok=True)
    (ex / "site.json").write_text(site if isinstance(site, str) else json.dumps(site, indent=2))
    if files is not None:
        for rel, content in files.items():
            f = ex / "dist" / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                f.write_bytes(content)
            else:
                f.write_text(content)
    return ex


def tree(tmp_path):
    root = tmp_path / "repo"
    (root / "examples").mkdir(parents=True)
    return root


GOOD_DIST = {
    "index.html": page("", head='<link rel="stylesheet" href="style.css"><script type="module" src="app.js"></script>'),
    "app.js": 'import { x } from "./lib.js";\nconst w = new Worker(new URL("worker.js", import.meta.url), { type: "module" });\n'
              '// fetch("/commented-out") is fine\nfetch(`https://huggingface.co/x/resolve/abc/config.json`);\n',
    "lib.js": "export const x = 1;\n",
    "worker.js": 'importScripts; const u = new URL("/fastino/m/resolve/r/model.safetensors", "https://huggingface.co");\n',
    "style.css": "body { background: url(assets/bg.png); }\n",
    "assets/v1/bg.png": bytes(range(256)),
}


#: what site/build.mjs copies from site/ next to index.html
SITE_STATIC = ["site.css", "favicon.svg", "relate-logo-navy.svg", "relate-logo-white.svg"]


def png(width, height, extra=b""):
    """The start of a PNG, enough for its size to be read: the signature and an IHDR chunk."""
    return (b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR"
            + width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00" + b"\x00" * 4 + extra)


def run(root, out, *args, env=None):
    e = dict(os.environ)
    e.pop("SITE_PREBUILT", None)
    e.update(env or {})
    return subprocess.run([NODE, str(BUILD), "--root", str(root), "--out", str(out), *args],
                          capture_output=True, text=True, env=e, timeout=120)


def snapshot(d):
    return {p.relative_to(d).as_posix(): p.read_bytes() for p in sorted(Path(d).rglob("*")) if p.is_file()}


def node_eval(code):
    """Run an ES module snippet with `B` bound to site/build.mjs's exports; return its JSON output."""
    js = f"const B = await import({json.dumps(BUILD.as_uri())});\n{code}"
    r = subprocess.run([NODE, "--input-type=module", "-e", js], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_two_examples_collected_and_listed(tmp_path):
    root = tree(tmp_path)
    # directory order and path order differ: the index follows `path`
    write_example(root, "40-zeta", site_json("b-second", "Second example"), GOOD_DIST)
    write_example(root, "39-alpha", site_json("a-first", "First example", connect=[],
                                              browser="Needs WebAssembly.", credits=["NVL 2.0.0 <by permission>"]),
                  {"index.html": page("<p>first</p>")})
    out = tmp_path / "out"
    r = run(root, out, "--no-build")
    assert r.returncode == 0, r.stderr
    got = snapshot(out)
    assert sorted(got) == sorted(["index.html", *SITE_STATIC, ".nojekyll", "a-first/index.html"]
                                 + [f"b-second/{k}" for k in GOOD_DIST])
    assert got[".nojekyll"] == b""
    for k, v in GOOD_DIST.items():
        assert got[f"b-second/{k}"] == (v if isinstance(v, bytes) else v.encode())
    index = got["index.html"].decode()
    assert index.index('href="a-first/"') < index.index('href="b-second/"')
    assert ">First example</a>" in index and ">Second example</a>" in index
    assert "an example &lt;b&gt;page&lt;/b&gt; &amp; more" in index and "<b>page" not in index
    assert "Needs WebAssembly." in index and "connects to this site only" in index
    assert "NVL 2.0.0 &lt;by permission&gt;" in index
    assert "<code>huggingface.co</code>, <code>*.hf.co</code>" in index
    assert "{{" not in index
    assert (REPO / "site" / "site.css").read_bytes() == got["site.css"]


def test_build_command_runs_unless_prebuilt(tmp_path):
    root = tree(tmp_path)
    make = ("node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});"
            "fs.writeFileSync('dist/index.html','<head><meta http-equiv=Content-Security-Policy content=object-src></head>"
            "<p>built in '+require('path').basename(process.cwd())+'</p>')\"")
    ex = write_example(root, "41-built", site_json("built", "Built", build=make))
    assert run(root, tmp_path / "pre", env={"SITE_PREBUILT": "1"}).returncode == 1  # no dist yet, build skipped
    assert not (ex / "dist").exists()
    r = run(root, tmp_path / "pre", "--no-build")
    assert r.returncode == 1 and "examples/41-built/dist does not exist: run \"" in r.stderr
    r = run(root, tmp_path / "out")
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "out" / "built" / "index.html").read_text().endswith("<p>built in 41-built</p>")
    failing = write_example(root, "42-broken", site_json("broken", "Broken", build="node -e \"process.exit(3)\""))
    r = run(root, tmp_path / "out2")
    assert r.returncode == 1 and 'examples/42-broken: "node -e "process.exit(3)"" exited 3' in r.stderr
    assert not (tmp_path / "out2").exists() and failing.exists()


def test_output_is_deterministic(tmp_path):
    root = tree(tmp_path)
    write_example(root, "40-zeta", site_json("b-second", "Second"), GOOD_DIST)
    write_example(root, "39-alpha", site_json("a-first", "First"), GOOD_DIST)
    assert run(root, tmp_path / "one", "--no-build").returncode == 0
    assert run(root, tmp_path / "two", "--no-build").returncode == 0
    assert snapshot(tmp_path / "one") == snapshot(tmp_path / "two")
    (tmp_path / "one" / "stale.txt").write_text("left over")  # a rebuild replaces the whole directory
    assert run(root, tmp_path / "one", "--no-build").returncode == 0
    assert snapshot(tmp_path / "one") == snapshot(tmp_path / "two")


@pytest.mark.parametrize("site, files, message", [
    ("{not json", GOOD_DIST, "examples/50-x/site.json: not valid JSON"),
    ({k: v for k, v in site_json("x", "X").items() if k != "requires"}, GOOD_DIST, 'missing field "requires"'),
    (site_json("x", "X", extra=1), GOOD_DIST, 'unknown field "extra"'),
    (site_json("x", "", ), GOOD_DIST, '"title" must be a non-empty string'),
    (site_json("../x", "X"), GOOD_DIST, '"path" must be one URL segment'),
    (site_json("a/b", "X"), GOOD_DIST, '"path" must be one URL segment'),
    (site_json("Upper", "X"), GOOD_DIST, '"path" must be one URL segment'),
    (site_json("-x", "X"), GOOD_DIST, '"path" must be one URL segment'),
    (site_json(".x", "X"), GOOD_DIST, '"path" must be one URL segment'),
    (site_json("x", "X", dist="../outside"), GOOD_DIST, '"dist" must be a relative path inside the example'),
    (site_json("x", "X", dist="/abs"), GOOD_DIST, '"dist" must be a relative path inside the example'),
    (site_json("x", "X", connect=["https://huggingface.co/path"]), GOOD_DIST, "is not an origin"),
    (site_json("x", "X", connect=["http://huggingface.co"]), GOOD_DIST, "is not an origin"),
    (site_json("x", "X", requires=["Wasm"]), GOOD_DIST, "is not an EXAMPLES_REQUIRE key"),
    (site_json("x", "X", summary=""), GOOD_DIST, '"summary" must be a non-empty string'),
    (site_json("x", "X", summary="s" * 241), GOOD_DIST, '"summary" is longer than 240 characters'),
    (site_json("x", "X", screenshot="../shot.png"), GOOD_DIST, '"screenshot" must be a relative path to a .png inside the example'),
    (site_json("x", "X", screenshot="shot.jpg"), GOOD_DIST, '"screenshot" must be a relative path to a .png inside the example'),
    (site_json("x", "X", screenshot="missing.png"), GOOD_DIST, "examples/50-x/missing.png does not exist"),
    (site_json("x", "X", credits=[]), GOOD_DIST, '"credits" must be a non-empty array'),
    (site_json("x", "X", connect=["https://evil.example"]), GOOD_DIST,
     "connect origin https://evil.example is not allowed by the connect-src of examples/50-x/dist/index.html"),
    (site_json("x", "X", connect=["https://hf.co"]), GOOD_DIST, "connect origin https://hf.co is not allowed"),
    (site_json("x", "X"), {**GOOD_DIST, "index.html": page("", head='<script type="module" src="/app.js"></script>')},
     'examples/50-x/dist/index.html:1: root-absolute URL "/app.js" (src=)'),
    (site_json("x", "X"), {**GOOD_DIST, "lib.js": 'export * from "/shared/lib.js";\n'},
     'examples/50-x/dist/lib.js:1: root-absolute URL "/shared/lib.js" (import ... from)'),
    (site_json("x", "X"), {**GOOD_DIST, "app.js": 'const w = new Worker("/worker.js");\n'},
     'root-absolute URL "/worker.js" (new Worker())'),
    (site_json("x", "X"), {**GOOD_DIST, "style.css": "a { background: url('//cdn.example/x.png') }"},
     'protocol-relative URL "//cdn.example/x.png" (url())'),
    (site_json("x", "X"), {**GOOD_DIST, "index.html": page("", head='<script type="importmap">{"imports": {"y": "/vendor/y.js"}}</script>')},
     'root-absolute URL "/vendor/y.js" (importmap)'),
    (site_json("x", "X"), {k: v for k, v in GOOD_DIST.items() if k != "index.html"},
     "examples/50-x/dist/index.html is missing"),
    (site_json("x", "X"), {**GOOD_DIST, "index.html": page("<p>x</p>", csp=None)},
     'examples/50-x/dist/index.html: no <meta http-equiv="Content-Security-Policy">'),
    (site_json("x", "X"), {**GOOD_DIST, "about.html": "<!doctype html><p>no policy</p>"},
     'examples/50-x/dist/about.html: no <meta http-equiv="Content-Security-Policy">'),
    (site_json("x", "X"), {**GOOD_DIST, "index.html": page("", csp=CSP + "; frame-ancestors 'none'")},
     '"frame-ancestors" is ignored in a <meta> policy'),
    (site_json("x", "X"), {**GOOD_DIST, "index.html": '<!doctype html><head><script src="a.js"></script>'
                           f'<meta http-equiv="Content-Security-Policy" content="{CSP}"></head>'},
     "the Content-Security-Policy <meta> must come before every <script>"),
    (site_json("x", "X"), {**GOOD_DIST, "index.html": '<!doctype html><head></head><body>'
                           f'<meta http-equiv="Content-Security-Policy" content="{CSP}"></body>'},
     "the Content-Security-Policy <meta> must be inside <head>"),
    (site_json("x", "X"), {**GOOD_DIST, "index.html": page("", head=f'<meta http-equiv="content-security-policy" content="{CSP}">')},
     "2 Content-Security-Policy <meta> elements; use one"),
])
def test_problems_fail_clearly(tmp_path, site, files, message):
    root = tree(tmp_path)
    write_example(root, "50-x", site, files)
    out = tmp_path / "out"
    out.mkdir()
    (out / "old.txt").write_text("from an earlier build")
    r = run(root, out, "--no-build")
    assert r.returncode == 1, r.stderr
    assert message in r.stderr, r.stderr
    assert "FAILED; no site was written" in r.stderr
    assert not out.exists()  # the stale build is gone too: nothing deployable is left behind


def test_cards_show_a_summary_and_a_screenshot(tmp_path):
    root = tree(tmp_path)
    shot = png(1280, 800, b"pixels")
    ex = write_example(root, "07-shot", site_json("07-shot", "With a picture", connect=[], summary="Short & <sweet>.",
                                                  screenshot="pics/card.png", credits=["A library"]),
                       {"index.html": page("<p>x</p>")})
    (ex / "pics").mkdir()
    (ex / "pics" / "card.png").write_bytes(shot)
    write_example(root, "08-plain", site_json("plain", "Without one", connect=[]), {"index.html": page("<p>y</p>")})
    out = tmp_path / "out"
    r = run(root, out, "--no-build")
    assert r.returncode == 0, r.stderr
    got = snapshot(out)
    # the picture is published under a name that carries its content, so a new one is a new URL
    name = f"shots/07-shot-{hashlib.sha256(shot).hexdigest()[:12]}.png"
    assert got[name] == shot and [k for k in got if k.startswith("shots/")] == [name]
    index = got["index.html"].decode()
    first, second = index.split('<li class="card">')[1:]
    assert f'<img src="{name}" width="1280" height="800" alt="" loading="lazy">' in first
    assert '<span class="number">07</span>' in first and ">With a picture</a>" in first
    # the summary is the card's text; the description moves behind the disclosure
    assert '<p class="summary">Short &amp; &lt;sweet&gt;.</p>' in first
    assert first.index("Short &amp;") < first.index("<details") < first.index("an example &lt;b&gt;page&lt;/b&gt;") < first.index("A library")
    # without either field: no picture, no number (the path has none), the description as the card's text
    assert "<img" not in second and 'class="number"' not in second
    assert '<p class="summary">Without one: an example &lt;b&gt;page&lt;/b&gt; &amp; more</p>' in second
    assert second.count("an example &lt;b&gt;page") == 1

    # a picture that is not a PNG, or is too large, fails the build
    (ex / "pics" / "card.png").write_bytes(b"GIF89a not a png at all, padded to be long enough")
    r = run(root, out, "--no-build")
    assert r.returncode == 1 and "examples/07-shot/pics/card.png is not a PNG" in r.stderr and not out.exists()
    (ex / "pics" / "card.png").write_bytes(png(10, 10, b"\x00" * 600_001))
    r = run(root, out, "--no-build")
    assert r.returncode == 1 and "a card's picture may be at most 600000" in r.stderr


def test_more_failures(tmp_path):
    root = tree(tmp_path)
    r = run(root, tmp_path / "out", "--no-build")
    assert r.returncode == 1 and "nothing to publish" in r.stderr

    write_example(root, "51-a", site_json("same", "A"), GOOD_DIST)
    write_example(root, "52-b", site_json("same", "B"), GOOD_DIST)
    r = run(root, tmp_path / "out", "--no-build")
    assert r.returncode == 1 and 'examples/52-b/site.json: "path" same is already used by examples/51-a/site.json' in r.stderr

    shutil.rmtree(root / "examples" / "52-b")
    os.symlink("/etc/hosts", root / "examples" / "51-a" / "dist" / "hosts")
    r = run(root, tmp_path / "out", "--no-build")
    assert r.returncode == 1 and "dist/hosts is a symlink" in r.stderr

    r = run(root, root, "--no-build")
    assert r.returncode == 1 and "refusing to use" in r.stderr
    r = run(root, root / "examples" / "51-a" / "dist", "--no-build")
    assert r.returncode == 1 and "refusing" in r.stderr
    r = subprocess.run([NODE, str(BUILD), "--bogus"], capture_output=True, text=True)
    assert r.returncode == 2 and "unknown argument --bogus" in r.stderr


def test_csp_without_connect_src_falls_back_to_default_src(tmp_path):
    root = tree(tmp_path)
    write_example(root, "50-x", site_json("x", "X", connect=["https://a.example", "https://b.example"]),
                  {**GOOD_DIST, "index.html": page("", csp="default-src 'self' https://a.example")})
    r = run(root, tmp_path / "out", "--no-build")
    assert r.returncode == 1
    assert "https://b.example is not allowed by the default-src" in r.stderr and "a.example is not" not in r.stderr
    # a policy restricting neither connect-src nor default-src does not restrict connections
    write_example(root, "50-x", site_json("x", "X", connect=["https://b.example"]),
                  {**GOOD_DIST, "index.html": page("", csp="object-src 'none'")})
    assert run(root, tmp_path / "out2", "--no-build").returncode == 0


def test_extensionless_files_are_published(tmp_path):
    """Pages serves a file whose name has no "." as it is (there is no trailing-slash rewrite of files)."""
    root = tree(tmp_path)
    write_example(root, "50-x", site_json("x", "X"), {**GOOD_DIST, "assets/v1/LICENSE": "text"})
    assert run(root, tmp_path / "out", "--no-build").returncode == 0
    assert (tmp_path / "out" / "x" / "assets" / "v1" / "LICENSE").read_text() == "text"


def test_meta_csp_parsing():
    got = node_eval("""
      console.log(JSON.stringify([
        B.metaCsp('<head><meta http-equiv="Content-Security-Policy" content="default-src \\'self\\'"></head><script></script>'),
        B.metaCsp("<head><meta content='a' http-equiv='content-security-policy'><!-- <meta http-equiv=Content-Security-Policy content=b> --></head>"),
        B.metaCsp('<p>none</p>'),
      ]));
    """)
    assert got == [[{"policy": "default-src 'self'", "inHead": True, "beforeScripts": True}],
                   [{"policy": "a", "inHead": True, "beforeScripts": True}], []]


def _meta_policy(html: str) -> dict:
    return node_eval(f"""
      const [m] = B.metaCsp({json.dumps(html)});
      console.log(JSON.stringify(Object.fromEntries(B.parseCsp(m.policy))));
    """)


def test_example_33_page_policy():
    """Pages cannot send headers, so 01's page carries the production policy itself, minus
    frame-ancestors (ignored in a <meta>), plus a referrer <meta>."""
    html = (REPO / "examples" / "01-wasm-extract" / "web" / "index.html").read_text()
    assert _meta_policy(html) == {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'wasm-unsafe-eval'"],
        "worker-src": ["'self'"],
        "connect-src": ["'self'", *HF],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "base-uri": ["'self'"],
        "object-src": ["'none'"],
    }
    assert '<meta name="referrer" content="strict-origin-when-cross-origin">' in html
    template = (REPO / "site" / "index.template.html").read_text()
    assert _meta_policy(template)["default-src"] == ["'self'"] and "connect-src" not in _meta_policy(template)


def test_csp_origin_matching():
    cases = {
        # measured on 2026-10-08 (site/README.md), and HF's documented regional hosts
        "https://huggingface.co": True,
        "https://us.aws.cdn.hf.co": True,
        "https://eu-west-3.aws.cdn.hf.co": True,
        "https://cdn-lfs-eu-1.hf.co": True,
        "https://transfer.xethub-eu.hf.co": True,
        "https://*.hf.co": True,
        "https://*.aws.cdn.hf.co": True,
        "https://hf.co": False,
        "https://huggingface.co:8443": False,
        "https://evilhf.co": False,
        "https://hf.co.evil.example": False,
        "https://*.huggingface.co": False,
        "wss://us.aws.cdn.hf.co": False,
    }
    got = node_eval(f"""
      const sources = ["'self'", "https://huggingface.co", "https://*.hf.co"];
      const cases = {json.dumps(list(cases))};
      console.log(JSON.stringify(Object.fromEntries(cases.map((o) => [o, B.cspAllows(sources, B.parseOrigin(o)) !== null]))));
    """)
    assert got == cases
    more = node_eval("""
      const o = B.parseOrigin("https://a.example");
      console.log(JSON.stringify([
        B.cspAllows(["https:"], o), B.cspAllows(["*"], o), B.cspAllows(["a.example"], o),
        B.cspAllows(["https://a.example:*"], o), B.cspAllows(["https://a.example/path/"], o),
        B.cspAllows(["https://a.example:444"], o), B.cspAllows(["'self'"], o), B.parseOrigin("https://*.co"),
      ]));
    """)
    assert more == ["https:", "*", "a.example", "https://a.example:*", None, None, None, None]
