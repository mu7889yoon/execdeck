# Contributing

Thanks for helping improve ExecDeck. Issues, documentation fixes, and focused pull requests are welcome.

## Before opening an issue

- Search existing issues for the same problem or proposal.
- Include the ExecDeck version or commit, OS, Docker version, Terraform version, and AWS Region when relevant.
- For bugs, include concise reproduction steps and sanitized logs. Never include credentials, session cookies, or private workshop data.

## Pull requests

- Keep each pull request focused and describe the user-visible change.
- Update the README or configuration examples when behavior changes.
- Do not include generated build output, Terraform state, credentials, or attendee data.
- Explain any AWS resource, permission, or cost changes.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development layout

- `slides/` contains the Slidev deck and browser workbench.
- `microvm/` contains the sandbox runtime and starter workspace.
- `control/` contains the AWS API and cleanup handlers.
- `infrastructure/` contains the Terraform stack.

Local preview uses Docker Compose from the repository root. Cloud changes should account for both the local container and Lambda MicroVM image paths.
