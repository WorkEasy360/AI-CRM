"""Scripted provider for tests and local development. Echoes enough of the prompt to assert on."""

from __future__ import annotations

import json
import re

from apps.ai.providers.base import LLMError, LLMRequest, LLMResponse


class FakeProvider:
    name = "fake"
    calls: list[LLMRequest] = []
    next_text: str | None = None
    fail_next: LLMError | None = None

    def complete(self, request: LLMRequest) -> LLMResponse:
        FakeProvider.calls.append(request)
        if FakeProvider.fail_next is not None:
            err, FakeProvider.fail_next = FakeProvider.fail_next, None
            raise err
        if FakeProvider.next_text is not None:
            text, FakeProvider.next_text = FakeProvider.next_text, None
        elif request.feature == "deal_summary":
            deal_name = re.search(r'name="([^"]*)"', request.user)
            text = json.dumps(
                {
                    "headline": f"{deal_name.group(1) if deal_name else 'The deal'} summary",
                    "value": "see deal",
                    "recent_activity": "Recent activity summarised from the timeline.",
                    "customer_concern": "None recorded.",
                    "next_action": "Follow up with the customer.",
                    "expected_close": "As recorded.",
                }
            )
        elif request.feature == "email_draft":
            text = json.dumps(
                {"subject": "Following up", "body": "Hi,\n\nThanks for your time. Draft body.\n\nBest regards"}
            )
        else:
            text = "Hi, just following up on our last conversation. Would you have time this week for a quick call?"
        return LLMResponse(
            text=text,
            model=request.model,
            input_tokens=max(1, len(request.system + request.user) // 4),
            output_tokens=max(1, len(text) // 4),
        )

    @classmethod
    def reset(cls) -> None:
        cls.calls = []
        cls.next_text = None
        cls.fail_next = None
