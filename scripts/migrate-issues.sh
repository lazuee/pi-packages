#!/usr/bin/env bash
#
# Migrate GitHub Issues from individual repos to the pi-packages monorepo.
#
# Prerequisites:
#   - gh CLI authenticated
#   - The pi-packages repo must exist on GitHub
#
# What `gh issue transfer` preserves:
#   ✅ Title, body, comments, author, creation date
#   ✅ Original URL redirects to new location
#   ❌ Labels (must be re-created; applied after transfer)
#   ❌ Milestones, projects
#
# Usage:
#   ./scripts/migrate-issues.sh                    # dry run (default)
#   ./scripts/migrate-issues.sh --execute          # actually transfer
#   ./scripts/migrate-issues.sh --open-only        # dry run, open issues only
#   ./scripts/migrate-issues.sh --open-only --execute

set -euo pipefail

DEST_REPO="lazuee/pi-packages"  # Change if different

REPOS=(
  "lazuee/pi-autoformat"
  "lazuee/pi-github-tools"
  "lazuee/pi-permission-system"
  "lazuee/pi-subagents"
)

DRY_RUN=true
STATE_FLAG="--state all"

for arg in "$@"; do
  case "$arg" in
    --execute) DRY_RUN=false ;;
    --open-only) STATE_FLAG="--state open" ;;
  esac
done

# ── Step 1: Create package labels in the destination repo ──

echo "═══ Step 1: Ensure package labels exist in $DEST_REPO ═══"
for repo in "${REPOS[@]}"; do
  pkg=$(basename "$repo")
  label="pkg:$pkg"
  if $DRY_RUN; then
    echo "  [dry run] Would create label: $label"
  else
    gh label create "$label" \
      --repo "$DEST_REPO" \
      --description "Issues related to $pkg" \
      --color "0075ca" \
      2>/dev/null || echo "  Label $label already exists"
  fi
done

# Also ensure standard labels exist
for label in bug enhancement documentation "good first issue" duplicate invalid question wontfix; do
  if ! $DRY_RUN; then
    gh label create "$label" --repo "$DEST_REPO" 2>/dev/null || true
  fi
done

echo

# ── Step 2: Transfer issues ──

echo "═══ Step 2: Transfer issues ═══"
for repo in "${REPOS[@]}"; do
  pkg=$(basename "$repo")
  label="pkg:$pkg"

  echo "── $repo ──"

  # Get issue numbers
  # shellcheck disable=SC2086
  issues=$(gh issue list --repo "$repo" $STATE_FLAG --json number,title,state,labels --jq '.[] | "\(.number)\t\(.state)\t\(.title)\t\([.labels[].name] | join(","))"')

  if [ -z "$issues" ]; then
    echo "  No issues to transfer."
    continue
  fi

  while IFS=$'\t' read -r number state title old_labels; do
    echo "  #$number ($state): $title"

    if $DRY_RUN; then
      echo "    [dry run] Would transfer to $DEST_REPO and add label $label"
    else
      # Transfer the issue
      gh issue transfer "$number" "$DEST_REPO" --repo "$repo"

      # The transferred issue gets a new number in the destination repo.
      # gh issue transfer prints the new URL; we can also search for it.
      # Give GitHub a moment to process the transfer.
      sleep 1

      # Find the transferred issue by searching for the exact title
      new_number=$(gh issue list --repo "$DEST_REPO" --state all --search "\"$title\" in:title" --json number --jq '.[0].number' 2>/dev/null || echo "")

      if [ -n "$new_number" ]; then
        # Apply package label
        gh issue edit "$new_number" --repo "$DEST_REPO" --add-label "$label"
        echo "    → Transferred as #$new_number, labeled $label"
      else
        echo "    ⚠ Transferred but could not find new issue number to apply label"
      fi
    fi
  done <<< "$issues"

  echo
done

if $DRY_RUN; then
  echo "═══ Dry run complete. Run with --execute to transfer. ═══"
else
  echo "═══ Migration complete. ═══"
fi
