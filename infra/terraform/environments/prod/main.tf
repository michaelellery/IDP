terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket  = "idp-terraform-state-prod"
    key     = "terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "idp-prod"

  default_tags {
    tags = {
      Project     = "IDP"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

variable "environment" {
  default = "prod"
}

# VPC
module "vpc" {
  source = "../../modules/vpc"
  environment = var.environment
}

# Aurora PostgreSQL
module "database" {
  source      = "../../modules/database"
  environment = var.environment
  vpc_id      = module.vpc.vpc_id
  subnet_ids  = module.vpc.private_subnet_ids
}

# S3 Buckets
module "storage" {
  source      = "../../modules/storage"
  environment = var.environment
}

# Step Functions + Lambda
module "processing" {
  source      = "../../modules/processing"
  environment = var.environment
  vpc_id      = module.vpc.vpc_id
  subnet_ids  = module.vpc.private_subnet_ids
}

# EventBridge
module "events" {
  source      = "../../modules/events"
  environment = var.environment
}
