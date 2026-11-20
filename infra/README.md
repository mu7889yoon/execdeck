# Terraform deployment

The default configuration deploys the complete workshop, including its Lambda MicroVM image, in one apply.

```sh
terraform init
terraform apply
```

During planning, the `external` data source starts the Node 24 Docker build container. It installs the pinned npm dependencies, builds the Slidev site, and prepares the Lambda control package. Terraform archives the MicroVM Dockerfile and workspace, uploads that ZIP to S3, creates `aws_lambdamicrovms_image`, and waits for the image build before creating the attendee API and publishing the site. The `workshop_url` output is available when apply finishes.

## Variables

| Variable | Default | Description |
| --- | --- | --- |
| `aws_region` | `ap-northeast-1` | Region for all resources and the Lambda MicroVM image. |
| `name` | `execdeck` | Prefix for Terraform-managed names. S3 bucket names include random suffixes. |
| `workspace_root` | `/workspace` | Absolute path shown as the root of each participant file tree. |
| `max_sessions` | `30` | Maximum concurrent attendee workspaces. |
| `session_ttl_seconds` | `3600` | Maximum session age in seconds, from 600 to 28,800. |

Pass overrides with `-var`, a `.tfvars` file, or environment-specific configuration. Keep the same values for later updates and `terraform destroy`.

Lambda MicroVM image build logs are written to `/aws/lambda-microvms/<name>`. The default provider timeout for image creation is extended to 60 minutes because AWS builds the image asynchronously.

Attendee MicroVMs use a Lambda egress connector in a dedicated VPC. The subnet has no internet route and the connector's security group has no outbound rules. The image build uses AWS's default network so package installation in the Dockerfile can reach its registries.

The CloudFront default hostname requires AWS's default viewer TLS policy. To require a newer TLS policy, configure a custom domain and an ACM certificate in `us-east-1` before extending the distribution configuration.
