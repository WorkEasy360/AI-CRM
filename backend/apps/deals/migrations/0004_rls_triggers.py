"""RLS on every deals table, append-only stage history, stage/pipeline consistency, search vector."""

from django.db import migrations

from apps.core.rls import append_only_trigger, enable_rls
from apps.core.search import search_vector_trigger

STAGE_CONSISTENCY_FORWARD = """
CREATE OR REPLACE FUNCTION deals_deal_stage_matches_pipeline() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pipelines_pipelinestage s
        WHERE s.id = NEW.stage_id AND s.pipeline_id = NEW.pipeline_id AND s.organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'deal stage % does not belong to pipeline %', NEW.stage_id, NEW.pipeline_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS deals_deal_stage_matches_pipeline_trg ON deals_deal;
CREATE TRIGGER deals_deal_stage_matches_pipeline_trg BEFORE INSERT OR UPDATE OF stage_id, pipeline_id ON deals_deal
    FOR EACH ROW EXECUTE FUNCTION deals_deal_stage_matches_pipeline();
"""
STAGE_CONSISTENCY_BACKWARD = """
DROP TRIGGER IF EXISTS deals_deal_stage_matches_pipeline_trg ON deals_deal;
DROP FUNCTION IF EXISTS deals_deal_stage_matches_pipeline();
"""


class Migration(migrations.Migration):
    dependencies = [("deals", "0003_initial"), ("pipelines", "0002_rls")]

    operations = [
        enable_rls("deals_deal"),
        enable_rls("deals_dealstagehistory"),
        enable_rls("deals_dealproduct"),
        enable_rls("deals_dealcontact"),
        append_only_trigger("deals_dealstagehistory"),
        migrations.RunSQL(STAGE_CONSISTENCY_FORWARD, reverse_sql=STAGE_CONSISTENCY_BACKWARD),
        search_vector_trigger("deals_deal", {"A": ["name"], "C": ["description", "lost_reason"]}),
    ]
