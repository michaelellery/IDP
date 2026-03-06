###############################################################################
# providers.tf — AWS Provider & Terraform Backend
###############################################################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "idp-terraform-state-430695043165"
    key            = "idp/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "idp-terraform-locks"
    encrypt        = true
    profile        = "idp-dev"
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project     = "idp"
      Environment = terraform.workspace
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
