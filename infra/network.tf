# Lambda gives MicroVMs internet egress by default, including for an empty
# connector list. Route attendee egress through a VPC with no outbound route.
resource "aws_vpc" "isolated" {
  count              = var.deploy_workshop ? 1 : 0
  cidr_block         = "10.64.0.0/24"
  enable_dns_support = false
}

resource "aws_subnet" "isolated" {
  count      = var.deploy_workshop ? 1 : 0
  vpc_id     = aws_vpc.isolated[0].id
  cidr_block = "10.64.0.0/24"
}

resource "aws_security_group" "isolated" {
  count       = var.deploy_workshop ? 1 : 0
  name        = "${var.name}-isolated-egress"
  description = "Block all traffic on the MicroVM VPC egress connector"
  vpc_id      = aws_vpc.isolated[0].id
  ingress     = []
  egress      = []
}

resource "aws_iam_role" "egress_connector" {
  count = var.deploy_workshop ? 1 : 0
  name  = "${var.name}-network-connector"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "network-connectors.lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "egress_connector" {
  count = var.deploy_workshop ? 1 : 0
  role  = aws_iam_role.egress_connector[0].id
  name  = "connector-network-interfaces"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "ec2:CreateNetworkInterface"
      Resource = [
        "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:network-interface/*",
        aws_subnet.isolated[0].arn,
        aws_security_group.isolated[0].arn,
      ]
      }, {
      Effect   = "Allow"
      Action   = "ec2:CreateTags"
      Resource = "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:network-interface/*"
      Condition = {
        StringEquals = {
          "ec2:ManagedResourceOperator" = "network-connectors.lambda.amazonaws.com"
        }
      }
      }, {
      Effect   = "Allow"
      Action   = "ec2:DeleteNetworkInterface"
      Resource = "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:network-interface/*"
      Condition = {
        ArnEquals = { "ec2:Vpc" = aws_vpc.isolated[0].arn }
        StringEquals = {
          "ec2:ManagedResourceOperator" = "network-connectors.lambda.amazonaws.com"
        }
      }
      }, {
      Effect   = "Allow"
      Action   = ["ec2:DescribeNetworkInterfaces", "ec2:DescribeSecurityGroups", "ec2:DescribeSubnets", "ec2:DescribeVpcs"]
      Resource = "*"
    }]
  })
}

resource "aws_lambdacore_network_connector" "isolated" {
  count         = var.deploy_workshop ? 1 : 0
  name          = "${var.name}-isolated-egress"
  operator_role = aws_iam_role.egress_connector[0].arn

  configuration {
    vpc_egress_configuration {
      associated_compute_resource_types = ["MicroVm"]
      network_protocol                  = "IPv4"
      subnet_ids                        = [aws_subnet.isolated[0].id]
      security_group_ids                = [aws_security_group.isolated[0].id]
    }
  }

  depends_on = [aws_iam_role_policy.egress_connector]
}
