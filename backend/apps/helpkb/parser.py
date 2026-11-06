"""Help article format: parse, validate and take apart one Markdown article.

Pure Python on purpose (no Django import): the backend sync, the CI check in ``scripts/help_kb.py``
and the retrieval eval all read articles through this one module, so "the article is valid" means the
same thing in every place that decides it.

The format is documented in ``docs/help-kb/README.md``. Frontmatter is a deliberately small subset of
YAML -- one ``key: value`` per line, inline ``[a, b]`` lists -- so no YAML dependency is needed and an
article cannot smuggle in anchors, tags or multi-line values.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

MODULES: tuple[str, ...] = (
    "Getting Started",
    "Dashboard",
    "Pipeline",
    "Contacts",
    "Activities",
    "AI Assistant",
    "Helpdesk",
    "Products",
    "Settings",
    "FAQ",
)
SECTION_ORDER: tuple[str, ...] = ("Overview", "Before you start", "Steps", "Result", "Tips", "Troubleshooting")
REQUIRED_SECTIONS: tuple[str, ...] = ("Overview", "Steps", "Result")
REQUIRED_KEYS: tuple[str, ...] = ("id", "title", "question", "module", "keywords", "route", "updated")
LIST_KEYS: frozenset[str] = frozenset({"keywords", "related"})
KNOWN_KEYS: frozenset[str] = frozenset({*REQUIRED_KEYS, "menu_path", "spotlight", "permission", "related", "status"})

MAX_BODY_CHARS = 20_000
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ROUTE_RE = re.compile(r"^/[A-Za-z0-9/_\-]*(?:\?[A-Za-z0-9_=&\-]*)?(?:#[A-Za-z0-9_\-]*)?$")
_FRONTMATTER = re.compile(r"\A---\s*\n(?P<head>.*?)\n---\s*\n(?P<body>.*)\Z", re.DOTALL)
_HEADING = re.compile(r"^##\s+(?P<title>.+?)\s*$", re.MULTILINE)
_NUMBERED = re.compile(r"^\s*\d+[.)]\s+(?P<text>.+)$")
_BULLET = re.compile(r"^\s*[-*]\s+(?P<text>.+)$")
_BOLD = re.compile(r"\*\*(?P<label>[^*\n]{1,120})\*\*")


class ArticleError(ValueError):
    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass
class Article:
    id: str
    title: str
    question: str
    module: str
    route: str
    body: str
    keywords: list[str] = field(default_factory=list)
    related: list[str] = field(default_factory=list)
    menu_path: str = ""
    spotlight: str = ""
    permission: str = ""
    updated: str = ""
    status: str = "published"

    @property
    def sections(self) -> dict[str, str]:
        return split_sections(self.body)

    @property
    def path_only(self) -> str:
        return route_path(self.route)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "question": self.question,
            "module": self.module,
            "route": self.route,
            "menu_path": self.menu_path,
            "spotlight": self.spotlight,
            "permission": self.permission,
            "keywords": list(self.keywords),
            "related": list(self.related),
            "updated": self.updated,
            "status": self.status,
            "body": self.body,
        }


def from_dict(data: dict) -> Article:
    """An ``Article`` from ``Article.as_dict()`` output (the bundle) or an API payload. Not validated."""
    text = {key: str(data.get(key) or "") for key in ("id", "title", "question", "module", "route", "body")}
    extra = {key: str(data.get(key) or "") for key in ("menu_path", "spotlight", "permission", "updated")}
    return Article(
        **text,
        **extra,
        keywords=[str(item) for item in (data.get("keywords") or [])],
        related=[str(item) for item in (data.get("related") or [])],
        status=str(data.get("status") or "published"),
    )


def route_path(route: str) -> str:
    """``/activities?tab=calendar#x`` -> ``/activities``."""
    return re.split(r"[?#]", route or "", maxsplit=1)[0].rstrip("/") or "/"


def _parse_value(key: str, raw: str) -> str | list[str]:
    raw = raw.strip()
    if key in LIST_KEYS:
        if not (raw.startswith("[") and raw.endswith("]")):
            raise ValueError(f"{key} must be an inline list like [a, b]")
        inner = raw[1:-1].strip()
        return (
            [item.strip().strip('"').strip("'").strip() for item in inner.split(",") if item.strip()] if inner else []
        )
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        raw = raw[1:-1]
    return raw


def parse_frontmatter(head: str) -> dict[str, str | list[str]]:
    meta: dict[str, str | list[str]] = {}
    problems: list[str] = []
    for number, line in enumerate(head.splitlines(), start=1):
        if not line.strip():
            continue
        key, sep, value = line.partition(":")
        key = key.strip()
        if not sep or not key or " " in key:
            problems.append(f"frontmatter line {number} is not 'key: value'")
            continue
        if key in meta:
            problems.append(f"frontmatter key {key!r} appears twice")
            continue
        try:
            meta[key] = _parse_value(key, value)
        except ValueError as exc:
            problems.append(str(exc))
    if problems:
        raise ArticleError(problems)
    return meta


def parse_article(text: str, *, source: str = "") -> Article:
    """Parse and validate. Raises ``ArticleError`` listing every problem found, not just the first."""
    text = (text or "").replace("\r\n", "\n").replace("﻿", "")
    match = _FRONTMATTER.match(text)
    if not match:
        raise ArticleError([f"{source or 'article'}: missing '---' frontmatter block"])
    meta = parse_frontmatter(match.group("head"))
    article = Article(
        id=str(meta.get("id", "")),
        title=str(meta.get("title", "")),
        question=str(meta.get("question", "")),
        module=str(meta.get("module", "")),
        route=str(meta.get("route", "")),
        body=match.group("body").strip() + "\n",
        keywords=list(meta.get("keywords") or []),
        related=list(meta.get("related") or []),
        menu_path=str(meta.get("menu_path", "")),
        spotlight=str(meta.get("spotlight", "")),
        permission=str(meta.get("permission", "")),
        updated=str(meta.get("updated", "")),
        status=str(meta.get("status", "published")) or "published",
    )
    problems = validate(article, meta_keys=set(meta))
    if problems:
        raise ArticleError([f"{source}: {p}" if source else p for p in problems])
    return article


def validate(article: Article, *, meta_keys: set[str] | None = None) -> list[str]:
    problems: list[str] = []
    keys = meta_keys if meta_keys is not None else set(KNOWN_KEYS)
    for key in REQUIRED_KEYS:
        if key not in keys or not getattr(article, key):
            problems.append(f"missing required frontmatter '{key}'")
    for key in keys - KNOWN_KEYS:
        problems.append(f"unknown frontmatter key '{key}'")
    if article.id and not ID_RE.match(article.id):
        problems.append(f"id {article.id!r} is not kebab-case")
    if article.module and article.module not in MODULES:
        problems.append(f"module {article.module!r} is not one of {', '.join(MODULES)}")
    if article.route and not ROUTE_RE.match(article.route):
        problems.append(f"route {article.route!r} is not an app path")
    if article.status not in {"published", "draft"}:
        problems.append("status must be published or draft")
    if len(article.title) > 160 or len(article.question) > 200:
        problems.append("title/question too long")
    if len(article.body) > MAX_BODY_CHARS:
        problems.append("body is too long")
    sections = split_sections(article.body)
    for name in REQUIRED_SECTIONS:
        if not sections.get(name, "").strip():
            problems.append(f"missing '## {name}' section")
    unknown = [name for name in sections if name not in SECTION_ORDER]
    if unknown:
        problems.append(f"unknown section(s): {', '.join(unknown)}")
    order = [name for name in sections if name in SECTION_ORDER]
    if order != sorted(order, key=SECTION_ORDER.index):
        problems.append("sections are out of order")
    if sections.get("Steps") and not steps(sections["Steps"]):
        problems.append("'## Steps' has no numbered steps")
    if "<" in article.body and re.search(r"<\s*/?\s*[a-zA-Z]", article.body):
        problems.append("HTML is not allowed in articles")
    return problems


def split_sections(body: str) -> dict[str, str]:
    """``## Heading`` -> its text, in document order. Text before the first heading is dropped."""
    out: dict[str, str] = {}
    matches = list(_HEADING.finditer(body or ""))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        out[match.group("title").strip()] = body[match.end() : end].strip()
    return out


def steps(text: str) -> list[str]:
    return [m.group("text").strip() for line in (text or "").splitlines() if (m := _NUMBERED.match(line))]


def bullets(text: str) -> list[str]:
    return [m.group("text").strip() for line in (text or "").splitlines() if (m := _BULLET.match(line))]


def labels(text: str) -> set[str]:
    """Every **bold** UI label in ``text``, case-folded and whitespace-normalised."""
    return {normalise_label(m.group("label")) for m in _BOLD.finditer(text or "")}


def normalise_label(label: str) -> str:
    return re.sub(r"\s+", " ", label).strip().casefold()


def structured(article: Article) -> dict:
    """The article as the answer card shows it: steps as a list, bullets as lists."""
    sections = article.sections
    return {
        "overview": sections.get("Overview", ""),
        "before_you_start": bullets(sections.get("Before you start", ""))
        or _lines(sections.get("Before you start", "")),
        "steps": steps(sections.get("Steps", "")),
        "result": sections.get("Result", ""),
        "tips": bullets(sections.get("Tips", "")),
        "troubleshooting": bullets(sections.get("Troubleshooting", "")),
    }


def _lines(text: str) -> list[str]:
    return [line.strip() for line in (text or "").splitlines() if line.strip()]


def render(meta: Article) -> str:
    """Serialise back to the on-disk format (used by the admin editor's "download" and by tests)."""
    lines = ["---"]
    for key in ("id", "title", "question", "module"):
        lines.append(f"{key}: {getattr(meta, key)}")
    lines.append(f"keywords: [{', '.join(meta.keywords)}]")
    lines.append(f"route: {meta.route}")
    for key in ("menu_path", "spotlight", "permission"):
        if getattr(meta, key):
            lines.append(f"{key}: {getattr(meta, key)}")
    lines.append(f"related: [{', '.join(meta.related)}]")
    lines.append(f"updated: {meta.updated}")
    if meta.status != "published":
        lines.append(f"status: {meta.status}")
    lines.append("---")
    return "\n".join(lines) + "\n\n" + meta.body.strip() + "\n"
