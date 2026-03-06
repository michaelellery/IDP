###############################################################################
# variables.tf — All Configurable Parameters
###############################################################################

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "AWS CLI profile"
  type        = string
  default     = "idp-dev"
}

variable "project" {
  description = "Project name prefix"
  type        = string
  default     = "idp"
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDR blocks"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDR blocks"
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24"]
}

variable "availability_zones" {
  description = "Availability zones"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL engine version"
  type        = string
  default     = "16.4"
}

variable "aurora_database_name" {
  description = "Aurora database name"
  type        = string
  default     = "idp"
}

variable "aurora_master_username" {
  description = "Aurora master username"
  type        = string
  default     = "idpadmin"
}

variable "aurora_min_capacity" {
  description = "Aurora Serverless v2 minimum ACUs"
  type        = number
  default     = 0.5
}

variable "aurora_max_capacity" {
  description = "Aurora Serverless v2 maximum ACUs"
  type        = number
  default     = 4.0
}

variable "lambda_runtime" {
  description = "Lambda runtime"
  type        = string
  default     = "nodejs20.x"
}

variable "lambda_code_bucket" {
  description = "S3 bucket for Lambda deployment packages"
  type        = string
  default     = ""
}

variable "sfn_hitl_timeout_seconds" {
  description = "HITL queue wait timeout (seconds)"
  type        = number
  default     = 86400
}

variable "sfn_fraud_review_timeout_seconds" {
  description = "Fraud review queue wait timeout (seconds)"
  type        = number
  default     = 172800
}

variable "extraction_confidence_threshold" {
  description = "Extraction confidence threshold for HITL routing"
  type        = number
  default     = 0.85
}

variable "alarm_email" {
  description = "Email for CloudWatch alarm notifications"
  type        = string
  default     = ""
}

variable "environment_config" {
  description = "Per-workspace overrides"
  type = map(object({
    aurora_min_capacity = optional(number)
    aurora_max_capacity = optional(number)
  }))
  default = {
    dev = {
      aurora_min_capacity = 0.5
      aurora_max_capacity = 4.0
    }
    prod = {
      aurora_min_capacity = 2.0
      aurora_max_capacity = 16.0
    }
  }
}

locals {
  env         = terraform.workspace
  name_prefix = "${var.project}-${local.env}"
  account_id  = data.aws_caller_identity.current.account_id

  env_cfg = lookup(var.environment_config, local.env, {
    aurora_min_capacity = var.aurora_min_capacity
    aurora_max_capacity = var.aurora_max_capacity
  })
}
