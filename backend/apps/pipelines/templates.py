"""Pipeline templates shipped with the product. Original wording (DECISIONS M2.5), not another CRM's defaults.

Each template is a starting point: once created, a pipeline is an ordinary pipeline whose stages the
organization edits freely. ``sales`` is what a new organization starts with.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Template:
    key: str
    name: str
    description: str
    stages: tuple[tuple[str, str, int, str], ...]  # (name, kind, probability, colour)

    def stage_specs(self) -> list[dict[str, Any]]:
        return [{"name": n, "kind": k, "default_probability": p, "color_token": c} for n, k, p, c in self.stages]


TEMPLATES: dict[str, Template] = {
    t.key: t
    for t in (
        Template(
            "sales",
            "Sales pipeline",
            "For selling to a buyer who needs a first conversation, a proposal and agreed terms.",
            (
                ("Discovery", "open", 10, "slate"),
                ("Fit confirmed", "open", 25, "blue"),
                ("Proposal sent", "open", 50, "teal"),
                ("Terms agreed", "open", 75, "amber"),
                ("Won", "won", 100, "green"),
                ("Lost", "lost", 0, "red"),
            ),
        ),
        Template(
            "inbound",
            "Inbound enquiries",
            "For leads that arrive by themselves: respond fast, book a meeting, show the product.",
            (
                ("New enquiry", "open", 5, "slate"),
                ("Contacted", "open", 15, "blue"),
                ("Meeting booked", "open", 35, "purple"),
                ("Demo given", "open", 55, "teal"),
                ("Converted", "won", 100, "green"),
                ("Disqualified", "lost", 0, "red"),
            ),
        ),
        Template(
            "services",
            "Services engagements",
            "For projects that are scoped and quoted before work starts.",
            (
                ("Enquiry", "open", 10, "slate"),
                ("Scoping", "open", 30, "blue"),
                ("Quote issued", "open", 50, "teal"),
                ("Awaiting sign-off", "open", 75, "amber"),
                ("Engaged", "won", 100, "green"),
                ("Declined", "lost", 0, "red"),
            ),
        ),
        Template(
            "renewals",
            "Renewals",
            "For keeping existing customers: review usage, make the offer, confirm the renewal.",
            (
                ("Renewal due", "open", 40, "slate"),
                ("Usage review", "open", 55, "blue"),
                ("Offer sent", "open", 70, "teal"),
                ("Verbal yes", "open", 90, "amber"),
                ("Renewed", "won", 100, "green"),
                ("Churned", "lost", 0, "red"),
            ),
        ),
        Template(
            "partnerships",
            "Partnerships",
            "For resellers, referral partners and integrations: from introduction to a live partner.",
            (
                ("Introduction", "open", 10, "slate"),
                ("Mutual fit", "open", 30, "blue"),
                ("Pilot running", "open", 50, "purple"),
                ("Agreement drafted", "open", 75, "amber"),
                ("Partner live", "won", 100, "green"),
                ("Not pursued", "lost", 0, "red"),
            ),
        ),
    )
}
DEFAULT_TEMPLATE = "sales"
