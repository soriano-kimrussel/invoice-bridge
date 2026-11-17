// invoice-bridge infrastructure. No containers: App Service runs the Node runtime directly.
//
//   App Service plan (Linux) ─ Web app (NODE|22-lts, system-assigned identity)
//                                 │  app settings ─► Key Vault references (secrets)
//   Key Vault (RBAC) ◄────────────┘  role: Key Vault Secrets User
//   PostgreSQL flexible server + database
//   Storage account + private blob container for invoice files
//   Document Intelligence (FormRecognizer) account
targetScope = 'resourceGroup'

@description('Short lowercase prefix for resource names, e.g. "ibdemo". 3-11 chars.')
@minLength(3)
@maxLength(11)
param namePrefix string

param location string = resourceGroup().location

@description('App Service plan SKU. B1 is the cheapest tier with Always On (needed for the in-process worker).')
param appServiceSku string = 'B1'

@description('Document Intelligence SKU: F0 (free, 1 per subscription, 2-page limit) or S0.')
@allowed(['F0', 'S0'])
param documentIntelligenceSku string = 'S0'

param postgresAdminLogin string = 'ibadmin'

@secure()
param postgresAdminPassword string

@description('Burstable B1ms is plenty for a demo.')
param postgresSkuName string = 'Standard_B1ms'

param postgresVersion string = '16'

@secure()
param xeroClientId string

@secure()
param xeroClientSecret string

@description('32 random bytes, base64. Encrypts OAuth tokens at rest.')
@secure()
param tokenEncryptionKey string

@description('Xero expense account code for bill lines (Demo Company).')
param xeroDefaultAccountCode string = '400'

var suffix = uniqueString(resourceGroup().id)
var webAppName = '${namePrefix}-app-${suffix}'
var planName = '${namePrefix}-plan-${suffix}'
var kvName = take('${namePrefix}kv${suffix}', 24)
var storageName = take(toLower('${namePrefix}st${suffix}'), 24)
var pgName = '${namePrefix}-pg-${suffix}'
var diName = '${namePrefix}-di-${suffix}'
var dbName = 'invoice_bridge'
var blobContainer = 'invoices'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

// ---------------------------------------------------------------------------
// Storage (invoice files)
// ---------------------------------------------------------------------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: blobContainer
  properties: { publicAccess: 'None' }
}

// ---------------------------------------------------------------------------
// Azure AI Document Intelligence
// ---------------------------------------------------------------------------
resource docIntel 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: diName
  location: location
  kind: 'FormRecognizer'
  sku: { name: documentIntelligenceSku }
  properties: {
    customSubDomainName: diName
    publicNetworkAccess: 'Enabled'
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL flexible server
// ---------------------------------------------------------------------------
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgName
  location: location
  sku: { name: postgresSkuName, tier: 'Burstable' }
  properties: {
    version: postgresVersion
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: dbName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// 0.0.0.0–0.0.0.0 is Azure's "allow access from Azure services" rule. For production,
// prefer VNet integration + private access instead.
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// ---------------------------------------------------------------------------
// Key Vault + secrets
// ---------------------------------------------------------------------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

var databaseUrl = 'postgresql://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'
var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'

var secrets = {
  'database-url': databaseUrl
  'storage-connection-string': storageConnectionString
  'azure-di-key': docIntel.listKeys().key1
  'xero-client-id': xeroClientId
  'xero-client-secret': xeroClientSecret
  'token-encryption-key': tokenEncryptionKey
}

resource kvSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for s in items(secrets): {
    parent: kv
    name: s.key
    properties: { value: s.value }
  }
]

// App Service resolves these at runtime with the web app's managed identity.
func kvRef(vault string, secret string) string => '@Microsoft.KeyVault(VaultName=${vault};SecretName=${secret})'

// ---------------------------------------------------------------------------
// App Service (Node runtime, no containers)
// ---------------------------------------------------------------------------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: { name: appServiceSku }
  properties: { reserved: true } // Linux
}

resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    keyVaultReferenceIdentity: 'SystemAssigned'
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'npm run start:azure' // prisma migrate deploy && node dist/server.js
      alwaysOn: true
      healthCheckPath: '/healthz'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        // CI ships a fully built package with production node_modules: no Oryx build on deploy.
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        { name: 'PORT', value: '8080' }
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'DATABASE_URL', value: kvRef(kvName, 'database-url') }
        { name: 'STORAGE_DRIVER', value: 'azure' }
        { name: 'AZURE_STORAGE_CONNECTION_STRING', value: kvRef(kvName, 'storage-connection-string') }
        { name: 'AZURE_STORAGE_CONTAINER', value: blobContainer }
        { name: 'AZURE_DI_ENDPOINT', value: docIntel.properties.endpoint }
        { name: 'AZURE_DI_KEY', value: kvRef(kvName, 'azure-di-key') }
        { name: 'RUN_WORKER_IN_PROCESS', value: 'true' }
        { name: 'WORKER_MAX_ATTEMPTS', value: '5' }
        { name: 'CONFIDENCE_THRESHOLD', value: '0.8' }
        { name: 'XERO_CLIENT_ID', value: kvRef(kvName, 'xero-client-id') }
        { name: 'XERO_CLIENT_SECRET', value: kvRef(kvName, 'xero-client-secret') }
        { name: 'XERO_REDIRECT_URI', value: 'https://${webAppName}.azurewebsites.net/auth/xero/callback' }
        { name: 'XERO_DEFAULT_ACCOUNT_CODE', value: xeroDefaultAccountCode }
        { name: 'TOKEN_ENCRYPTION_KEY', value: kvRef(kvName, 'token-encryption-key') }
      ]
    }
  }
  dependsOn: [kvSecrets, pgDb, pgAllowAzure, container]
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, web.id, keyVaultSecretsUserRoleId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: web.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output webAppName string = web.name
output url string = 'https://${web.properties.defaultHostName}'
output xeroRedirectUri string = 'https://${webAppName}.azurewebsites.net/auth/xero/callback'
output keyVaultName string = kv.name
output postgresHost string = pg.properties.fullyQualifiedDomainName
output documentIntelligenceEndpoint string = docIntel.properties.endpoint
