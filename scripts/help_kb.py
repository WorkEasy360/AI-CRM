"""Help knowledge base tooling: build the backend bundle, check the KB against the app, run the eval.

    python scripts/help_kb.py build    # docs/help-kb -> backend bundle, feature-inventory.md, eval.json
    python scripts/help_kb.py check    # CI: articles valid, every app route documented, bundle fresh
    python scripts/help_kb.py eval     # retrieval accuracy over docs/help-kb/eval.json (lexical half)

No dependencies beyond the standard library and the backend's pure-Python ``apps.helpkb.parser`` /
``apps.helpkb.ranking`` modules, so CI runs it without a database or a Django setup.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "docs" / "help-kb"
ARTICLES = KB / "articles"
BUNDLE = ROOT / "backend" / "apps" / "helpkb" / "kb" / "articles.json"
APP_DIR = ROOT / "frontend" / "src" / "app"
CATALOGUE = ROOT / "backend" / "apps" / "authz" / "catalogue.py"

sys.path.insert(0, str(ROOT / "backend"))
from apps.helpkb import parser, ranking  # noqa: E402

# Routes that need no article of their own, and why. Anything not listed here and not covered fails CI.
EXEMPT_ROUTES = {
    "/": "redirects to the dashboard or the login page",
    "/reset-password/[key]": "opened from the emailed link; covered by getting-started-forgot-password",
    "/verify-email/[key]": "opened from the emailed link; covered by getting-started-verify-email",
    "/deals/[id]": "a deal's own page, opened from the Pipeline board; covered by deal-open-details",
}


def load_articles() -> tuple[list[parser.Article], list[str]]:
    articles: list[parser.Article] = []
    problems: list[str] = []
    for path in sorted(ARTICLES.glob("*.md")):
        try:
            article = parser.parse_article(path.read_text(encoding="utf-8"), source=path.name)
        except parser.ArticleError as exc:
            problems.extend(exc.problems)
            continue
        if article.id != path.stem:
            problems.append(f"{path.name}: id {article.id!r} does not match the file name")
        articles.append(article)
    return articles, problems


def bundle_text(articles: list[parser.Article]) -> str:
    data = {
        "version": 1,
        "count": len(articles),
        "articles": [a.as_dict() for a in sorted(articles, key=lambda a: a.id)],
    }
    return json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n"


def _is_redirect(page: Path) -> bool:
    """A page kept only so old links work (``redirect(...)`` and nothing to render) needs no article."""
    source = page.read_text(encoding="utf-8")
    return "redirect(" in source and "return" not in source


def app_routes() -> list[str]:
    """Every page route under frontend/src/app, with route groups like ``(app)`` removed."""
    routes = []
    for page in APP_DIR.rglob("page.tsx"):
        if _is_redirect(page):
            continue
        parts = [p for p in page.parent.relative_to(APP_DIR).parts if not (p.startswith("(") and p.endswith(")"))]
        routes.append("/" + "/".join(parts) if parts else "/")
    return sorted(set(routes))


def permissions() -> frozenset[str]:
    spec = importlib.util.spec_from_file_location("catalogue", CATALOGUE)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module.PERMISSIONS


def check(*, verbose: bool = True) -> list[str]:
    articles, problems = load_articles()
    ids = [a.id for a in articles]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    problems += [f"duplicate article id {i!r}" for i in duplicates]
    known = set(ids)
    perms = permissions()
    routes = app_routes()
    patterns = {route: re.compile("^" + re.sub(r"\\\[[^/]+?\\\]", "[^/]+", re.escape(route)) + "$") for route in routes}
    for article in articles:
        for rel in article.related:
            if rel not in known:
                problems.append(f"{article.id}: related id {rel!r} does not exist")
        if article.permission and article.permission not in perms:
            problems.append(f"{article.id}: unknown permission {article.permission!r}")
        if not any(p.match(article.path_only) for p in patterns.values()):
            problems.append(f"{article.id}: route {article.route!r} is not a page in frontend/src/app")
    covered = {a.path_only for a in articles}
    for route in routes:
        if route in EXEMPT_ROUTES:
            continue
        static = route.split("/[", 1)[0] or "/"
        if route in covered or ("[" in route and static in covered):
            continue
        problems.append(
            f"route {route} has no help article (add one in docs/help-kb/articles or exempt it in scripts/help_kb.py)"
        )
    if not problems:
        expected = bundle_text(articles)
        current = BUNDLE.read_text(encoding="utf-8") if BUNDLE.exists() else ""
        if current != expected:
            problems.append("backend/apps/helpkb/kb/articles.json is stale: run `python scripts/help_kb.py build`")
    eval_path = KB / "eval.json"
    if eval_path.exists():
        for item in json.loads(eval_path.read_text(encoding="utf-8")):
            if item.get("expected") is not None and item.get("expected") not in known:
                problems.append(f"eval question {item.get('q')!r} expects missing article {item.get('expected')!r}")
    if verbose:
        for problem in problems:
            print(f"ERROR {problem}")
        print(f"{len(articles)} articles, {len(routes)} routes, {len(problems)} problem(s)")
    return problems


def build() -> int:
    articles, problems = load_articles()
    if problems:
        for problem in problems:
            print(f"ERROR {problem}")
        return 1
    BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    BUNDLE.write_text(bundle_text(articles), encoding="utf-8", newline="\n")
    print(f"wrote {BUNDLE.relative_to(ROOT)} ({len(articles)} articles)")
    fragments = sorted((KB / "inventory").glob("*.md"))
    if fragments:
        header = (
            "# WorkEasy360 CRM: feature inventory\n\n"
            "Generated by `python scripts/help_kb.py build` from `docs/help-kb/inventory/*.md`. "
            "Every feature, where it lives, who may use it and the help article that explains it. "
            '"Not in product" lists things a user may ask about that the software does not do.\n\n'
        )
        body = "\n\n".join(f.read_text(encoding="utf-8").strip() for f in fragments)
        (KB / "feature-inventory.md").write_text(header + body + "\n", encoding="utf-8", newline="\n")
        print("wrote docs/help-kb/feature-inventory.md")
    evals = sorted((KB / "eval").glob("*.json"))
    if evals:
        merged = [item for f in evals for item in json.loads(f.read_text(encoding="utf-8"))]
        (KB / "eval.json").write_text(
            json.dumps(merged, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n"
        )
        print(f"wrote docs/help-kb/eval.json ({len(merged)} questions)")
    return 0


def run_eval(*, minimum: float, show: bool) -> int:
    articles, problems = load_articles()
    if problems:
        print("fix article problems first (python scripts/help_kb.py check)")
        return 1
    index = ranking.Index(
        ranking.Doc(
            id=a.id,
            title=a.title,
            question=a.question,
            keywords=a.keywords,
            menu_path=a.menu_path,
            spotlight=a.spotlight,
            body=a.body,
            route_path=a.path_only,
            module=a.module,
        )
        for a in articles
    )
    items = json.loads((KB / "eval.json").read_text(encoding="utf-8"))
    positives = [item for item in items if item.get("expected")]
    negatives = [item for item in items if not item.get("expected")]
    top1 = top3 = confident = 0
    by_lang: dict[str, list[int]] = {}
    misses = []
    for item in positives:
        hits = index.search(item["q"], page=item.get("page", ""), limit=3)
        ranked = [h.id for h in hits]
        accepted = {item["expected"], *item.get("also", [])}
        ok1 = bool(ranked) and ranked[0] in accepted
        top1 += ok1
        top3 += bool(accepted & set(ranked))
        confident += ok1 and ranking.is_confident(hits[0])
        stats = by_lang.setdefault(item.get("lang", "en"), [0, 0])
        stats[0] += ok1
        stats[1] += 1
        if not ok1:
            misses.append((item, ranked))
    declined = 0
    for item in negatives:
        hits = index.search(item["q"], page=item.get("page", ""), limit=1)
        if not (hits and ranking.is_confident(hits[0])):
            declined += 1
        else:
            misses.append((item, [hits[0].id]))
    total = len(positives)
    print(
        f"questions: {total}  top-1: {top1 / total:.1%}  top-3: {top3 / total:.1%}  answered confidently: {confident / total:.1%}"
    )
    for lang, (ok, n) in sorted(by_lang.items()):
        print(f"  {lang:9} top-1 {ok}/{n} ({ok / n:.0%})")
    if negatives:
        print(f"not in the guide: {declined}/{len(negatives)} correctly left unanswered")
    if show:
        for item, ranked in misses:
            print(
                f"  MISS [{item.get('lang')}] {item['q']!r} page={item.get('page', '')} expected={item.get('expected')} got={ranked}"
            )
    ok = top1 / total >= minimum and (not negatives or declined / len(negatives) >= minimum)
    return 0 if ok else 1


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    cli = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = cli.add_subparsers(dest="command", required=True)
    sub.add_parser("build")
    sub.add_parser("check")
    ev = sub.add_parser("eval")
    ev.add_argument("--min", type=float, default=0.9, help="fail below this top-1 accuracy")
    ev.add_argument("--misses", action="store_true", help="list the questions that missed")
    args = cli.parse_args()
    if args.command == "build":
        return build()
    if args.command == "check":
        return 1 if check() else 0
    return run_eval(minimum=args.min, show=args.misses)


if __name__ == "__main__":
    sys.exit(main())
