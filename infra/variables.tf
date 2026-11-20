variable "aws_region" {
  description = "AWS region for the control plane and MicroVM image. Lambda MicroVMs must be available here."
  type        = string
  default     = "ap-northeast-1"
}

variable "name" {
  description = "Prefix for workshop resources."
  type        = string
  default     = "execdeck"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,39}$", var.name))
    error_message = "name must be 3-40 lowercase letters, numbers, or hyphens and start with a letter."
  }
}

variable "workspace_root" {
  description = "Absolute path used as the root of each attendee's editable workspace."
  type        = string
  default     = "/workspace"
  validation {
    condition     = startswith(var.workspace_root, "/") && var.workspace_root != "/" && !contains(split("/", var.workspace_root), "..")
    error_message = "workspace_root must be an absolute path below the filesystem root and cannot contain '..'."
  }
}

variable "deploy_workshop" {
  description = "Create the workshop image and deploy the full workshop stack during terraform apply."
  type        = bool
  default     = true
}

variable "max_sessions" {
  description = "Maximum number of simultaneous attendee MicroVMs."
  type        = number
  default     = 30
  validation {
    condition     = var.max_sessions >= 1 && var.max_sessions <= 100
    error_message = "max_sessions must be between 1 and 100."
  }
}

variable "session_ttl_seconds" {
  description = "Maximum attendee session lifetime; MicroVMs are terminated by the scheduled reaper."
  type        = number
  default     = 3600
  validation {
    condition     = var.session_ttl_seconds >= 600 && var.session_ttl_seconds <= 28800
    error_message = "session_ttl_seconds must be between 600 and 28800."
  }
}
