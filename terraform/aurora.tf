###############################################################################
# aurora.tf — Aurora Serverless v2 PostgreSQL
###############################################################################

resource "aws_db_subnet_group" "main" {
  name       = local.name_prefix
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = local.name_prefix }
}

resource "aws_rds_cluster" "main" {
  cluster_identifier          = local.name_prefix
  engine                      = "aurora-postgresql"
  engine_mode                 = "provisioned"
  engine_version              = var.aurora_engine_version
  database_name               = var.aurora_database_name
  master_username             = var.aurora_master_username
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  storage_encrypted         = true
  deletion_protection       = local.env == "prod" ? true : false
  skip_final_snapshot       = local.env == "prod" ? false : true
  final_snapshot_identifier = local.env == "prod" ? "${local.name_prefix}-final" : null
  backup_retention_period   = local.env == "prod" ? 14 : 7
  preferred_backup_window   = "03:00-04:00"

  serverlessv2_scaling_configuration {
    min_capacity = coalesce(local.env_cfg.aurora_min_capacity, var.aurora_min_capacity)
    max_capacity = coalesce(local.env_cfg.aurora_max_capacity, var.aurora_max_capacity)
  }

  tags = { Name = local.name_prefix }
}

resource "aws_rds_cluster_instance" "main" {
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version
  tags               = { Name = "${local.name_prefix}-instance-1" }
}
