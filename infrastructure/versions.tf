terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Application = var.name
      ManagedBy   = "Terraform"
      Purpose     = "ExecDeck-Workshop"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
