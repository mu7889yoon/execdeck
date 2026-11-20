---
name: execdeck-workshop
description: Create or update hands-on Slidev workshops in an ExecDeck repository. Use when planning slides, exercises, starter files, or workshop flow for ExecDeck.
---

# Create an ExecDeck workshop

Use this skill in a repository that contains `slides/slides.md` and `microvm/workspace/`.

## Workflow

1. Read `README.md`, `slides/workshop.config.json`, the current deck, and the starter files. Preserve useful existing material and ask for missing workshop goals only when they cannot be inferred from the request.
2. Turn the request into a short learning path: state the outcome, introduce only the concepts needed, give participants a runnable task, and show how they can tell whether it worked.
3. Edit `slides/slides.md` with Slidev Markdown. Use the default Slidev theme and the `workshop` layout. Avoid adding an event identity, speaker branding, or a custom visual theme unless the user specifically asks for it.
4. Put executable files in `microvm/workspace/`. Keep paths and commands consistent between the slides and workspace. Make the first command work in the supplied shell.
5. Select a workbench mode per slide using `workbench: integrated`, `editor`, `terminal`, or `hidden`. Omit it to use `defaultMode` from `slides/workshop.config.json`.
6. Adjust workbench proportions only when the workshop needs them. `workbenchHeight`, `explorerWidth`, and `editorHeight` are percentages.
7. Keep the attendee file tree rooted at `/workspace` by default. For a specialized environment, set `workspace_root` for Terraform and `EXECDECK_WORKSPACE_ROOT` for local Docker to the same absolute path.
8. Leave the reusable workbench, control plane, and Terraform plumbing intact unless the user requests a platform change. Do not put credentials, personal data, or event-specific branding in starter files.
9. Summarize the files changed and give the local preview command: `docker compose up --build`.

## Content guidance

- Prefer short explanations followed by a participant action.
- Make each exercise self-contained with a command, expected outcome, and recovery hint where useful.
- Keep cloud assumptions out of the learning steps when the same exercise can run in the local Docker workspace.
- Use filenames and terminal commands exactly as they appear in `microvm/workspace/`.
