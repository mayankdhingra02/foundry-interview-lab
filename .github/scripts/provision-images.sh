#!/usr/bin/env bash
# Sourced only by fresh disposable GitHub qualification jobs. Never learner admission.
provision_reviewed_image() {
  local source="$1" target="${2:-}" attempt
  if [[ "${GITHUB_ACTIONS:-}" != "true" || "${CI:-}" != "true" ]]; then
    echo 'Image provisioning requires an owned GitHub qualification job.' >&2
    return 64
  fi
  if [[ ! "$source" =~ ^public\.ecr\.aws/docker/library/(python|postgres|node|docker):[a-zA-Z0-9_.-]+@sha256:[a-f0-9]{64}$ ]]; then
    echo 'A reviewed immutable qualification image is required.' >&2
    return 64
  fi
  if [[ -n "$target" && "$target" != 'python:3.11-slim' && "$target" != 'postgres:16-alpine' ]]; then
    echo 'Unsupported local qualification tag.' >&2
    return 64
  fi
  if ! docker image inspect "$source" > /dev/null 2>&1; then
    for attempt in 1 2 3; do
      if docker pull "$source"; then break; fi
      if [[ "$attempt" == 3 ]]; then
        echo 'Pinned qualification image could not be provisioned after three attempts.' >&2
        return 1
      fi
      # Bounded backoff for registry throttling; never substitute another image.
      sleep "$((attempt * 10))"
    done
  fi
  if [[ -n "$target" ]]; then docker image tag "$source" "$target" || return 1; fi
  docker image inspect --format '{{json .RepoDigests}}' "$source"
}
