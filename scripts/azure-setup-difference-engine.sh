#!/bin/bash
# ============================================================================
# The Difference Engine — Azure Cloud Shell Setup Script
# ============================================================================
# Run this in Azure Portal Cloud Shell (Bash).
# Creates: Resource Group, Storage Account (with containers), Function App
# (Consumption plan, Windows, Node 22), and configures all environment variables.
#
# Third-party keys (Qdrant, OpenAI) are created blank — fill them in after.
# ============================================================================

# ── Customise these ──────────────────────────────────────────────────────────
RESOURCE_GROUP="rg-difference-engine"
LOCATION="ukwest"
STORAGE_ACCOUNT="stdiffengine$(openssl rand -hex 3)"   # must be globally unique
FUNCTION_APP="func-difference-engine"                   # must be globally unique
# If the function app name is taken, append a short suffix:
# FUNCTION_APP="func-difference-engine-$(openssl rand -hex 2)"

# Container names (match the ENGINE_* defaults in the code)
RAW_CONTAINER="engine-raw"
WIKI_CONTAINER="engine-wiki"
SCHEMA_CONTAINER="engine-schemas"
RULES_CONTAINER="engine-rules"
RDF_CONTAINER="engine-rdf"

# ── 1. Resource Group ────────────────────────────────────────────────────────
echo "==> Creating resource group: $RESOURCE_GROUP in $LOCATION"
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION"

# ── 2. Storage Account ──────────────────────────────────────────────────────
echo "==> Creating storage account: $STORAGE_ACCOUNT"
az storage account create \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false

# Get the connection string (used for containers and function app config)
STORAGE_CONNECTION_STRING=$(az storage account show-connection-string \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --query connectionString \
  --output tsv)

echo "==> Storage connection string retrieved"

# ── 3. Blob Containers ──────────────────────────────────────────────────────
echo "==> Creating blob containers"
for CONTAINER in "$RAW_CONTAINER" "$WIKI_CONTAINER" "$SCHEMA_CONTAINER" "$RULES_CONTAINER" "$RDF_CONTAINER"; do
  echo "    - $CONTAINER"
  az storage container create \
    --name "$CONTAINER" \
    --connection-string "$STORAGE_CONNECTION_STRING" \
    --public-access off
done

# ── 4. Function App (Consumption plan, Windows, Node 22) ────────────────────
echo "==> Creating function app: $FUNCTION_APP (Consumption, Windows, Node 22)"
az functionapp create \
  --name "$FUNCTION_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --consumption-plan-location "$LOCATION" \
  --storage-account "$STORAGE_ACCOUNT" \
  --runtime node \
  --runtime-version 22 \
  --os-type Windows \
  --functions-version 4

# ── 5. Application Settings (Environment Variables) ─────────────────────────
# The code reads these via process.env in src/config.ts.
# Storage connection string is auto-populated from the account we just created.
# Third-party keys are left blank — fill them in the Azure Portal or with
# az functionapp config appsettings set.
echo "==> Configuring application settings"
az functionapp config appsettings set \
  --name "$FUNCTION_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --settings \
    "ENGINE_STORAGE_CONNECTION_STRING=$STORAGE_CONNECTION_STRING" \
    "ENGINE_RAW_CONTAINER=$RAW_CONTAINER" \
    "ENGINE_WIKI_CONTAINER=$WIKI_CONTAINER" \
    "ENGINE_SCHEMA_CONTAINER=$SCHEMA_CONTAINER" \
    "ENGINE_RULES_CONTAINER=$RULES_CONTAINER" \
    "ENGINE_RDF_CONTAINER=$RDF_CONTAINER" \
    "ENGINE_RDF_ENGINE=oxigraph" \
    "QDRANT_URL=" \
    "QDRANT_API_KEY=" \
    "QDRANT_COLLECTION=engine" \
    "OPENAI_API_KEY=" \
    "EMBEDDING_MODEL=text-embedding-3-small"

# ── 6. Summary ──────────────────────────────────────────────────────────────
FUNCTION_URL="https://${FUNCTION_APP}.azurewebsites.net"

echo ""
echo "============================================================================"
echo " The Difference Engine — Setup Complete"
echo "============================================================================"
echo ""
echo " Resource Group:     $RESOURCE_GROUP"
echo " Location:           $LOCATION"
echo " Storage Account:    $STORAGE_ACCOUNT"
echo " Function App:       $FUNCTION_APP"
echo " Function URL:       $FUNCTION_URL"
echo ""
echo " Blob Containers:"
echo "   - $RAW_CONTAINER"
echo "   - $WIKI_CONTAINER"
echo "   - $SCHEMA_CONTAINER"
echo "   - $RULES_CONTAINER"
echo "   - $RDF_CONTAINER"
echo ""
echo " MCP Endpoints (after deployment):"
echo "   Consumption:      ${FUNCTION_URL}/api/mcp"
echo "   Library Admin:    ${FUNCTION_URL}/api/mcp-library"
echo "   Rules Admin:      ${FUNCTION_URL}/api/mcp-rules"
echo "   RDF Admin:        ${FUNCTION_URL}/api/mcp-rdf"
echo ""
echo " ┌─────────────────────────────────────────────────────────────────────┐"
echo " │  STILL NEEDED — fill these in Azure Portal > Function App >        │"
echo " │  Configuration > Application settings:                             │"
echo " │                                                                    │"
echo " │  QDRANT_URL        Your Qdrant cluster endpoint                    │"
echo " │  QDRANT_API_KEY    Your Qdrant cluster API key                     │"
echo " │  OPENAI_API_KEY    Your OpenAI API key                             │"
echo " └─────────────────────────────────────────────────────────────────────┘"
echo ""
echo " To deploy the code later:"
echo "   func azure functionapp publish $FUNCTION_APP --javascript"
echo ""
