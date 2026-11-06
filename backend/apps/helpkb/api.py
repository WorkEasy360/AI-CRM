"""Help knowledge base HTTP surface.

Member endpoints (any signed-in member: help describes the software, not customer data):
    GET  help/articles/                 list or search the guide (the Help Center)
    GET  help/articles/<slug>/          one article, structured for the answer card
    GET  help/suggestions/?page=/x      question chips for the page the member is on
    POST help/feedback/                 thumbs up/down (+ comment) on one of the caller's own answers

Admin endpoints (``ai.settings.manage``): the workspace's own articles and overrides, their history,
unanswered questions and the feedback report. Every row they touch is tenant-owned and read through
the tenant manager and RLS; global articles are read-only from here.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.db import transaction
from django.db.models import F, Q, Sum
from django.utils import timezone
from rest_framework import serializers
from rest_framework.exceptions import NotFound as NotFoundError
from rest_framework.response import Response

from apps.audit import service as audit
from apps.authz.catalogue import PERMISSIONS
from apps.core.api.request import ActorRequest
from apps.core.api.viewsets import TenantAPIView
from apps.core.concurrency import expected_version, save_with_version
from apps.core.exceptions import DomainError
from apps.helpkb import answer, parser, search, sync
from apps.helpkb.models import (
    ArticleStatus,
    HelpArticle,
    HelpArticleStat,
    HelpFeedback,
    OrgHelpArticle,
    OrgHelpArticleRevision,
    UnansweredQuestion,
    UnansweredStatus,
)

MEMBER = "org.view"
ADMIN = "ai.settings.manage"


def _summary(actor: Any, entry: search.Entry) -> dict[str, Any]:
    article = entry.article
    return {
        "id": article.id,
        "title": article.title,
        "question": article.question,
        "module": article.module,
        "route": article.route,
        "menu_path": article.menu_path,
        "permission_ok": search.permission_ok(actor, article),
        "source": entry.source,
    }


def _detail(actor: Any, entry: search.Entry) -> dict[str, Any]:
    return {
        "article": answer.article_card(actor, entry.article, source=entry.source),
        "summary": answer.summary_line(entry.article),
        "content": parser.structured(entry.article),
        "related": answer._related(actor, entry.article),
    }


class HelpArticleListView(TenantAPIView):
    permission_map = {"GET": MEMBER}
    throttle_scope = "search"

    def get(self, request: ActorRequest) -> Response:
        actor = request.actor
        query = str(request.query_params.get("q", ""))[:200].strip()
        module = str(request.query_params.get("module", ""))[:40]
        entries, _ = search.corpus(actor)
        if query:
            result = search.search(actor, query, limit=20)
            rows = [entries[m.slug] for m in result.matches if m.slug in entries]
        else:
            rows = sorted(
                entries.values(),
                key=lambda e: (
                    parser.MODULES.index(e.article.module) if e.article.module in parser.MODULES else 99,
                    e.article.title,
                ),
            )
        if module:
            rows = [e for e in rows if e.article.module == module]
        return Response({"modules": list(parser.MODULES), "results": [_summary(actor, e) for e in rows]})


class HelpArticleDetailView(TenantAPIView):
    permission_map = {"GET": MEMBER}
    throttle_scope = "search"

    def get(self, request: ActorRequest, slug: str = "") -> Response:
        entry = search.get(request.actor, slug)
        if entry is None:
            raise NotFoundError("Article not found.")
        return Response(_detail(request.actor, entry))


class HelpSuggestionsView(TenantAPIView):
    permission_map = {"GET": MEMBER}
    throttle_scope = "search"

    def get(self, request: ActorRequest) -> Response:
        from apps.assistant.orchestrator import _clean_page

        page = _clean_page(request.query_params.get("page", ""))
        return Response({"page": page, "suggestions": search.suggestions_for_page(request.actor, page)})


class FeedbackSerializer(serializers.Serializer):
    turn_id = serializers.UUIDField()
    rating = serializers.ChoiceField(choices=[1, -1])
    comment = serializers.CharField(required=False, allow_blank=True, max_length=1000, default="")


class HelpFeedbackView(TenantAPIView):
    """Rate one of the caller's own answers. Another member's turn id reads as not found."""

    permission_map = {"POST": "ai.assistant.use"}
    throttle_scope = "assistant"

    def post(self, request: ActorRequest) -> Response:
        from apps.assistant.models import ConversationTurn

        ser = FeedbackSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        actor = request.actor
        data = ser.validated_data
        turn = ConversationTurn.objects.filter(pk=data["turn_id"], conversation__membership=actor.membership).first()
        if turn is None:
            raise NotFoundError("Answer not found.")
        slug = turn.help_article
        with transaction.atomic():
            existing = HelpFeedback.objects.select_for_update().filter(membership=actor.membership, turn=turn).first()
            previous = existing.rating if existing else 0
            if existing:
                existing.rating, existing.comment = data["rating"], data["comment"]
                existing.save(update_fields=["rating", "comment", "updated_at"])
            else:
                HelpFeedback.objects.create(
                    membership=actor.membership,
                    turn=turn,
                    article_slug=slug,
                    question=turn.question,
                    rating=data["rating"],
                    comment=data["comment"],
                )
            if slug and previous != data["rating"]:
                stat, _ = HelpArticleStat.objects.get_or_create(article_slug=slug, day=timezone.now().date())
                delta = {"helpful": 0, "unhelpful": 0}
                delta["helpful" if data["rating"] == 1 else "unhelpful"] += 1
                if previous:
                    delta["helpful" if previous == 1 else "unhelpful"] -= 1
                HelpArticleStat.objects.filter(pk=stat.pk).update(
                    helpful=F("helpful") + delta["helpful"], unhelpful=F("unhelpful") + delta["unhelpful"]
                )
        return Response({"ok": True, "rating": data["rating"]})


# --------------------------------------------------------------------------- admin


def _validate_slug(value: str) -> str:
    if not parser.ID_RE.match(value or "") or len(value) > 80:
        raise serializers.ValidationError("Use lowercase letters, numbers and hyphens, e.g. lead-qualification.")
    return value


class ArticleWriteSerializer(serializers.Serializer):
    slug = serializers.CharField(max_length=80, required=False)
    title = serializers.CharField(max_length=160)
    question = serializers.CharField(max_length=200)
    module = serializers.ChoiceField(choices=list(parser.MODULES))
    keywords = serializers.ListField(child=serializers.CharField(max_length=60), max_length=20, default=list)
    route = serializers.CharField(max_length=200)
    menu_path = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")
    spotlight = serializers.CharField(max_length=120, required=False, allow_blank=True, default="")
    permission = serializers.CharField(max_length=64, required=False, allow_blank=True, default="")
    related = serializers.ListField(child=serializers.CharField(max_length=80), max_length=6, default=list)
    body = serializers.CharField(max_length=parser.MAX_BODY_CHARS)
    status = serializers.ChoiceField(choices=ArticleStatus.values, default=ArticleStatus.DRAFT)
    from_unanswered = serializers.UUIDField(required=False, allow_null=True)

    def validate_slug(self, value: str) -> str:
        return _validate_slug(value)

    def validate_keywords(self, value: list[str]) -> list[str]:
        if any("," in item or "[" in item or "]" in item for item in value):
            raise serializers.ValidationError("Keywords cannot contain commas or brackets.")
        return [item.strip() for item in value if item.strip()]

    def validate_related(self, value: list[str]) -> list[str]:
        return [_validate_slug(item) for item in value]

    def validate_permission(self, value: str) -> str:
        if value and value not in PERMISSIONS:
            raise serializers.ValidationError("Unknown permission.")
        return value

    def validate_route(self, value: str) -> str:
        if not parser.ROUTE_RE.match(value):
            raise serializers.ValidationError("Use an app path such as /contacts.")
        return value

    def to_article(self, slug: str) -> parser.Article:
        data = {**self.validated_data, "id": slug, "updated": timezone.now().date().isoformat()}
        article = parser.from_dict(data)
        problems = parser.validate(article)
        if problems:
            raise serializers.ValidationError({"body": problems})
        return article


def _org_row(slug: str) -> OrgHelpArticle | None:
    return OrgHelpArticle.objects.filter(slug=slug).first()


def _org_payload(row: OrgHelpArticle, *, overrides: bool) -> dict[str, Any]:
    return {
        **sync.to_article(row).as_dict(),
        "version": row.version,
        "source": "org",
        "overrides_global": overrides,
        "updated_at": row.updated_at,
    }


def _snapshot(row: OrgHelpArticle) -> dict[str, Any]:
    return sync.to_article(row).as_dict()


def _mark_answered(question_id: Any, slug: str) -> None:
    if question_id:
        UnansweredQuestion.objects.filter(pk=question_id).update(
            status=UnansweredStatus.ANSWERED, article_slug=slug, updated_at=timezone.now()
        )


class KBAdminArticlesView(TenantAPIView):
    permission_map = {"GET": ADMIN, "POST": ADMIN}

    def get(self, request: ActorRequest) -> Response:
        global_slugs = set(HelpArticle.objects.values_list("slug", flat=True))
        org_rows = list(OrgHelpArticle.objects.order_by("module", "title"))
        org_slugs = {row.slug for row in org_rows}
        return Response(
            {
                "workspace": [
                    {
                        "id": row.slug,
                        "title": row.title,
                        "module": row.module,
                        "status": row.status,
                        "version": row.version,
                        "overrides_global": row.slug in global_slugs,
                        "updated_at": row.updated_at,
                    }
                    for row in org_rows
                ],
                "global": [
                    {"id": slug, "title": title, "module": module, "customized": slug in org_slugs}
                    for slug, title, module in HelpArticle.objects.filter(status=ArticleStatus.PUBLISHED)
                    .order_by("module", "title")
                    .values_list("slug", "title", "module")
                ],
                "modules": list(parser.MODULES),
            }
        )

    def post(self, request: ActorRequest) -> Response:
        ser = ArticleWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        slug = ser.validated_data.get("slug") or ""
        if not slug:
            raise serializers.ValidationError({"slug": ["This field is required."]})
        if _org_row(slug) is not None:
            raise DomainError("An article with this id already exists.", code="duplicate_slug", status_code=409)
        article = ser.to_article(slug)
        with transaction.atomic():
            row = OrgHelpArticle(slug=slug, created_by=request.actor.membership, updated_by=request.actor.membership)
            sync.apply_fields(row, article)
            row.save()
            OrgHelpArticleRevision.objects.create(
                article=row, version=row.version, snapshot=_snapshot(row), edited_by=request.actor.membership
            )
            sync.reindex_org_article(row)
            _mark_answered(ser.validated_data.get("from_unanswered"), slug)
        audit.record(
            "helpkb.article_created",
            request=request._request,
            user=request.actor.user,
            resource_type="help_article",
            resource_id=row.pk,
            metadata={"slug": slug, "status": row.status},
        )
        overrides = HelpArticle.objects.filter(slug=slug).exists()
        return Response(_org_payload(row, overrides=overrides), status=201)


class KBAdminArticleView(TenantAPIView):
    permission_map = {"GET": ADMIN, "PUT": ADMIN, "DELETE": ADMIN}

    def get(self, request: ActorRequest, slug: str = "") -> Response:
        row = _org_row(slug)
        if row is not None:
            return Response(_org_payload(row, overrides=HelpArticle.objects.filter(slug=slug).exists()))
        global_row = HelpArticle.objects.filter(slug=slug).first()
        if global_row is None:
            raise NotFoundError("Article not found.")
        # A global article opened for editing: the starting point of a workspace override.
        return Response(
            {**sync.to_article(global_row).as_dict(), "version": 0, "source": "global", "overrides_global": False}
        )

    def put(self, request: ActorRequest, slug: str = "") -> Response:
        ser = ArticleWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        article = ser.to_article(slug)
        actor = request.actor
        row = _org_row(slug)
        with transaction.atomic():
            if row is None:
                # Customising a global article: the first save creates the workspace's override.
                if not HelpArticle.objects.filter(slug=slug).exists():
                    raise NotFoundError("Article not found.")
                row = OrgHelpArticle(slug=slug, created_by=actor.membership, updated_by=actor.membership)
                sync.apply_fields(row, article)
                row.save()
                action = "helpkb.article_overridden"
            else:
                expected = expected_version(request, request.data)
                sync.apply_fields(row, article)
                row.updated_by = actor.membership
                save_with_version(
                    row,
                    expected,
                    [
                        "title",
                        "question",
                        "module",
                        "keywords",
                        "route",
                        "menu_path",
                        "spotlight",
                        "permission",
                        "related",
                        "body",
                        "status",
                        "updated",
                        "content_hash",
                        "updated_by",
                    ],
                )
                action = "helpkb.article_updated"
            OrgHelpArticleRevision.objects.create(
                article=row, version=row.version, snapshot=_snapshot(row), edited_by=actor.membership
            )
            sync.reindex_org_article(row)
            _mark_answered(ser.validated_data.get("from_unanswered"), slug)
        audit.record(
            action,
            request=request._request,
            user=actor.user,
            resource_type="help_article",
            resource_id=row.pk,
            metadata={"slug": slug, "status": row.status, "version": row.version},
        )
        return Response(_org_payload(row, overrides=HelpArticle.objects.filter(slug=slug).exists()))

    def delete(self, request: ActorRequest, slug: str = "") -> Response:
        row = _org_row(slug)
        if row is None:
            raise NotFoundError("Article not found.")
        pk = row.pk
        row.delete()
        audit.record(
            "helpkb.article_deleted",
            request=request._request,
            user=request.actor.user,
            resource_type="help_article",
            resource_id=pk,
            metadata={"slug": slug},
        )
        return Response(status=204)


def _member_name(membership: Any) -> str:
    user = getattr(membership, "user", None)
    if user is None:
        return ""
    full = f"{getattr(user, 'first_name', '')} {getattr(user, 'last_name', '')}".strip()
    return full or getattr(user, "email", "")


class RestoreSerializer(serializers.Serializer):
    version = serializers.IntegerField(min_value=1)


class KBAdminRevisionsView(TenantAPIView):
    permission_map = {"GET": ADMIN, "POST": ADMIN}

    def get(self, request: ActorRequest, slug: str = "") -> Response:
        row = _org_row(slug)
        if row is None:
            return Response({"results": []})
        return Response(
            {
                "results": [
                    {
                        "version": rev.version,
                        "title": rev.snapshot.get("title", ""),
                        "status": rev.snapshot.get("status", ""),
                        "body": rev.snapshot.get("body", ""),
                        "edited_by": _member_name(rev.edited_by),
                        "created_at": rev.created_at,
                    }
                    for rev in row.revisions.select_related("edited_by__user").order_by("-version")[:50]
                ]
            }
        )

    def post(self, request: ActorRequest, slug: str = "") -> Response:
        """Restore an earlier version as a new version (history is never rewritten)."""
        ser = RestoreSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        row = _org_row(slug)
        revision = row.revisions.filter(version=ser.validated_data["version"]).first() if row else None
        if row is None or revision is None:
            raise NotFoundError("Version not found.")
        article = parser.from_dict({**revision.snapshot, "id": slug})
        with transaction.atomic():
            sync.apply_fields(row, article)
            row.updated_by = request.actor.membership
            save_with_version(
                row,
                None,
                [
                    "title",
                    "question",
                    "module",
                    "keywords",
                    "route",
                    "menu_path",
                    "spotlight",
                    "permission",
                    "related",
                    "body",
                    "status",
                    "updated",
                    "content_hash",
                    "updated_by",
                ],
            )
            OrgHelpArticleRevision.objects.create(
                article=row, version=row.version, snapshot=_snapshot(row), edited_by=request.actor.membership
            )
            sync.reindex_org_article(row)
        audit.record(
            "helpkb.article_restored",
            request=request._request,
            user=request.actor.user,
            resource_type="help_article",
            resource_id=row.pk,
            metadata={"slug": slug, "restored_version": revision.version, "version": row.version},
        )
        return Response(_org_payload(row, overrides=HelpArticle.objects.filter(slug=slug).exists()))


class UnansweredStatusSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=UnansweredStatus.values)


class KBUnansweredView(TenantAPIView):
    permission_map = {"GET": ADMIN, "PATCH": ADMIN}

    def get(self, request: ActorRequest, question_id: Any = None) -> Response:
        wanted = str(request.query_params.get("status", UnansweredStatus.OPEN))
        rows = UnansweredQuestion.objects.all()
        if wanted in UnansweredStatus.values:
            rows = rows.filter(status=wanted)
        rows = rows.order_by("-times_asked", "-last_asked_at")[:200]
        return Response(
            {
                "results": [
                    {
                        "id": str(row.pk),
                        "question": row.question,
                        "page": row.page,
                        "times_asked": row.times_asked,
                        "last_asked_at": row.last_asked_at,
                        "status": row.status,
                        "article_slug": row.article_slug,
                    }
                    for row in rows
                ]
            }
        )

    def patch(self, request: ActorRequest, question_id: Any = None) -> Response:
        ser = UnansweredStatusSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        updated = UnansweredQuestion.objects.filter(pk=question_id).update(
            status=ser.validated_data["status"], updated_at=timezone.now()
        )
        if not updated:
            raise NotFoundError("Question not found.")
        return Response({"id": str(question_id), "status": ser.validated_data["status"]})


class KBReportView(TenantAPIView):
    """Most-asked and lowest-rated articles, and the latest comments, over the last ``days`` days."""

    permission_map = {"GET": ADMIN}

    def get(self, request: ActorRequest) -> Response:
        try:
            days = max(1, min(int(request.query_params.get("days", 30)), 365))
        except (TypeError, ValueError):
            days = 30
        since = timezone.now().date() - dt.timedelta(days=days)
        rows = list(
            HelpArticleStat.objects.filter(day__gte=since)
            .values("article_slug")
            .annotate(total_asked=Sum("asked"), total_helpful=Sum("helpful"), total_unhelpful=Sum("unhelpful"))
        )
        entries, _ = search.corpus(request.actor)

        def item(row: Any) -> dict[str, Any]:
            entry = entries.get(row["article_slug"])
            rated = row["total_helpful"] + row["total_unhelpful"]
            return {
                "id": row["article_slug"],
                "title": entry.article.title if entry else row["article_slug"],
                "asked": row["total_asked"],
                "helpful": row["total_helpful"],
                "unhelpful": row["total_unhelpful"],
                "helpful_rate": round(row["total_helpful"] / rated, 2) if rated else None,
            }

        items = [item(row) for row in rows]
        most_asked = sorted(items, key=lambda i: -i["asked"])[:10]
        lowest = sorted((i for i in items if i["unhelpful"]), key=lambda i: (i["helpful_rate"] or 0, -i["unhelpful"]))[
            :10
        ]
        comments = (
            HelpFeedback.objects.filter(created_at__date__gte=since).filter(~Q(comment="")).order_by("-updated_at")[:20]
        )
        return Response(
            {
                "days": days,
                "most_asked": most_asked,
                "lowest_rated": lowest,
                "unanswered_open": UnansweredQuestion.objects.filter(status=UnansweredStatus.OPEN).count(),
                "recent_comments": [
                    {
                        "article_id": fb.article_slug,
                        "question": fb.question,
                        "rating": fb.rating,
                        "comment": fb.comment,
                        "created_at": fb.updated_at,
                    }
                    for fb in comments
                ],
            }
        )
