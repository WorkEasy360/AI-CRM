# ---------------------------------------------------------------------------
# RDS PostgreSQL 16, Multi-AZ, encrypted, private data subnets.
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "this" {
  name        = "${local.name}-db"
  description = "${local.name} private data subnets"
  subnet_ids  = aws_subnet.data[*].id

  tags = { Name = "${local.name}-db" }
}

resource "aws_db_parameter_group" "this" {
  name        = "${local.name}-postgres16"
  family      = "postgres16"
  description = "${local.name}: TLS required, slow-query and lock logging, pg_stat_statements"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "pg_stat_statements.track"
    value = "all"
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name}-postgres16" }
}

# Enhanced monitoring role
data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "${local.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier = "${local.name}-postgres"

  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  db_name  = var.db_name
  username = "keel_admin"
  port     = 5432

  # Master credentials are generated and rotated by RDS in Secrets Manager.
  # The application never uses them (see secrets.tf, DATABASE_URL).
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.this.key_id

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.this.arn

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.this.name

  backup_retention_period  = var.db_backup_retention_days
  backup_window            = "19:30-20:30" # 01:00-02:00 IST
  maintenance_window       = "sun:20:30-sun:21:30"
  copy_tags_to_snapshot    = true
  delete_automated_backups = false

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-postgres-final"

  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  performance_insights_kms_key_id       = aws_kms_key.this.arn

  monitoring_interval = 60
  monitoring_role_arn = aws_iam_role.rds_monitoring.arn

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = false

  ca_cert_identifier = "rds-ca-rsa2048-g1"

  tags = { Name = "${local.name}-postgres" }
}

# ---------------------------------------------------------------------------
# RDS Proxy (optional). Enable once the connection budget approaches 60% of
# max_connections: tasks x GUNICORN_WORKERS x GUNICORN_THREADS + worker
# concurrency + beat. The proxy multiplexes pinned-free sessions and shields
# the instance from connection storms during deploys and autoscaling.
#
# The proxy authenticates with the RDS-managed master secret because it is the
# only credential Terraform knows about. For production hygiene add a second
# `auth` block pointing at a dedicated Secrets Manager secret for `crm_app`
# ({"username":"crm_app","password":"..."}) once that role exists, so app
# connections through the proxy never carry master privileges.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "rds_proxy_assume" {
  count = var.enable_rds_proxy ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  name               = "${local.name}-rds-proxy"
  assume_role_policy = data.aws_iam_policy_document.rds_proxy_assume[0].json
}

data "aws_iam_policy_document" "rds_proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.this.master_user_secret[0].secret_arn]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "rds_proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  name   = "read-db-secret"
  role   = aws_iam_role.rds_proxy[0].id
  policy = data.aws_iam_policy_document.rds_proxy[0].json
}

resource "aws_db_proxy" "this" {
  count = var.enable_rds_proxy ? 1 : 0

  name                   = "${local.name}-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.rds_proxy[0].arn
  vpc_subnet_ids         = aws_subnet.data[*].id
  vpc_security_group_ids = [aws_security_group.rds_proxy[0].id]
  require_tls            = true
  idle_client_timeout    = 1800
  debug_logging          = false

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_db_instance.this.master_user_secret[0].secret_arn
    description = "RDS-managed master credentials (add a crm_app secret here)"
  }

  tags = { Name = "${local.name}-proxy" }
}

resource "aws_db_proxy_default_target_group" "this" {
  count = var.enable_rds_proxy ? 1 : 0

  db_proxy_name = aws_db_proxy.this[0].name

  connection_pool_config {
    max_connections_percent      = 80
    max_idle_connections_percent = 40
    connection_borrow_timeout    = 30
  }
}

resource "aws_db_proxy_target" "this" {
  count = var.enable_rds_proxy ? 1 : 0

  db_proxy_name          = aws_db_proxy.this[0].name
  target_group_name      = aws_db_proxy_default_target_group.this[0].name
  db_instance_identifier = aws_db_instance.this.identifier
}
