variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }

resource "aws_db_subnet_group" "main" {
  name       = "idp-${var.environment}"
  subnet_ids = var.subnet_ids

  tags = { Name = "idp-${var.environment}" }
}

resource "aws_security_group" "rds_sg" {
  name_prefix = "idp-${var.environment}-rds-"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  tags = { Name = "idp-${var.environment}-rds" }
}

resource "aws_rds_cluster" "main" {
  cluster_identifier = "idp-${var.environment}"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = "16.1"
  database_name      = "idp"
  master_username    = "idpadmin"
  master_password    = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds_sg.id]

  storage_encrypted = true
  deletion_protection = var.environment == "prod"

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = var.environment == "prod" ? 16 : 4
  }

  tags = { Name = "idp-${var.environment}" }
}

resource "aws_rds_cluster_instance" "main" {
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version
}

variable "db_password" {
  type      = string
  sensitive = true
}

output "cluster_endpoint" { value = aws_rds_cluster.main.endpoint }
output "cluster_reader_endpoint" { value = aws_rds_cluster.main.reader_endpoint }
output "database_name" { value = aws_rds_cluster.main.database_name }
