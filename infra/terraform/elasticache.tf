# ---------------------------------------------------------------------------
# ElastiCache Redis 7.1: cache/sessions/rate limits (db 0) and Celery broker
# (db 1). TLS + AUTH, encrypted at rest, Multi-AZ when more than one node.
# ---------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "this" {
  name        = "${local.name}-redis"
  description = "${local.name} private data subnets"
  subnet_ids  = aws_subnet.data[*].id

  tags = { Name = "${local.name}-redis" }
}

resource "aws_elasticache_parameter_group" "this" {
  name        = "${local.name}-redis7"
  family      = "redis7"
  description = "${local.name}: volatile-lru so broker keys are never evicted"

  # volatile-lru only evicts keys that carry a TTL. Celery broker queues and
  # result keys have no TTL and must survive memory pressure; only cache
  # entries (which always set a TTL) are eligible for eviction. If Redis fills
  # up with broker data, writes fail loudly (OOM) instead of silently
  # dropping tasks; the DatabaseMemoryUsagePercentage alarm fires first.
  parameter {
    name  = "maxmemory-policy"
    value = "volatile-lru"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name}-redis7" }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${local.name}-redis"
  description          = "${local.name} Redis (cache + Celery broker)"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = var.redis_num_nodes
  automatic_failover_enabled = var.redis_num_nodes > 1
  multi_az_enabled           = var.redis_num_nodes > 1

  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.redis.id]
  parameter_group_name = aws_elasticache_parameter_group.this.name

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.redis_auth.result
  auth_token_update_strategy = "ROTATE"

  snapshot_retention_limit = 1
  snapshot_window          = "20:00-21:00" # 01:30-02:30 IST
  maintenance_window       = "sun:21:30-sun:22:30"

  auto_minor_version_upgrade = true
  apply_immediately          = false

  tags = { Name = "${local.name}-redis" }
}

locals {
  # ElastiCache names member nodes <replication_group_id>-001, -002, ...
  # Built deterministically so alarms can be planned before the group exists.
  redis_member_cluster_ids = [
    for i in range(var.redis_num_nodes) : format("%s-redis-%03d", local.name, i + 1)
  ]
}
