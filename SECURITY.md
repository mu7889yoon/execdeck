# Security policy

## Supported versions

Only the latest version on the default branch is currently supported.

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues. Use GitHub's private vulnerability reporting from the repository **Security** tab when available. Otherwise, contact the repository maintainer privately through the contact details on their GitHub profile.

Include the affected component, impact, and a way to reproduce the issue. Please allow time for a fix before publishing details.

## Deployment guidance

Cloud workshop links are public by default, and attendees can execute commands inside their own MicroVM. Keep workshop files free of secrets, set a session limit appropriate for your event, and destroy cloud resources after use. Local Docker mode is intended for trusted participants and should remain bound to localhost.
