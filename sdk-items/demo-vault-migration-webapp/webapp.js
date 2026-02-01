// Load required modules and initialize express - ES Module syntax
import sdk from '@1password/sdk';
import { execSync } from 'child_process';
import express from 'express';
import bodyParser from 'body-parser';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import selfsigned from 'selfsigned';
import pLimit from 'p-limit';
import fs from 'fs';

const app = express();

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory log storage with timestamps and severity levels
class LogManager {
  constructor() {
    this.globalLog = [];
    this.vaultLogs = {};
    this.errorCount = 0;
    this.warningCount = 0;
    this.failedItems = []; // Track failed items with details
    this.vaultSummaries = {}; // Track per-vault statistics
  }

  log(level, vaultId, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, level, vaultId, message, ...metadata };
    
    // Add to global log
    this.globalLog.push(entry);
    
    // Add to vault-specific log if vaultId provided
    if (vaultId) {
      if (!this.vaultLogs[vaultId]) {
        this.vaultLogs[vaultId] = [];
      }
      this.vaultLogs[vaultId].push(entry);
    }
    
    // Track error counts
    if (level === 'ERROR') this.errorCount++;
    if (level === 'WARNING') this.warningCount++;
    
    // Console output
    const prefix = `[${timestamp}] [${level}]${vaultId ? ` [${vaultId}]` : ''}`;
    console.log(`${prefix} ${message}`);
  }

  info(vaultId, message, metadata = {}) {
    this.log('INFO', vaultId, message, metadata);
  }

  warning(vaultId, message, metadata = {}) {
    this.log('WARNING', vaultId, message, metadata);
  }

  error(vaultId, message, metadata = {}) {
    this.log('ERROR', vaultId, message, metadata);
  }

  // Track a failed item migration
  logFailedItem(vaultId, vaultName, itemId, itemTitle, error) {
    this.failedItems.push({
      vaultId,
      vaultName,
      itemId,
      itemTitle,
      error: error.message || error.toString(),
      timestamp: new Date().toISOString()
    });
    
    this.error(vaultId, `Failed to migrate item [${itemId}] "${itemTitle}": ${error.message}`, {
      itemId,
      itemTitle,
      errorMessage: error.message
    });
  }

  // Track vault migration completion
  logVaultComplete(vaultId, vaultName, stats) {
    this.vaultSummaries[vaultId] = {
      vaultName,
      sourceItemCount: stats.sourceItemCount,
      destItemCount: stats.destItemCount,
      successCount: stats.successCount,
      failureCount: stats.failureCount,
      timestamp: new Date().toISOString()
    };
  }

  getGlobalLog() {
    return this.globalLog.map(e => 
      `[${e.timestamp}] [${e.level}]${e.vaultId ? ` [Vault: ${e.vaultId}]` : ''}${e.itemId ? ` [Item: ${e.itemId}]` : ''} ${e.message}`
    ).join('\n');
  }

  getVaultLog(vaultId) {
    if (!this.vaultLogs[vaultId]) return '';
    return this.vaultLogs[vaultId].map(e => 
      `[${e.timestamp}] [${e.level}]${e.itemId ? ` [Item: ${e.itemId}]` : ''} ${e.message}`
    ).join('\n');
  }

  getSummary() {
    return {
      totalEntries: this.globalLog.length,
      errors: this.errorCount,
      warnings: this.warningCount,
      vaults: Object.keys(this.vaultLogs).length,
      failedItems: this.failedItems.length
    };
  }

  // Generate detailed failure summary
  getFailureSummary() {
    if (this.failedItems.length === 0) {
      return '\n═══════════════════════════════════════════════════════════════════════════════\n' +
             '✓ NO FAILED ITEMS - All items migrated successfully!\n' +
             '═══════════════════════════════════════════════════════════════════════════════\n';
    }

    let summary = '\n';
    summary += '═══════════════════════════════════════════════════════════════════════════════\n';
    summary += `FAILED ITEMS SUMMARY (${this.failedItems.length} total failures)\n`;
    summary += '═══════════════════════════════════════════════════════════════════════════════\n\n';

    // Group by vault
    const failuresByVault = {};
    this.failedItems.forEach(item => {
      if (!failuresByVault[item.vaultId]) {
        failuresByVault[item.vaultId] = {
          vaultName: item.vaultName,
          items: []
        };
      }
      failuresByVault[item.vaultId].items.push(item);
    });

    // Output by vault
    Object.entries(failuresByVault).forEach(([vaultId, data]) => {
      summary += `VAULT: ${data.vaultName}\n`;
      summary += `UUID:  ${vaultId}\n`;
      summary += `Failed Items: ${data.items.length}\n`;
      summary += '─'.repeat(79) + '\n\n';

      data.items.forEach((item, index) => {
        summary += `  ${index + 1}. Item: "${item.itemTitle}"\n`;
        summary += `     UUID:  ${item.itemId}\n`;
        summary += `     Error: ${item.error}\n`;
        summary += `     Time:  ${item.timestamp}\n\n`;
      });

      summary += '\n';
    });

    summary += '═══════════════════════════════════════════════════════════════════════════════\n';

    return summary;
  }

  // Generate vault statistics summary
  getVaultStatsSummary() {
    if (Object.keys(this.vaultSummaries).length === 0) {
      return '';
    }

    let summary = '\n';
    summary += '═══════════════════════════════════════════════════════════════════════════════\n';
    summary += 'VAULT MIGRATION STATISTICS\n';
    summary += '═══════════════════════════════════════════════════════════════════════════════\n\n';

    Object.entries(this.vaultSummaries).forEach(([vaultId, stats]) => {
      const status = stats.failureCount === 0 && stats.sourceItemCount === stats.destItemCount ? '✓' : '⚠';
      summary += `${status} VAULT: ${stats.vaultName}\n`;
      summary += `  UUID:        ${vaultId}\n`;
      summary += `  Source:      ${stats.sourceItemCount} items\n`;
      summary += `  Destination: ${stats.destItemCount} items\n`;
      summary += `  Success:     ${stats.successCount} items\n`;
      summary += `  Failed:      ${stats.failureCount} items\n`;
      summary += `  Completed:   ${stats.timestamp}\n`;
      summary += '\n';
    });

    summary += '═══════════════════════════════════════════════════════════════════════════════\n';

    return summary;
  }

  clear() {
    this.globalLog = [];
    this.vaultLogs = {};
    this.errorCount = 0;
    this.warningCount = 0;
    this.failedItems = [];
    this.vaultSummaries = {};
  }
}

const logger = new LogManager();

// Concurrency limits
const VAULT_CONCURRENCY_LIMIT = 2;
const ITEM_CONCURRENCY_LIMIT = 1;

// Set up views and middleware
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Set up session handling
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, path: '/', maxAge: 24 * 60 * 60 * 1000 }
}));

// Global error handler - prevent crashes
process.on('uncaughtException', (error) => {
  logger.error(null, `Uncaught Exception: ${error.message}`);
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(null, `Unhandled Rejection: ${reason}`);
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Show the welcome page
app.get('/', (req, res) => {
  res.render('welcome', { currentPage: 'welcome' });
});

// Show the migration page
app.get('/migration', (req, res) => {
  res.render('migration', { error: null, currentPage: 'migration' });
});

// List vaults using a service token
app.post('/migration/list-vaults', async (req, res) => {
  const { serviceToken } = req.body;
  if (!serviceToken) {
    logger.error(null, 'Service token is required');
    return res.status(400).json({ success: false, error: 'Service token is required' });
  }
  
  try {
    logger.info(null, 'Listing vaults for source tenant');
    const sdkInstance = new OnePasswordSDK(serviceToken);
    await sdkInstance.initializeClient();
    const vaults = await sdkInstance.listVaults();
    
    const vaultsWithCounts = await Promise.all(vaults.map(async (vault) => {
      try {
        const count = await getVaultItemCount(vault.id, serviceToken, vault.name);
        logger.info(vault.id, `Vault ${vault.name}: ${count} items`);
        return { ...vault, itemCount: count };
      } catch (error) {
        logger.error(vault.id, `Failed to get item count: ${error.message}`);
        return { ...vault, itemCount: 0 };
      }
    }));
    
    res.json({ success: true, vaults: vaultsWithCounts });
  } catch (error) {
    logger.error(null, `Failed to list vaults: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

let isMigrationCancelled = false;

// Cancel an ongoing migration
app.post('/migration/cancel', (req, res) => {
  isMigrationCancelled = true;
  logger.info(null, 'Migration cancellation requested');
  res.json({ success: true, message: 'Migration cancellation requested' });
});

// Retry function for handling conflicts or rate limits
const retryWithBackoff = async (fn, maxRetries = 3, baseDelay = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (
        (error.message.includes('data conflict') || error.message.includes('rate limit')) &&
        attempt < maxRetries
      ) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warning(null, `Retrying attempt ${attempt} after ${delay}ms due to ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
};

// Create a CUSTOM item using the 1Password CLI
async function createCustomItemViaCLI(item, sourceToken, destToken, sourceVaultId, destVaultId, vaultId, customTemplateId) {
  try {
    console.log('\n========================================');
    console.log('CUSTOM ITEM MIGRATION DEBUG');
    console.log('========================================');
    console.log(`Item ID: ${item.id}`);
    console.log(`Item Title: ${item.title}`);
    console.log(`Source Vault: ${sourceVaultId}`);
    console.log(`Dest Vault: ${destVaultId}`);
    console.log(`Custom Template ID: ${customTemplateId || 'NOT PROVIDED'}`);
    console.log('========================================\n');
    
    // First, get the full item with template from source using CLI
    const sourceEnv = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: sourceToken };
    const getItemCommand = `op item get ${item.id} --vault ${sourceVaultId} --format json`;
    
    logger.info(vaultId, `Fetching CUSTOM item ${item.id} via CLI from source`);
    console.log(`[STEP 1] Executing: ${getItemCommand}`);
    
    const sourceItemJson = execSync(getItemCommand, { env: sourceEnv, encoding: 'utf8' });
    const sourceItem = JSON.parse(sourceItemJson);
    
    console.log('\n[STEP 2] Original item from source:');
    console.log('Sections:', JSON.stringify(sourceItem.sections, null, 2));
    console.log('\nFields (showing first 3):');
    sourceItem.fields.slice(0, 3).forEach((field, idx) => {
      console.log(`  Field ${idx + 1}: ${field.label} (section: ${field.section ? field.section.label : 'none'})`);
    });
    console.log(`  ... and ${sourceItem.fields.length - 3} more fields\n`);
    
    // Set up destination environment for CLI commands
    const destEnv = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: destToken };
    
    let destCategoryId;
    
    // Check if custom template ID was provided
    if (customTemplateId && customTemplateId.trim() !== '') {
      destCategoryId = customTemplateId.trim();
      logger.info(vaultId, `Using provided CUSTOM template UUID: ${destCategoryId}`);
      console.log(`[STEP 3] Using provided template UUID: ${destCategoryId}\n`);
    } else {
      // Try to auto-detect CUSTOM template from destination
      logger.info(vaultId, `Getting CUSTOM template list from destination`);
      console.log('[STEP 3] Auto-detecting CUSTOM template...');
      
      try {
        const templateListCommand = `op item template list --format json`;
        const templateListJson = execSync(templateListCommand, { env: destEnv, encoding: 'utf8' });
        const templates = JSON.parse(templateListJson);
        
        // Find the CUSTOM template (it should have category "CUSTOM")
        const customTemplate = templates.find(t => t.name === "Custom" || t.category === "CUSTOM");
        
        if (!customTemplate) {
          throw new Error("No CUSTOM template found in destination account. Please provide a Custom Template UUID in the connection form or ensure custom templates are enabled.");
        }
        
        destCategoryId = customTemplate.uuid;
        logger.info(vaultId, `Found CUSTOM template in destination with UUID: ${destCategoryId}`);
        console.log(`Found template UUID: ${destCategoryId}\n`);
      } catch (error) {
        throw new Error(`Failed to get CUSTOM template: ${error.message}. Please provide a Custom Template UUID in the connection form.`);
      }
    }
    
    console.log('[STEP 4] Preparing item for destination...');
    
    // Prepare the item for creation in destination
    // Remove source-specific fields that shouldn't be copied
    delete sourceItem.id;
    delete sourceItem.created_at;
    delete sourceItem.updated_at;
    delete sourceItem.last_edited_by;
    delete sourceItem.version;
    
    console.log('  - Removed: id, created_at, updated_at, last_edited_by, version');
    
    // Use the destination's CUSTOM template UUID
    sourceItem.category = "CUSTOM";
    sourceItem.category_id = destCategoryId;
    
    console.log(`  - Set category: CUSTOM`);
    console.log(`  - Set category_id: ${destCategoryId}`);
    
    // Remove the 'reference' fields as they contain source vault references
    if (sourceItem.fields) {
      sourceItem.fields.forEach(field => {
        delete field.reference;
      });
      console.log(`  - Removed 'reference' from all ${sourceItem.fields.length} fields`);
    }
    
    // Don't reassign section IDs - keep the originals to preserve field order
    // The CLI might use section IDs for ordering, so keeping originals might help
    
    // Just remove field IDs - keep everything else including section IDs
    if (sourceItem.fields) {
      sourceItem.fields.forEach(field => {
        delete field.id;
      });
      console.log(`  - Removed 'id' from all fields (keeping section IDs)`);
    }
    
    // Update vault reference to destination vault
    sourceItem.vault = { id: destVaultId };
    
    console.log(`  - Updated vault.id to: ${destVaultId}\n`);
    
    console.log('[STEP 5] Modified item structure:');
    console.log('Sections:', JSON.stringify(sourceItem.sections, null, 2));
    console.log('\nFields (in order):');
    sourceItem.fields.forEach((field, idx) => {
      console.log(`  ${idx + 1}. ${field.label} (section: ${field.section ? field.section.label + ' [' + field.section.id + ']' : 'none'}, type: ${field.type})`);
    });
    
    // Write to a temporary file so we can use --template with a file path
    // This gives us more control than piping via stdin
    const tmpFile = `/tmp/op-custom-item-${item.id}-${Date.now()}.json`;
    const itemJson = JSON.stringify(sourceItem, null, 2);
    
    // Log the JSON we're about to send for debugging
    logger.info(vaultId, `Writing CUSTOM item template to ${tmpFile}`);
    console.log(`\n[STEP 6] Writing to temp file: ${tmpFile}`);
    console.log('Full JSON:');
    console.log('----------------------------------------');
    console.log(itemJson);
    console.log('----------------------------------------\n');
    
    fs.writeFileSync(tmpFile, itemJson);
    
    try {
      // Create the item in destination vault using CLI with file path
      logger.info(vaultId, `Creating CUSTOM item "${item.title}" via CLI in destination`);
      console.log(`[STEP 7] Creating item via CLI...`);
      
      // Use the file path directly with --template flag
      const createItemCommand = `op item create --vault ${destVaultId} --template '${tmpFile}'`;
      console.log(`Executing: ${createItemCommand}\n`);
      
      const createResult = execSync(createItemCommand, { 
        env: destEnv, 
        encoding: 'utf8',
        shell: '/bin/bash'
      });
      
      console.log('[STEP 8] CLI Response:');
      console.log('----------------------------------------');
      console.log(createResult);
      console.log('----------------------------------------\n');
      
      logger.info(vaultId, `Successfully created CUSTOM item "${item.title}" via CLI`);
      console.log('✓ SUCCESS: CUSTOM item created\n');
      console.log('========================================\n');
      
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile);
        logger.info(vaultId, `Cleaned up temp file ${tmpFile}`);
        console.log(`[CLEANUP] Removed temp file: ${tmpFile}`);
      } catch (cleanupError) {
        logger.warning(vaultId, `Failed to clean up temp file ${tmpFile}: ${cleanupError.message}`);
        console.log(`[CLEANUP] Warning: Could not remove temp file: ${cleanupError.message}`);
      }
    }
    
    return { success: true };
    
  } catch (error) {
    console.log('\n✗ ERROR during CUSTOM item migration:');
    console.log('----------------------------------------');
    console.log(error.message);
    console.log('----------------------------------------\n');
    logger.error(vaultId, `Failed to create CUSTOM item via CLI: ${error.message}`);
    throw error;
  }
}

// Get item count for a vault with error handling
async function getVaultItemCount(vaultId, token, vaultName = 'Unknown') {
  try {
    const sdkInstance = new OnePasswordSDK(token);
    await sdkInstance.initializeClient();
    const activeItems = await sdkInstance.client.items.list(vaultId);
    const activeCount = activeItems.length;
    
    try {
      const archivedItems = await sdkInstance.client.items.list(vaultId, {
        type: "ByState",
        content: { active: false, archived: true }
      });
      const archivedCount = archivedItems.length;
      
      if (archivedCount > 0) {
        logger.info(vaultId, `Contains ${archivedCount} archived items`);
      }
    } catch (archiveError) {
      logger.warning(vaultId, `Could not fetch archived items: ${archiveError.message}`);
    }
    
    return activeCount;
  } catch (error) {
    logger.error(vaultId, `Error fetching item count: ${error.message}`);
    return 0;
  }
}

// Migrate a single vault and its items with comprehensive error handling
async function migrateVault(vaultId, vaultName, sourceToken, destToken, sourceSDK, destSDK, isCancelled, customTemplateId) {
  const logEntry = { 
    vaultId, 
    vaultName, 
    timestamp: new Date().toISOString(), 
    errors: [], 
    itemResults: [],
    status: 'in-progress'
  };
  
  logger.info(vaultId, `Starting migration for vault ${vaultName}`);

  try {
    // Get source item count
    const sourceItemCount = await getVaultItemCount(vaultId, sourceToken, vaultName);
    logEntry.sourceItemCount = sourceItemCount;
    logger.info(vaultId, `Source item count: ${sourceItemCount}`);

    // Create destination vault
    let newVaultId;
    try {
      const destEnv = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: destToken };
      const createVaultCommand = `op vault create "${vaultName}" --format json`;
      const newVaultOutput = execSync(createVaultCommand, { env: destEnv, encoding: 'utf8' });
      const newVault = JSON.parse(newVaultOutput);
      newVaultId = newVault.id;
      logEntry.newVaultId = newVaultId;
      logger.info(vaultId, `Created destination vault ${newVaultId}`);
    } catch (error) {
      logger.error(vaultId, `Failed to create destination vault: ${error.message}`);
      throw new Error(`Vault creation failed: ${error.message}`);
    }

    // Get items to migrate
    let items;
    try {
      items = await sourceSDK.listVaultItems(vaultId);
      logger.info(vaultId, `Found ${items.length} items to migrate`);
    } catch (error) {
      logger.error(vaultId, `Failed to list items: ${error.message}`);
      throw new Error(`Item listing failed: ${error.message}`);
    }

    const migrationResults = [];
    let processedItems = 0;
    let successCount = 0;
    let failureCount = 0;

    // Migrate each item with individual error handling
    for (const item of items) {
      if (isCancelled()) {
        logEntry.status = 'cancelled';
        logger.info(vaultId, `Migration cancelled by user`);
        return { 
          itemsLength: items.length, 
          migrationResults, 
          sourceItemCount, 
          destItemCount: null,
          successCount,
          failureCount 
        };
      }

      try {
        // Check if this is a CUSTOM item that needs CLI handling
        // Log for debugging
        const categoryStr = String(item.category);
        const categoryType = typeof item.category;
        logger.info(vaultId, `Item "${item.title}" category: ${categoryStr} (type: ${categoryType})`);
        
        // SDK returns "Unsupported" for CUSTOM category items
        // Check all possible ways CUSTOM might appear
        const isCustomItem = item.category === 'CUSTOM' || 
                            item.category === 'Custom' || 
                            item.category === 'Unsupported' ||
                            item.category === sdk.ItemCategory.Custom ||
                            categoryStr === 'Custom' ||
                            categoryStr === 'CUSTOM' ||
                            categoryStr === 'Unsupported' ||
                            categoryStr.toLowerCase() === 'custom' ||
                            categoryStr.toLowerCase() === 'unsupported';
        
        if (isCustomItem) {
          logger.info(vaultId, `Detected CUSTOM item "${item.title}" (category: ${item.category}) - migrating via CLI`);
          
          await createCustomItemViaCLI(item, sourceToken, destToken, vaultId, newVaultId, vaultId, customTemplateId);
          
          processedItems++;
          successCount++;
          migrationResults.push({ 
            id: item.id, 
            title: item.title, 
            success: true, 
            progress: (processedItems / items.length) * 100 
          });
          logEntry.itemResults.push({ id: item.id, title: item.title, success: true });
          logger.info(vaultId, `Successfully migrated CUSTOM item [${item.id}] "${item.title}" via CLI`, { itemId: item.id, itemTitle: item.title });
          continue; // Skip SDK processing for this item
        }
        
        // Original simple category handling - let SDK handle it
        const newItem = {
          title: item.title,
          category: item.category || sdk.ItemCategory.Login,
          vaultId: newVaultId
        };

        // Add notes if present
        if (item.notes && item.notes.trim() !== "") {
          newItem.notes = item.notes;
        } else if (item.category === sdk.ItemCategory.SecureNote) {
          newItem.notes = "Migrated Secure Note";
        }

        // Handle document items
        if (item.category === 'Document' || item.category === sdk.ItemCategory.Document) {
          try {
            const fullItem = await retryWithBackoff(() => sourceSDK.client.items.get(vaultId, item.id));
            if (fullItem.category !== sdk.ItemCategory.Document || !fullItem.document) {
              throw new Error(`Item ${item.id} is not a valid Document`);
            }
            const documentContent = await retryWithBackoff(() => 
              sourceSDK.client.items.files.read(vaultId, item.id, fullItem.document)
            );
            newItem.document = {
              name: fullItem.document.name,
              content: documentContent instanceof Uint8Array ? documentContent : new Uint8Array(documentContent)
            };
          } catch (docError) {
            logger.warning(vaultId, `Document handling failed for ${item.title}: ${docError.message}`);
          }
        }

        // Handle SSH keys
        if (item.category === 'SSH_KEY') {
          newItem.category = sdk.ItemCategory.SshKey;
        }

        // Handle credit cards
        if (item.category === 'CreditCard' || item.category === sdk.ItemCategory.CreditCard) {
          newItem.category = sdk.ItemCategory.CreditCard;
          try {
            const fullItem = await retryWithBackoff(() => sourceSDK.client.items.get(vaultId, item.id));
            newItem.fields = fullItem.fields.map(field => {
              const newField = {
                id: field.id || "unnamed",
                title: field.title || field.label || "unnamed",
                fieldType: field.fieldType || sdk.ItemFieldType.Text,
                value: field.value || "",
                sectionId: field.sectionId
              };

              const builtInFieldIds = ["cardholder", "type", "number", "ccnum", "cvv", "expiry"];

              if (field.id === "type" || field.title.toLowerCase().includes("type")) {
                newField.fieldType = sdk.ItemFieldType.CreditCardType;
                const cardTypeMap = {
                  "mc": "Mastercard",
                  "visa": "Visa",
                  "amex": "American Express",
                  "discover": "Discover"
                };
                newField.value = cardTypeMap[field.value.toLowerCase()] || field.value || "Unknown";
              }

              if (field.id === "expiry" || field.title.toLowerCase().includes("expiry") || 
                  field.title.toLowerCase().includes("expiration")) {
                newField.fieldType = sdk.ItemFieldType.MonthYear;
                let expiryValue = field.value || "";
                if (expiryValue) {
                  if (/^\d{2}\/\d{4}$/.test(expiryValue)) {
                    newField.value = expiryValue;
                  } else if (/^\d{2}-\d{4}$/.test(expiryValue)) {
                    newField.value = expiryValue.replace('-', '/');
                  } else if (/^\d{2}\d{2}$/.test(expiryValue)) {
                    newField.value = `${expiryValue.slice(0, 2)}/20${expiryValue.slice(2)}`;
                  } else if (/^\d{2}\/\d{2}$/.test(expiryValue)) {
                    newField.value = `${expiryValue.slice(0, 2)}/20${expiryValue.slice(3)}`;
                  } else {
                    newField.value = "01/1970";
                  }
                } else {
                  newField.value = "01/1970";
                }
              }

              if (field.id === "number" || field.id === "ccnum" || field.title.toLowerCase().includes("number")) {
                newField.fieldType = sdk.ItemFieldType.CreditCardNumber;
              }

              if (field.id === "cvv" || field.title.toLowerCase().includes("verification")) {
                newField.fieldType = sdk.ItemFieldType.Concealed;
              }

              if (field.id === "pin" || field.title.toLowerCase().includes("pin")) {
                newField.fieldType = sdk.ItemFieldType.Concealed;
              }

              if (!newField.sectionId && !builtInFieldIds.includes(newField.id)) {
                newField.sectionId = "add more";
              }

              return newField;
            });
          } catch (ccError) {
            logger.warning(vaultId, `Credit card field processing failed for ${item.title}: ${ccError.message}`);
          }
        }

        // Handle other fields (including CUSTOM category fields)
        if (item.fields && item.fields.length > 0 && newItem.category !== sdk.ItemCategory.CreditCard) {
          newItem.fields = item.fields.map(field => {
            const newField = {
              id: field.id || "unnamed",
              title: field.title || field.label || "unnamed",
              fieldType: field.fieldType === sdk.ItemFieldType.Text ? sdk.ItemFieldType.Text :
                        field.fieldType === sdk.ItemFieldType.Concealed ? sdk.ItemFieldType.Concealed :
                        field.fieldType === sdk.ItemFieldType.Totp ? sdk.ItemFieldType.Totp :
                        field.fieldType === sdk.ItemFieldType.Address ? sdk.ItemFieldType.Address :
                        field.fieldType === sdk.ItemFieldType.SshKey ? sdk.ItemFieldType.SshKey :
                        field.fieldType === sdk.ItemFieldType.Date ? sdk.ItemFieldType.Date :
                        field.fieldType === sdk.ItemFieldType.MonthYear ? sdk.ItemFieldType.MonthYear :
                        field.fieldType === sdk.ItemFieldType.Email ? sdk.ItemFieldType.Email :
                        field.fieldType === sdk.ItemFieldType.Phone ? sdk.ItemFieldType.Phone :
                        field.fieldType === sdk.ItemFieldType.Url ? sdk.ItemFieldType.Url :
                        field.fieldType === sdk.ItemFieldType.Menu ? sdk.ItemFieldType.Menu :
                        sdk.ItemFieldType.Text,
              value: field.value || ""
            };
            
            // Preserve sectionId for all fields to maintain exact structure
            if (field.sectionId !== undefined) {
              newField.sectionId = field.sectionId;
            }

            if (field.fieldType === sdk.ItemFieldType.Address && field.details && field.details.content) {
              newField.details = {
                type: "Address",
                content: {
                  street: field.details.content.street || "",
                  city: field.details.content.city || "",
                  country: field.details.content.country || "",
                  zip: field.details.content.zip || "",
                  state: field.details.content.state || ""
                }
              };
              newField.value = "";
            } else if (field.fieldType === sdk.ItemFieldType.SshKey && field.details && field.details.content) {
              newField.value = field.details.content.privateKey || field.value || "";
            } else if (field.fieldType === sdk.ItemFieldType.Totp) {
              const totpValue = field.value || field.details?.content?.totp || "";
              const isValidTotpUri = totpValue.startsWith("otpauth://totp/");
              const isPotentialTotpSeed = /^[A-Z2-7]{16,32}$/i.test(totpValue);
              if (isValidTotpUri || isPotentialTotpSeed) {
                newField.value = totpValue;
              } else {
                newField.fieldType = sdk.ItemFieldType.Text;
                newField.value = totpValue;
              }
            } else if (field.fieldType === sdk.ItemFieldType.Date || field.fieldType === sdk.ItemFieldType.MonthYear) {
              newField.value = field.value || "";
            }

            return newField;
          });
        } else if (item.category === sdk.ItemCategory.SecureNote) {
          newItem.notes = item.notes || "Migrated Secure Note";
        }

        // Handle sections - preserve ALL sections with their exact structure and order
        if (item.sections && item.sections.length > 0) {
          newItem.sections = item.sections.map(section => ({
            id: section.id,
            title: section.title || section.label || ""
          }));
        }

        // Handle files
        if (item.files && item.files.length > 0) {
          newItem.files = [];
          const fileSectionIds = new Set();
          
          for (const [index, file] of item.files.entries()) {
            try {
              const fileName = file.name;
              const fileContent = file.content;
              const fileSectionId = file.sectionId || "add more";
              const fileFieldId = file.fieldId || `${fileName}-${Date.now()}-${index}`;

              if (fileName && fileContent) {
                newItem.files.push({
                  name: fileName,
                  content: fileContent instanceof Uint8Array ? fileContent : new Uint8Array(fileContent),
                  sectionId: fileSectionId,
                  fieldId: fileFieldId
                });
                fileSectionIds.add(fileSectionId);
              }
            } catch (fileError) {
              logger.warning(vaultId, `File processing failed for ${item.title}: ${fileError.message}`);
            }
          }

          if (!newItem.sections) newItem.sections = [];
          for (const sectionId of fileSectionIds) {
            if (!newItem.sections.some(section => section.id === sectionId)) {
              newItem.sections.push({ id: sectionId, title: sectionId === "add more" ? "" : sectionId });
            }
          }
        }

        // Handle tags and websites
        if (item.tags && item.tags.length > 0) {
          newItem.tags = item.tags;
        }
        
        if (item.websites && item.websites.length > 0) {
          newItem.websites = item.websites.map(website => ({
            url: website.url || website.href || "",
            label: website.label || "website",
            autofillBehavior: website.autofillBehavior || sdk.AutofillBehavior.AnywhereOnWebsite
          }));
        }

        // Create the item
        await retryWithBackoff(() => destSDK.client.items.create(newItem));

        processedItems++;
        successCount++;
        migrationResults.push({ 
          id: item.id, 
          title: item.title, 
          success: true, 
          progress: (processedItems / items.length) * 100 
        });
        logEntry.itemResults.push({ id: item.id, title: item.title, success: true });
        logger.info(vaultId, `Successfully migrated item [${item.id}] "${item.title}"`, { itemId: item.id, itemTitle: item.title });

      } catch (error) {
        processedItems++;
        failureCount++;
        logger.logFailedItem(vaultId, vaultName, item.id, item.title, error);
        migrationResults.push({ 
          id: item.id, 
          title: item.title, 
          success: false, 
          error: error.message, 
          progress: (processedItems / items.length) * 100 
        });
        logEntry.errors.push(`Item ${item.id} (${item.title}): ${error.message}`);
        logEntry.itemResults.push({ 
          id: item.id, 
          title: item.title, 
          success: false, 
          error: error.message 
        });
      }
    }

    // Get destination item count
    const destItemCount = await getVaultItemCount(newVaultId, destToken, vaultName);
    logEntry.destItemCount = destItemCount;
    logEntry.status = 'completed';
    logEntry.successCount = successCount;
    logEntry.failureCount = failureCount;
    
    logger.info(vaultId, `Destination item count: ${destItemCount}`);
    logger.info(vaultId, `Migration completed - Success: ${successCount}, Failed: ${failureCount}`);

    // Log vault statistics for summary
    logger.logVaultComplete(vaultId, vaultName, {
      sourceItemCount,
      destItemCount,
      successCount,
      failureCount
    });

    if (sourceItemCount === destItemCount && failureCount === 0) {
      logger.info(vaultId, `Successfully migrated all ${sourceItemCount} items`);
    } else {
      logger.warning(vaultId, 
        `Item count mismatch - Source: ${sourceItemCount}, Destination: ${destItemCount}, Failed: ${failureCount}`
      );
    }

    return { 
      itemsLength: items.length, 
      migrationResults, 
      sourceItemCount, 
      destItemCount,
      successCount,
      failureCount
    };
    
  } catch (error) {
    logger.error(vaultId, `Vault migration failed: ${error.message}`);
    logEntry.status = 'failed';
    logEntry.errors.push(`Vault migration: ${error.message}`);
    throw error;
  }
}

// Migrate a single vault endpoint
app.post('/migration/migrate-vault', async (req, res) => {
  const { vaultId, vaultName, sourceToken, destToken, customTemplateId } = req.body;
  
  if (!vaultId || !vaultName || !sourceToken || !destToken) {
    logger.error(null, 'Missing required parameters for vault migration');
    return res.status(400).json({ 
      success: false, 
      message: 'Vault ID, vault name, source token, and destination token are required' 
    });
  }

  try {
    const sourceSDK = new OnePasswordSDK(sourceToken);
    await sourceSDK.initializeClient();
    const destSDK = new OnePasswordSDK(destToken);
    await destSDK.initializeClient();

    const result = await migrateVault(
      vaultId, vaultName, sourceToken, destToken, sourceSDK, destSDK, () => isMigrationCancelled, customTemplateId
    );

    const { itemsLength, migrationResults, sourceItemCount, destItemCount, successCount, failureCount } = result;

    if (failureCount > 0 || sourceItemCount !== destItemCount) {
      logger.info(vaultId, 
        `Migration completed with issues - ${successCount} succeeded, ${failureCount} failed`
      );
      res.json({
        success: false,
        message: `Vault "${vaultName}" migration completed with ${failureCount} failures out of ${itemsLength} items`,
        results: migrationResults,
        stats: { successCount, failureCount, sourceItemCount, destItemCount }
      });
    } else {
      logger.info(vaultId, `Migration successful - ${successCount} items migrated`);
      res.json({ 
        success: true, 
        message: `Successfully migrated vault "${vaultName}" with ${itemsLength} items`, 
        results: migrationResults,
        stats: { successCount, failureCount, sourceItemCount, destItemCount }
      });
    }
  } catch (error) {
    logger.error(vaultId, `Migration endpoint failed: ${error.message}`);
    res.status(500).json({ success: false, message: `Failed to migrate vault: ${error.message}` });
  }
});

// Migrate multiple or all vaults with Server-Sent Events
app.get('/migration/migrate-all-vaults', async (req, res) => {
  const { sourceToken, destToken, vaults, customTemplateId } = req.query;
  let selectedVaults;
  
  try {
    selectedVaults = vaults ? JSON.parse(decodeURIComponent(vaults)) : null;
  } catch (error) {
    logger.error(null, `Failed to parse vaults query: ${error.message}`);
    selectedVaults = null;
  }

  if (!sourceToken || !destToken) {
    logger.error(null, 'Missing required tokens for bulk migration');
    res.write(`data: ${JSON.stringify({ 
      success: false, 
      message: 'Source token and destination token are required', 
      finished: true 
    })}\n\n`);
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const keepAliveInterval = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  isMigrationCancelled = false;
  logger.info(null, 'Starting bulk vault migration');

  try {
    const sourceSDK = new OnePasswordSDK(sourceToken);
    await sourceSDK.initializeClient();
    const destSDK = new OnePasswordSDK(destToken);
    await destSDK.initializeClient();

    let vaultsToMigrate;
    if (selectedVaults && selectedVaults.length > 0) {
      vaultsToMigrate = selectedVaults.map(v => ({ id: v.vaultId, name: v.vaultName }));
    } else {
      const allVaults = await sourceSDK.listVaults();
      vaultsToMigrate = allVaults;
    }

    const totalVaults = vaultsToMigrate.length;
    let completedVaults = 0;
    const migrationResults = [];

    for (const vault of vaultsToMigrate) {
      if (isMigrationCancelled) {
        logger.info(null, 'Bulk migration cancelled by user');
        res.write(`data: ${JSON.stringify({ 
          success: false, 
          message: 'Migration cancelled by user', 
          results: migrationResults 
        })}\n\n`);
        clearInterval(keepAliveInterval);
        res.end();
        return;
      }

      const newVaultName = `${vault.name} (Migrated)`;
      
      // Send "preparing" status
      res.write(`data: ${JSON.stringify({ 
        progress: (completedVaults / totalVaults) * 100,
        outcome: {
          vaultId: vault.id,
          vaultName: vault.name,
          phase: 'preparing',
          message: 'Preparing vault...'
        }
      })}\n\n`);
      
      try {
        // Create progress callback for this vault
        const progressCallback = (itemsProcessed, totalItems, successCount, failureCount) => {
          const vaultProgress = itemsProcessed / totalItems;
          const overallProgress = ((completedVaults + vaultProgress) / totalVaults) * 100;
          
          res.write(`data: ${JSON.stringify({ 
            progress: overallProgress,
            outcome: {
              vaultId: vault.id,
              vaultName: vault.name,
              phase: 'migrating',
              message: `Migrating items (${itemsProcessed}/${totalItems})...`,
              itemsProcessed,
              totalItems,
              successCount,
              failureCount
            }
          })}\n\n`);
        };
        
        const result = await migrateVaultWithProgress(
          vault.id, newVaultName, sourceToken, destToken, sourceSDK, destSDK, 
          () => isMigrationCancelled,
          progressCallback,
          customTemplateId
        );
        
        const { itemsLength, migrationResults: vaultResults, sourceItemCount, destItemCount, successCount, failureCount } = result;
        
        const outcome = {
          vaultId: vault.id,
          vaultName: vault.name,
          success: failureCount === 0 && sourceItemCount === destItemCount,
          message: failureCount === 0 && sourceItemCount === destItemCount ?
            `Successfully migrated vault "${vault.name}" with ${itemsLength} items` :
            `Vault "${vault.name}" completed with ${failureCount} failures out of ${itemsLength} items`,
          results: vaultResults,
          sourceItemCount,
          destItemCount,
          successCount,
          failureCount,
          phase: 'completed'
        };
        
        migrationResults.push(outcome);
        completedVaults++;
        const progress = (completedVaults / totalVaults) * 100;
        res.write(`data: ${JSON.stringify({ progress: progress, outcome: outcome })}\n\n`);
        
      } catch (error) {
        logger.error(vault.id, `Vault migration failed: ${error.message}`);
        const outcome = {
          vaultId: vault.id,
          vaultName: vault.name,
          success: false,
          message: `Failed to migrate vault "${vault.name}": ${error.message}`,
          error: error.message,
          phase: 'failed'
        };
        migrationResults.push(outcome);
        completedVaults++;
        const progress = (completedVaults / totalVaults) * 100;
        res.write(`data: ${JSON.stringify({ progress: progress, outcome: outcome })}\n\n`);
      }
    }

    const failedVaults = migrationResults.filter(result => !result.success);
    const summary = logger.getSummary();
    
    if (failedVaults.length > 0) {
      logger.info(null, 
        `Bulk migration completed with ${failedVaults.length} vault failures out of ${vaultsToMigrate.length} vaults`
      );
      res.write(`data: ${JSON.stringify({ 
        success: false, 
        message: `Migration completed with ${failedVaults.length} vault failures out of ${vaultsToMigrate.length} vaults`, 
        results: migrationResults,
        summary: summary,
        finished: true 
      })}\n\n`);
    } else {
      logger.info(null, `Successfully migrated all ${vaultsToMigrate.length} vaults`);
      res.write(`data: ${JSON.stringify({ 
        success: true, 
        message: `Successfully migrated all ${vaultsToMigrate.length} vaults`, 
        results: migrationResults,
        summary: summary,
        finished: true 
      })}\n\n`);
    }
    
    clearInterval(keepAliveInterval);
    res.end();
    
  } catch (error) {
    logger.error(null, `Bulk migration failed: ${error.message}`);
    res.write(`data: ${JSON.stringify({ 
      success: false, 
      message: `Failed to migrate vaults: ${error.message}`, 
      finished: true 
    })}\n\n`);
    clearInterval(keepAliveInterval);
    res.end();
  }
});

// New version of migrateVault with progress callback
async function migrateVaultWithProgress(vaultId, vaultName, sourceToken, destToken, sourceSDK, destSDK, isCancelled, onProgress, customTemplateId) {
  const logEntry = { 
    vaultId, 
    vaultName, 
    timestamp: new Date().toISOString(), 
    errors: [], 
    itemResults: [],
    status: 'in-progress'
  };
  
  logger.info(vaultId, `Starting migration for vault ${vaultName}`);

  try {
    // Get source item count
    const sourceItemCount = await getVaultItemCount(vaultId, sourceToken, vaultName);
    logEntry.sourceItemCount = sourceItemCount;
    logger.info(vaultId, `Source item count: ${sourceItemCount}`);

    // Create destination vault
    let newVaultId;
    try {
      const destEnv = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: destToken };
      const createVaultCommand = `op vault create "${vaultName}" --format json`;
      const newVaultOutput = execSync(createVaultCommand, { env: destEnv, encoding: 'utf8' });
      const newVault = JSON.parse(newVaultOutput);
      newVaultId = newVault.id;
      logEntry.newVaultId = newVaultId;
      logger.info(vaultId, `Created destination vault ${newVaultId}`);
    } catch (error) {
      logger.error(vaultId, `Failed to create destination vault: ${error.message}`);
      throw new Error(`Vault creation failed: ${error.message}`);
    }

    // Get items to migrate
    let items;
    try {
      items = await sourceSDK.listVaultItems(vaultId);
      logger.info(vaultId, `Found ${items.length} items to migrate`);
    } catch (error) {
      logger.error(vaultId, `Failed to list items: ${error.message}`);
      throw new Error(`Item listing failed: ${error.message}`);
    }

    const migrationResults = [];
    let processedItems = 0;
    let successCount = 0;
    let failureCount = 0;

    // Migrate each item with individual error handling and progress updates
    for (const item of items) {
      if (isCancelled()) {
        logEntry.status = 'cancelled';
        logger.info(vaultId, `Migration cancelled by user`);
        return { 
          itemsLength: items.length, 
          migrationResults, 
          sourceItemCount, 
          destItemCount: null,
          successCount,
          failureCount 
        };
      }

      try {
        // Check if this is a CUSTOM item that needs CLI handling
        // Log for debugging
        const categoryStr = String(item.category);
        const categoryType = typeof item.category;
        logger.info(vaultId, `Item "${item.title}" category: ${categoryStr} (type: ${categoryType})`);
        
        // SDK returns "Unsupported" for CUSTOM category items
        // Check all possible ways CUSTOM might appear
        const isCustomItem = item.category === 'CUSTOM' || 
                            item.category === 'Custom' || 
                            item.category === 'Unsupported' ||
                            item.category === sdk.ItemCategory.Custom ||
                            categoryStr === 'Custom' ||
                            categoryStr === 'CUSTOM' ||
                            categoryStr === 'Unsupported' ||
                            categoryStr.toLowerCase() === 'custom' ||
                            categoryStr.toLowerCase() === 'unsupported';
        
        if (isCustomItem) {
          logger.info(vaultId, `Detected CUSTOM item "${item.title}" (category: ${item.category}) - migrating via CLI`);
          
          await createCustomItemViaCLI(item, sourceToken, destToken, vaultId, newVaultId, vaultId, customTemplateId);
          
          processedItems++;
          successCount++;
          migrationResults.push({ 
            id: item.id, 
            title: item.title, 
            success: true, 
            progress: (processedItems / items.length) * 100 
          });
          logEntry.itemResults.push({ id: item.id, title: item.title, success: true });
          logger.info(vaultId, `Successfully migrated CUSTOM item [${item.id}] "${item.title}" via CLI`, { itemId: item.id, itemTitle: item.title });
          
          // Send progress update every 3 items or on last item
          if (processedItems % 3 === 0 || processedItems === items.length) {
            onProgress(processedItems, items.length, successCount, failureCount);
          }
          
          continue; // Skip SDK processing for this item
        }
        
        // Original simple category handling - let SDK handle it
        const newItem = {
          title: item.title,
          category: item.category || sdk.ItemCategory.Login,
          vaultId: newVaultId
        };

        // Add notes if present
        if (item.notes && item.notes.trim() !== "") {
          newItem.notes = item.notes;
        } else if (item.category === sdk.ItemCategory.SecureNote) {
          newItem.notes = "Migrated Secure Note";
        }

        // Handle document items
        if (item.category === 'Document' || item.category === sdk.ItemCategory.Document) {
          try {
            const fullItem = await retryWithBackoff(() => sourceSDK.client.items.get(vaultId, item.id));
            if (fullItem.category !== sdk.ItemCategory.Document || !fullItem.document) {
              throw new Error(`Item ${item.id} is not a valid Document`);
            }
            const documentContent = await retryWithBackoff(() => 
              sourceSDK.client.items.files.read(vaultId, item.id, fullItem.document)
            );
            newItem.document = {
              name: fullItem.document.name,
              content: documentContent instanceof Uint8Array ? documentContent : new Uint8Array(documentContent)
            };
          } catch (docError) {
            logger.warning(vaultId, `Document handling failed for ${item.title}: ${docError.message}`);
          }
        }

        // Handle SSH keys
        if (item.category === 'SSH_KEY') {
          newItem.category = sdk.ItemCategory.SshKey;
        }

        // Handle credit cards
        if (item.category === 'CreditCard' || item.category === sdk.ItemCategory.CreditCard) {
          newItem.category = sdk.ItemCategory.CreditCard;
          try {
            const fullItem = await retryWithBackoff(() => sourceSDK.client.items.get(vaultId, item.id));
            newItem.fields = fullItem.fields.map(field => {
              const newField = {
                id: field.id || "unnamed",
                title: field.title || field.label || "unnamed",
                fieldType: field.fieldType || sdk.ItemFieldType.Text,
                value: field.value || "",
                sectionId: field.sectionId
              };

              const builtInFieldIds = ["cardholder", "type", "number", "ccnum", "cvv", "expiry"];

              if (field.id === "type" || field.title.toLowerCase().includes("type")) {
                newField.fieldType = sdk.ItemFieldType.CreditCardType;
                const cardTypeMap = {
                  "mc": "Mastercard",
                  "visa": "Visa",
                  "amex": "American Express",
                  "discover": "Discover"
                };
                newField.value = cardTypeMap[field.value.toLowerCase()] || field.value || "Unknown";
              }

              if (field.id === "expiry" || field.title.toLowerCase().includes("expiry") || 
                  field.title.toLowerCase().includes("expiration")) {
                newField.fieldType = sdk.ItemFieldType.MonthYear;
                let expiryValue = field.value || "";
                if (expiryValue) {
                  if (/^\d{2}\/\d{4}$/.test(expiryValue)) {
                    newField.value = expiryValue;
                  } else if (/^\d{2}-\d{4}$/.test(expiryValue)) {
                    newField.value = expiryValue.replace('-', '/');
                  } else if (/^\d{2}\d{2}$/.test(expiryValue)) {
                    newField.value = `${expiryValue.slice(0, 2)}/20${expiryValue.slice(2)}`;
                  } else if (/^\d{2}\/\d{2}$/.test(expiryValue)) {
                    newField.value = `${expiryValue.slice(0, 2)}/20${expiryValue.slice(3)}`;
                  } else {
                    newField.value = "01/1970";
                  }
                } else {
                  newField.value = "01/1970";
                }
              }

              if (field.id === "number" || field.id === "ccnum" || field.title.toLowerCase().includes("number")) {
                newField.fieldType = sdk.ItemFieldType.CreditCardNumber;
              }

              if (field.id === "cvv" || field.title.toLowerCase().includes("verification")) {
                newField.fieldType = sdk.ItemFieldType.Concealed;
              }

              if (field.id === "pin" || field.title.toLowerCase().includes("pin")) {
                newField.fieldType = sdk.ItemFieldType.Concealed;
              }

              if (!newField.sectionId && !builtInFieldIds.includes(newField.id)) {
                newField.sectionId = "add more";
              }

              return newField;
            });
          } catch (ccError) {
            logger.warning(vaultId, `Credit card field processing failed for ${item.title}: ${ccError.message}`);
          }
        }

        // Handle other fields (including CUSTOM category fields)
        if (item.fields && item.fields.length > 0 && newItem.category !== sdk.ItemCategory.CreditCard) {
          newItem.fields = item.fields.map(field => {
            const newField = {
              id: field.id || "unnamed",
              title: field.title || field.label || "unnamed",
              fieldType: field.fieldType === sdk.ItemFieldType.Text ? sdk.ItemFieldType.Text :
                        field.fieldType === sdk.ItemFieldType.Concealed ? sdk.ItemFieldType.Concealed :
                        field.fieldType === sdk.ItemFieldType.Totp ? sdk.ItemFieldType.Totp :
                        field.fieldType === sdk.ItemFieldType.Address ? sdk.ItemFieldType.Address :
                        field.fieldType === sdk.ItemFieldType.SshKey ? sdk.ItemFieldType.SshKey :
                        field.fieldType === sdk.ItemFieldType.Date ? sdk.ItemFieldType.Date :
                        field.fieldType === sdk.ItemFieldType.MonthYear ? sdk.ItemFieldType.MonthYear :
                        field.fieldType === sdk.ItemFieldType.Email ? sdk.ItemFieldType.Email :
                        field.fieldType === sdk.ItemFieldType.Phone ? sdk.ItemFieldType.Phone :
                        field.fieldType === sdk.ItemFieldType.Url ? sdk.ItemFieldType.Url :
                        field.fieldType === sdk.ItemFieldType.Menu ? sdk.ItemFieldType.Menu :
                        sdk.ItemFieldType.Text,
              value: field.value || ""
            };
            
            // Preserve sectionId for all fields to maintain exact structure
            if (field.sectionId !== undefined) {
              newField.sectionId = field.sectionId;
            }

            if (field.fieldType === sdk.ItemFieldType.Address && field.details && field.details.content) {
              newField.details = {
                type: "Address",
                content: {
                  street: field.details.content.street || "",
                  city: field.details.content.city || "",
                  country: field.details.content.country || "",
                  zip: field.details.content.zip || "",
                  state: field.details.content.state || ""
                }
              };
              newField.value = "";
            } else if (field.fieldType === sdk.ItemFieldType.SshKey && field.details && field.details.content) {
              newField.value = field.details.content.privateKey || field.value || "";
            } else if (field.fieldType === sdk.ItemFieldType.Totp) {
              const totpValue = field.value || field.details?.content?.totp || "";
              const isValidTotpUri = totpValue.startsWith("otpauth://totp/");
              const isPotentialTotpSeed = /^[A-Z2-7]{16,32}$/i.test(totpValue);
              if (isValidTotpUri || isPotentialTotpSeed) {
                newField.value = totpValue;
              } else {
                newField.fieldType = sdk.ItemFieldType.Text;
                newField.value = totpValue;
              }
            } else if (field.fieldType === sdk.ItemFieldType.Date || field.fieldType === sdk.ItemFieldType.MonthYear) {
              newField.value = field.value || "";
            }

            return newField;
          });
        } else if (item.category === sdk.ItemCategory.SecureNote) {
          newItem.notes = item.notes || "Migrated Secure Note";
        }

        // Handle sections - preserve ALL sections with their exact structure and order
        if (item.sections && item.sections.length > 0) {
          newItem.sections = item.sections.map(section => ({
            id: section.id,
            title: section.title || section.label || ""
          }));
        }

        // Handle files
        if (item.files && item.files.length > 0) {
          newItem.files = [];
          const fileSectionIds = new Set();
          
          for (const [index, file] of item.files.entries()) {
            try {
              const fileName = file.name;
              const fileContent = file.content;
              const fileSectionId = file.sectionId || "add more";
              const fileFieldId = file.fieldId || `${fileName}-${Date.now()}-${index}`;

              if (fileName && fileContent) {
                newItem.files.push({
                  name: fileName,
                  content: fileContent instanceof Uint8Array ? fileContent : new Uint8Array(fileContent),
                  sectionId: fileSectionId,
                  fieldId: fileFieldId
                });
                fileSectionIds.add(fileSectionId);
              }
            } catch (fileError) {
              logger.warning(vaultId, `File processing failed for ${item.title}: ${fileError.message}`);
            }
          }

          if (!newItem.sections) newItem.sections = [];
          for (const sectionId of fileSectionIds) {
            if (!newItem.sections.some(section => section.id === sectionId)) {
              newItem.sections.push({ id: sectionId, title: sectionId === "add more" ? "" : sectionId });
            }
          }
        }

        // Handle tags and websites
        if (item.tags && item.tags.length > 0) {
          newItem.tags = item.tags;
        }
        
        if (item.websites && item.websites.length > 0) {
          newItem.websites = item.websites.map(website => ({
            url: website.url || website.href || "",
            label: website.label || "website",
            autofillBehavior: website.autofillBehavior || sdk.AutofillBehavior.AnywhereOnWebsite
          }));
        }

        // Create the item
        await retryWithBackoff(() => destSDK.client.items.create(newItem));

        processedItems++;
        successCount++;
        migrationResults.push({ 
          id: item.id, 
          title: item.title, 
          success: true, 
          progress: (processedItems / items.length) * 100 
        });
        logEntry.itemResults.push({ id: item.id, title: item.title, success: true });
        logger.info(vaultId, `Successfully migrated item [${item.id}] "${item.title}"`, { itemId: item.id, itemTitle: item.title });

        // Send progress update every 3 items or on last item
        if (processedItems % 3 === 0 || processedItems === items.length) {
          onProgress(processedItems, items.length, successCount, failureCount);
        }

      } catch (error) {
        processedItems++;
        failureCount++;
        logger.logFailedItem(vaultId, vaultName, item.id, item.title, error);
        migrationResults.push({ 
          id: item.id, 
          title: item.title, 
          success: false, 
          error: error.message, 
          progress: (processedItems / items.length) * 100 
        });
        logEntry.errors.push(`Item ${item.id} (${item.title}): ${error.message}`);
        logEntry.itemResults.push({ 
          id: item.id, 
          title: item.title, 
          success: false, 
          error: error.message 
        });
        
        // Send progress update for failures too
        if (processedItems % 3 === 0 || processedItems === items.length) {
          onProgress(processedItems, items.length, successCount, failureCount);
        }
      }
    }

    // Get destination item count
    const destItemCount = await getVaultItemCount(newVaultId, destToken, vaultName);
    logEntry.destItemCount = destItemCount;
    logEntry.status = 'completed';
    logEntry.successCount = successCount;
    logEntry.failureCount = failureCount;
    
    logger.info(vaultId, `Destination item count: ${destItemCount}`);
    logger.info(vaultId, `Migration completed - Success: ${successCount}, Failed: ${failureCount}`);

    // Log vault statistics for summary
    logger.logVaultComplete(vaultId, vaultName, {
      sourceItemCount,
      destItemCount,
      successCount,
      failureCount
    });

    if (sourceItemCount === destItemCount && failureCount === 0) {
      logger.info(vaultId, `Successfully migrated all ${sourceItemCount} items`);
    } else {
      logger.warning(vaultId, 
        `Item count mismatch - Source: ${sourceItemCount}, Destination: ${destItemCount}, Failed: ${failureCount}`
      );
    }

    return { 
      itemsLength: items.length, 
      migrationResults, 
      sourceItemCount, 
      destItemCount,
      successCount,
      failureCount
    };
    
  } catch (error) {
    logger.error(vaultId, `Vault migration failed: ${error.message}`);
    logEntry.status = 'failed';
    logEntry.errors.push(`Vault migration: ${error.message}`);
    throw error;
  }
}

// Endpoint to download accumulated migration log
app.get('/migration/download-log', (req, res) => {
  const logContent = logger.getGlobalLog();
  const summary = logger.getSummary();
  const vaultStatsSummary = logger.getVaultStatsSummary();
  const failureSummary = logger.getFailureSummary();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  logger.info(null, 'Accumulated migration log downloaded');
  
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename=migration-log-${timestamp}.txt`);
  res.send(`1Password Vault Migration Log
Generated: ${new Date().toISOString()}
Total Entries: ${summary.totalEntries}
Errors: ${summary.errors}
Warnings: ${summary.warnings}
Vaults Processed: ${summary.vaults}
Failed Items: ${summary.failedItems}

${'='.repeat(80)}

${vaultStatsSummary}
${failureSummary}

${'='.repeat(80)}
DETAILED LOG
${'='.repeat(80)}

${logContent}`);
});

// Endpoint to download individual vault log
app.get('/migration/download-vault-log/:vaultId', (req, res) => {
  const { vaultId } = req.params;
  const logContent = logger.getVaultLog(vaultId);
  
  if (!logContent) {
    logger.error(null, `No log found for vault ${vaultId}`);
    return res.status(404).send('No log found for this vault');
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  logger.info(vaultId, `Vault log downloaded`);
  
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename=vault-${vaultId}-log-${timestamp}.txt`);
  res.send(`1Password Vault Migration Log
Vault ID: ${vaultId}
Generated: ${new Date().toISOString()}

${'='.repeat(80)}

${logContent}`);
});

// Get migration statistics
app.get('/migration/stats', (req, res) => {
  const summary = logger.getSummary();
  res.json(summary);
});

// Clear logs endpoint
app.post('/migration/clear-logs', (req, res) => {
  logger.clear();
  res.json({ success: true, message: 'Logs cleared successfully' });
});

// Custom class to handle 1Password SDK interactions
class OnePasswordSDK {
  constructor(token) {
    this.token = token;
    this.client = null;
  }

  async initializeClient() {
    if (!this.token) {
      throw new Error('Service account token is required.');
    }
    
    try {
      logger.info(null, 'Initializing 1Password SDK client');
      this.client = await sdk.createClient({
        auth: this.token,
        integrationName: "1Password Vault Migration Tool",
        integrationVersion: "2.0.0",
      });
    } catch (error) {
      logger.error(null, `Failed to initialize client: ${error.message}`);
      throw new Error(`Failed to initialize client: ${error.message}`);
    }
  }

  async listVaults() {
    try {
      if (!this.client) await this.initializeClient();
      const vaults = await this.client.vaults.list();
      const vaultList = vaults.map(vault => ({ id: vault.id, name: vault.title }));
      logger.info(null, `Listed ${vaultList.length} vaults`);
      return vaultList;
    } catch (error) {
      logger.error(null, `Failed to list vaults: ${error.message}`);
      throw new Error(`Failed to list vaults: ${error.message}`);
    }
  }

  async listVaultItems(vaultId) {
    try {
      if (!this.client) await this.initializeClient();
      logger.info(vaultId, `Listing items for vault`);
      
      const itemOverviews = await this.client.items.list(vaultId);
      const itemSummaries = itemOverviews.map(item => ({
        id: item.id,
        title: item.title,
        category: item.category
      }));

      const limit = pLimit(ITEM_CONCURRENCY_LIMIT);
      const itemPromises = itemSummaries.map(summary =>
        limit(async () => {
          try {
            const fullItem = await retryWithBackoff(() => this.client.items.get(vaultId, summary.id));
            const websites = fullItem.urls || fullItem.websites || fullItem.websiteUrls || [];
            const itemData = {
              id: fullItem.id,
              title: fullItem.title,
              category: fullItem.category,
              vaultId: fullItem.vaultId,
              fields: fullItem.fields || [],
              sections: fullItem.sections || [],
              tags: fullItem.tags || [],
              websites: websites,
              notes: fullItem.notes || ""
            };

            if (itemData.fields) {
              itemData.fields = itemData.fields.map(field => {
                if (field.fieldType === sdk.ItemFieldType.Address && field.details && field.details.content) {
                  return {
                    ...field,
                    details: {
                      content: {
                        street: field.details.content.street || "",
                        city: field.details.content.city || "",
                        state: field.details.content.state || "",
                        zip: field.details.content.zip || "",
                        country: field.details.content.country || ""
                      }
                    }
                  };
                } else if (field.fieldType === sdk.ItemFieldType.SshKey && field.details && field.details.content) {
                  return {
                    ...field,
                    details: {
                      content: {
                        privateKey: field.details.content.privateKey || field.value || "",
                        publicKey: field.details.content.publicKey || "",
                        fingerprint: field.details.content.fingerprint || "",
                        keyType: field.details.content.keyType || ""
                      }
                    }
                  };
                } else if (field.fieldType === sdk.ItemFieldType.Totp) {
                  return {
                    ...field,
                    value: field.details?.content?.totp || field.value || "",
                    details: field.details || {}
                  };
                }
                return field;
              });
            }

            if (fullItem.files && fullItem.files.length > 0) {
              const filePromises = fullItem.files.map(file =>
                retryWithBackoff(() => this.client.items.files.read(vaultId, fullItem.id, file.attributes))
                  .then(fileContent => ({
                    name: file.attributes.name,
                    content: fileContent,
                    sectionId: file.sectionId,
                    fieldId: file.fieldId
                  }))
                  .catch(err => {
                    logger.warning(vaultId, `Failed to read file ${file.attributes.name}: ${err.message}`);
                    return null;
                  })
              );
              itemData.files = (await Promise.all(filePromises)).filter(f => f !== null);
            }

            if (fullItem.category === sdk.ItemCategory.Document && fullItem.document) {
              try {
                const documentContent = await retryWithBackoff(() => 
                  this.client.items.files.read(vaultId, fullItem.id, fullItem.document)
                );
                itemData.document = { name: fullItem.document.name, content: documentContent };
              } catch (docError) {
                logger.warning(vaultId, `Failed to read document for ${fullItem.title}: ${docError.message}`);
              }
            }

            return itemData;
          } catch (itemError) {
            logger.error(vaultId, `Failed to get item ${summary.id}: ${itemError.message}`);
            return null;
          }
        })
      );

      const items = (await Promise.all(itemPromises)).filter(item => item !== null);
      logger.info(vaultId, `Listed ${items.length} items successfully`);
      return items;
      
    } catch (error) {
      logger.error(vaultId, `Failed to list items: ${error.message}`);
      throw new Error(`Failed to list items for vault ${vaultId}: ${error.message}`);
    }
  }
}

// Start the HTTPS server
const PORT = 3001;
const attrs = [{ name: 'commonName', value: 'localhost' }];
const opts = { keySize: 2048, algorithm: 'sha256', days: 365 };

try {
  // Generate self-signed certificate (selfsigned v5+ returns a Promise)
  const pems = await selfsigned.generate(attrs, opts);

  const options = {
    key: pems.private,
    cert: pems.cert,
  };

  https.createServer(options, app).listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   1Password Vault Migration Tool v2.0                        ║
║   Server started successfully on port ${PORT}                    ║
║   Access at: https://localhost:${PORT}                          ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `);
    logger.info(null, `Server started on port ${PORT}`);
  });
} catch (error) {
  console.error('Fatal error starting server:', error);
  logger.error(null, `Fatal error starting server: ${error.message}`);
  process.exit(1);
}