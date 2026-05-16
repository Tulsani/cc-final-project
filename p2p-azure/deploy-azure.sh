#!/bin/bash
# deploy-azure.sh
#
# Provisions all Azure infrastructure and deploys 3 peer Container Apps.
# Run once from the directory containing Dockerfile and index.js.
#
# Prerequisites:
#   az login
#   az extension add --name containerapp
#
# Required env vars before running:
#   export QUERY_API_URL=https://your-query-api-xxx.run.app
#   export QUERY_API_KEY=your-gcp-api-key
#
# Optional:
#   export PEER_API_KEY=some-secret     # auth for /task endpoints
#   export RESOURCE_GROUP=p2p-task-rg
#   export LOCATION=eastus
#   export ACR_NAME=p2ptaskregistry     # must be globally unique, lowercase, 5-50 chars
#   export COSMOS_ACCOUNT=p2ptaskcosmos # must be globally unique

set -euo pipefail

# Print every command as it runs — makes failures immediately visible
set -x

# ─── Variables ────────────────────────────────────────────────────────────────

RESOURCE_GROUP="${RESOURCE_GROUP:-p2p-task-rg}"
LOCATION="${LOCATION:-eastus}"
ACR_NAME="${ACR_NAME:-p2ptaskregistry}"
COSMOS_ACCOUNT="${COSMOS_ACCOUNT:-p2ptaskcosmos}"
ENVIRONMENT="p2p-env"
IDENTITY_NAME="p2p-peer-identity"

# Check required vars explicitly with a clear error message before doing anything
if [[ -z "${QUERY_API_URL:-}" ]]; then
  echo "ERROR: QUERY_API_URL is not set. Run: export QUERY_API_URL=https://your-query-api.run.app"
  exit 1
fi
if [[ -z "${QUERY_API_KEY:-}" ]]; then
  echo "ERROR: QUERY_API_KEY is not set. Run: export QUERY_API_KEY=your-key"
  exit 1
fi

PEER_API_KEY="${PEER_API_KEY:-}"

echo ""
echo "════════════════════════════════════════════════"
echo "  Azure P2P Peer Service — Deploying"
echo "  Resource group : $RESOURCE_GROUP ($LOCATION)"
echo "  QUERY_API_URL  : $QUERY_API_URL"
echo "  ACR            : $ACR_NAME"
echo "  Cosmos         : $COSMOS_ACCOUNT"
echo "════════════════════════════════════════════════"

# ─── 1. Resource group ────────────────────────────────────────────────────────

echo ""
echo "==> Resource group"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none
echo "    $RESOURCE_GROUP — ready"

# ─── 2. Azure Container Registry ─────────────────────────────────────────────

echo ""
echo "==> Container Registry: $ACR_NAME"
az acr create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$ACR_NAME" \
  --sku Basic \
  -o none

ACR_SERVER=$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)
IMAGE="$ACR_SERVER/p2p-peer-service:latest"

echo "    Building and pushing image..."
az acr build \
  --registry "$ACR_NAME" \
  --image "p2p-peer-service:latest" \
  --file Dockerfile \
  . \
  -o none

echo "    Image pushed: $IMAGE"

# ─── 3. Cosmos DB ─────────────────────────────────────────────────────────────

echo ""
echo "==> Cosmos DB account: $COSMOS_ACCOUNT"
az cosmosdb create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$COSMOS_ACCOUNT" \
  --kind GlobalDocumentDB \
  --default-consistency-level Session \
  --locations regionName="$LOCATION" failoverPriority=0 isZoneRedundant=false \
  -o none

az cosmosdb sql database create \
  --resource-group "$RESOURCE_GROUP" \
  --account-name "$COSMOS_ACCOUNT" \
  --name "p2p-tasks" \
  -o none

az cosmosdb sql container create \
  --resource-group "$RESOURCE_GROUP" \
  --account-name "$COSMOS_ACCOUNT" \
  --database-name "p2p-tasks" \
  --name "long-form-task-responses" \
  --partition-key-path "/id" \
  --throughput 400 \
  -o none

COSMOS_ENDPOINT=$(az cosmosdb show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$COSMOS_ACCOUNT" \
  --query documentEndpoint -o tsv)

echo "    Endpoint: $COSMOS_ENDPOINT"

# ─── 4. Container Apps Environment ───────────────────────────────────────────

echo ""
echo "==> Container Apps Environment: $ENVIRONMENT"
az containerapp env create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$ENVIRONMENT" \
  --location "$LOCATION" \
  -o none
echo "    Environment ready"

# ─── 5. Managed Identity + role assignments ───────────────────────────────────

echo ""
echo "==> Managed Identity: $IDENTITY_NAME"
az identity create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$IDENTITY_NAME" \
  -o none

IDENTITY_ID=$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$IDENTITY_NAME" \
  --query id -o tsv)

IDENTITY_CLIENT_ID=$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$IDENTITY_NAME" \
  --query clientId -o tsv)

IDENTITY_PRINCIPAL_ID=$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$IDENTITY_NAME" \
  --query principalId -o tsv)

COSMOS_RESOURCE_ID=$(az cosmosdb show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$COSMOS_ACCOUNT" \
  --query id -o tsv)

ACR_RESOURCE_ID=$(az acr show --name "$ACR_NAME" --query id -o tsv)

echo "    Granting Cosmos DB data contributor..."
az cosmosdb sql role assignment create \
  --resource-group "$RESOURCE_GROUP" \
  --account-name "$COSMOS_ACCOUNT" \
  --role-definition-id "00000000-0000-0000-0000-000000000002" \
  --principal-id "$IDENTITY_PRINCIPAL_ID" \
  --scope "$COSMOS_RESOURCE_ID" \
  -o none

echo "    Granting ACR pull..."
az role assignment create \
  --assignee "$IDENTITY_PRINCIPAL_ID" \
  --role AcrPull \
  --scope "$ACR_RESOURCE_ID" \
  -o none

echo "    Roles assigned"

# ─── Common flags ─────────────────────────────────────────────────────────────

BASE_ENV_VARS=(
  "TOTAL_PEERS=3"
  "QUERY_API_URL=$QUERY_API_URL"
  "QUERY_API_KEY=$QUERY_API_KEY"
  "PEER_API_KEY=$PEER_API_KEY"
  "COSMOS_ENDPOINT=$COSMOS_ENDPOINT"
  "COSMOS_DATABASE=p2p-tasks"
  "COSMOS_CONTAINER=long-form-task-responses"
)

COMMON_FLAGS=(
  --resource-group "$RESOURCE_GROUP"
  --environment "$ENVIRONMENT"
  --image "$IMAGE"
  --user-assigned-identity "$IDENTITY_ID"
  --registry-server "$ACR_SERVER"
  --registry-identity "$IDENTITY_ID"
  --cpu 0.5
  --memory 1.0Gi
  --min-replicas 1
  --max-replicas 1
  --ingress external
  --target-port 8080
)

# ─── 6. peer-0 (bootstrap) ────────────────────────────────────────────────────

echo ""
echo "==> Deploying peer-0 (bootstrap)"
az containerapp create \
  --name peer-0 \
  "${COMMON_FLAGS[@]}" \
  --env-vars \
    "${BASE_ENV_VARS[@]}" \
    "PEER_INDEX=0" \
    "IS_BOOTSTRAP=true" \
  -o none

PEER0_FQDN=$(az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name peer-0 \
  --query properties.configuration.ingress.fqdn -o tsv)

PEER0_URL="https://$PEER0_FQDN"
BOOTSTRAP_ADDR="/dns4/$PEER0_FQDN/tcp/443/wss"
echo "    $PEER0_URL"
echo "    bootstrap addr: $BOOTSTRAP_ADDR"

# ─── 7. peer-1 ────────────────────────────────────────────────────────────────

echo ""
echo "==> Deploying peer-1"
az containerapp create \
  --name peer-1 \
  "${COMMON_FLAGS[@]}" \
  --env-vars \
    "${BASE_ENV_VARS[@]}" \
    "PEER_INDEX=1" \
    "IS_BOOTSTRAP=false" \
    "BOOTSTRAP_ADDR=$BOOTSTRAP_ADDR" \
  -o none

PEER1_FQDN=$(az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name peer-1 \
  --query properties.configuration.ingress.fqdn -o tsv)

echo "    https://$PEER1_FQDN"

# ─── 8. peer-2 ────────────────────────────────────────────────────────────────

echo ""
echo "==> Deploying peer-2"
az containerapp create \
  --name peer-2 \
  "${COMMON_FLAGS[@]}" \
  --env-vars \
    "${BASE_ENV_VARS[@]}" \
    "PEER_INDEX=2" \
    "IS_BOOTSTRAP=false" \
    "BOOTSTRAP_ADDR=$BOOTSTRAP_ADDR" \
  -o none

PEER2_FQDN=$(az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name peer-2 \
  --query properties.configuration.ingress.fqdn -o tsv)

echo "    https://$PEER2_FQDN"

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Deployment complete"
echo "════════════════════════════════════════════════════════"
echo ""
echo "  peer-0 (bootstrap)  https://$PEER0_FQDN"
echo "  peer-1              https://$PEER1_FQDN"
echo "  peer-2              https://$PEER2_FQDN"
echo ""
echo "  Cosmos DB           $COSMOS_ENDPOINT"
echo "  Database            p2p-tasks / long-form-task-responses"
echo ""
echo "  ── Submit a task ──────────────────────────────────────"
echo ""
echo "  curl -X POST $PEER0_URL/task \\"
echo "    -H 'Content-Type: application/json' \\"
if [[ -n "$PEER_API_KEY" ]]; then
echo "    -H 'Authorization: Bearer $PEER_API_KEY' \\"
fi
echo "    -d '{\"query\":\"Summarise all Q3 contracts\",\"filters\":{\"clientId\":\"acme\",\"fileType\":\"contract\"}}'"
echo ""
echo "  ── Poll for result ────────────────────────────────────"
echo ""
echo "  curl $PEER0_URL/task/<taskId>"
echo ""
echo "  ── Health checks ──────────────────────────────────────"
echo ""
echo "  curl $PEER0_URL/health"
echo "  curl https://$PEER1_FQDN/health"
echo "  curl https://$PEER2_FQDN/health"
echo ""
echo "════════════════════════════════════════════════════════"