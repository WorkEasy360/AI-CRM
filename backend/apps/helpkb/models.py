"""Help knowledge base: the product guide WorkEasy AI answers "how do I..." questions from.

Two kinds of article, deliberately in different tables:

``HelpArticle`` / ``HelpChunk`` -- **global**, one copy for every workspace.
    The product guide itself, written in ``docs/help-kb/articles`` and synced into these tables on
    ``migrate`` (``apps.helpkb.sync``). It describes the software, not any customer, so it carries no
    organization and no tenant data. No API writes it: workspaces read it, the repository owns it.

``OrgHelpArticle`` / ``OrgHelpChunk`` / ``OrgHelpArticleRevision`` -- **tenant-owned**, under RLS.
    A workspace's own articles ("How we qualify leads here") and its overrides of a global article,
    edited from Settings -> AI Assistant -> Knowledge Base without a deploy. An org article with the
    same slug as a global one replaces it for that workspace only.

Feedback, unanswered questions and per-article counters are tenant-owned too: what one workspace
asks is never visible to another.
"""

from __future__ import annotations

from typing import ClassVar

from django.db import models
from pgvector.django import VectorField

from apps.core.models import TenantModel, TimestampedModel
from apps.rag.models import EMBEDDING_DIM


class ArticleStatus(models.TextChoices):
    PUBLISHED = "published", "Published"
    DRAFT = "draft", "Draft"


class ArticleFields(models.Model):
    """The article itself. Mirrors the Markdown frontmatter in ``apps.helpkb.parser``."""

    slug = models.CharField(max_length=80)
    title = models.CharField(max_length=160)
    question = models.CharField(max_length=200)
    module = models.CharField(max_length=32)
    keywords = models.JSONField(default=list, blank=True)
    route = models.CharField(max_length=200)
    menu_path = models.CharField(max_length=300, blank=True)
    spotlight = models.CharField(max_length=120, blank=True)
    permission = models.CharField(max_length=64, blank=True)
    related = models.JSONField(default=list, blank=True)
    body = models.TextField()
    status = models.CharField(max_length=12, choices=ArticleStatus.choices, default=ArticleStatus.PUBLISHED)
    content_hash = models.CharField(max_length=64)
    updated = models.CharField(max_length=10, blank=True)

    class Meta:
        abstract = True


class ChunkFields(models.Model):
    position = models.PositiveSmallIntegerField(default=0)
    section = models.CharField(max_length=40)
    content = models.TextField()
    embedding = VectorField(dimensions=EMBEDDING_DIM, null=True, blank=True)
    embedding_model = models.CharField(max_length=64, blank=True)

    class Meta:
        abstract = True


class HelpArticle(TimestampedModel, ArticleFields):
    """A global product-guide article, synced from the repository."""

    class Meta:
        constraints = [models.UniqueConstraint(fields=["slug"], name="uniq_help_article_slug")]
        ordering = ["module", "title"]

    def __str__(self) -> str:
        return self.slug


class HelpChunk(TimestampedModel, ChunkFields):
    """One section of a global article, embedded for semantic retrieval."""

    article = models.ForeignKey(HelpArticle, on_delete=models.CASCADE, related_name="chunks")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["article", "position"], name="uniq_help_chunk_position")]

    def __str__(self) -> str:
        return f"{self.article_id}#{self.position}"


class OrgHelpArticle(TenantModel, ArticleFields):
    """A workspace's own article, or its override of the global article with the same slug."""

    version = models.PositiveIntegerField(default=1)
    created_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    updated_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        constraints = [models.UniqueConstraint(fields=["organization", "slug"], name="uniq_org_help_article_slug")]
        ordering = ["module", "title"]

    def __str__(self) -> str:
        return self.slug


class OrgHelpChunk(TenantModel, ChunkFields):
    article = models.ForeignKey(OrgHelpArticle, on_delete=models.CASCADE, related_name="chunks")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["article", "position"], name="uniq_org_help_chunk_position")]

    def __str__(self) -> str:
        return f"{self.article_id}#{self.position}"


class OrgHelpArticleRevision(TenantModel):
    """Every saved version of an org article, for history and restore."""

    article = models.ForeignKey(OrgHelpArticle, on_delete=models.CASCADE, related_name="revisions")
    version = models.PositiveIntegerField()
    snapshot = models.JSONField()
    edited_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        constraints = [models.UniqueConstraint(fields=["article", "version"], name="uniq_org_help_revision_version")]
        ordering = ["-version"]


class HelpFeedback(TenantModel):
    """A thumbs up or down on one help answer, with an optional comment. One per member per answer."""

    OWNER_FIELD: ClassVar[str | None] = "membership"

    membership = models.ForeignKey("accounts.Membership", on_delete=models.CASCADE, related_name="+")
    turn = models.ForeignKey(
        "assistant.ConversationTurn", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    article_slug = models.CharField(max_length=80, blank=True)
    question = models.CharField(max_length=1000, blank=True)
    rating = models.SmallIntegerField()  # +1 or -1
    comment = models.CharField(max_length=1000, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "membership", "turn"], name="uniq_help_feedback_turn"),
            models.CheckConstraint(condition=models.Q(rating__in=[1, -1]), name="help_feedback_rating_pm1"),
        ]
        indexes = [models.Index(fields=["organization", "article_slug"], name="helpfb_org_article_idx")]


class UnansweredStatus(models.TextChoices):
    OPEN = "open", "Open"
    ANSWERED = "answered", "Answered"
    DISMISSED = "dismissed", "Dismissed"


class UnansweredQuestion(TenantModel):
    """A "how do I" question the knowledge base had no article for. Repeats are counted, not duplicated."""

    question = models.CharField(max_length=1000)
    fingerprint = models.CharField(max_length=64)
    page = models.CharField(max_length=200, blank=True)
    times_asked = models.PositiveIntegerField(default=1)
    last_asked_at = models.DateTimeField()
    status = models.CharField(max_length=12, choices=UnansweredStatus.choices, default=UnansweredStatus.OPEN)
    article_slug = models.CharField(max_length=80, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "fingerprint"], name="uniq_help_unanswered_fingerprint")
        ]
        indexes = [models.Index(fields=["organization", "status", "-last_asked_at"], name="helpun_org_status_idx")]


class HelpArticleStat(TenantModel):
    """Daily per-article counters: how often an article answered a question, and how it was rated."""

    article_slug = models.CharField(max_length=80)
    day = models.DateField()
    asked = models.PositiveIntegerField(default=0)
    helpful = models.PositiveIntegerField(default=0)
    unhelpful = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "article_slug", "day"], name="uniq_help_stat_day")
        ]
