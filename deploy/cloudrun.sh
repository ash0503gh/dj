#!/usr/bin/env bash
# Deploy Pulse Pro to Google Cloud Run with a Cloud Storage bucket as the track library.
#
# Prerequisites (one time, done by you):
#   1. Install the gcloud CLI and log in:      gcloud auth login
#   2. A Google Cloud project with billing linked (the Google AI Pro $10/month credit applies to it)
#
# Usage (from the repo root):
#   PROJECT=<your-project-id> ./deploy/cloudrun.sh
# Optional: export GEMINI_API_KEY / JEV_API_KEY in this terminal first to store them in Secret Manager.
#
# Sizing: request-based billing (CPU only while serving requests), scale to zero, one instance,
# us-central1 so Cloud Run's free monthly quota applies.
set -euo pipefail

PROJECT=${PROJECT:?"Set PROJECT=<your Google Cloud project id>"}
REGION=${REGION:-us-central1}
SERVICE=${SERVICE:-pulse-pro-dj}
BUCKET=${BUCKET:-${PROJECT}-dj-library}
SA_NAME=${SA_NAME:-pulse-pro-run}
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

cd "$(dirname "$0")/.."
gcloud config set project "$PROJECT" >/dev/null

echo "==> Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com iam.googleapis.com

echo "==> Bucket gs://$BUCKET (same region as the service: no transfer charges)"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access
fi
# Keylocked renders are re-creatable: expire them after 30 days so the bucket stays small
LIFECYCLE=$(mktemp)
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30,"matchesPrefix":["stretch/"]}}]}' > "$LIFECYCLE"
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file="$LIFECYCLE"
rm -f "$LIFECYCLE"

echo "==> Service account $SA (read/write on the library bucket only)"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="Pulse Pro Cloud Run"
fi
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin" >/dev/null

echo "==> AI keys (only those exported in this terminal)"
SECRETS=()
for NAME in GEMINI_API_KEY JEV_API_KEY; do
  VALUE="${!NAME:-}"
  [ -z "$VALUE" ] && continue
  if gcloud secrets describe "$NAME" >/dev/null 2>&1; then
    printf '%s' "$VALUE" | gcloud secrets versions add "$NAME" --data-file=- >/dev/null
  else
    printf '%s' "$VALUE" | gcloud secrets create "$NAME" --replication-policy=automatic --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$NAME" \
    --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor" >/dev/null
  SECRETS+=("$NAME=$NAME:latest")
  echo "    $NAME stored in Secret Manager"
done
SECRET_FLAGS=()
[ ${#SECRETS[@]} -gt 0 ] && SECRET_FLAGS=(--update-secrets "$(IFS=,; echo "${SECRETS[*]}")")

echo "==> Building and deploying $SERVICE (Cloud Build uses the Dockerfile)"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA" \
  --cpu 2 --memory 4Gi \
  --concurrency 20 --timeout 900 \
  --min-instances 0 --max-instances 1 \
  --allow-unauthenticated \
  --set-env-vars "GCS_BUCKET=$BUCKET" \
  ${SECRET_FLAGS[@]+"${SECRET_FLAGS[@]}"}

echo "==> Live at: $(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
