import express from 'express';
import cors from 'cors';
import sdk from '@1password/sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let opClient = null;
let selectedAccount = null;

async function initializeClient(accountName) {
  try {
    if (!accountName) {
      throw new Error('Account name is required');
    }
    
    opClient = await sdk.createClient({
      auth: new sdk.DesktopAuth(accountName),
      integrationName: "vault-manager",
      integrationVersion: "1.0.0",
    });
    
    selectedAccount = accountName;
    return opClient;
  } catch (error) {
    throw new Error(`Failed to initialize 1Password client: ${error.message}`);
  }
}

app.get('/api/accounts', (req, res) => {
  try {
    const accountsEnv = process.env.OP_ACCOUNT_NAMES || process.env.OP_ACCOUNT_NAME;
    
    if (!accountsEnv) {
      return res.status(500).json({ 
        error: 'No accounts configured. Set OP_ACCOUNT_NAMES or OP_ACCOUNT_NAME in .env file' 
      });
    }
    
    const accounts = accountsEnv.split(',').map(a => a.trim()).filter(a => a);
    res.json({ accounts });
  } catch (error) {
    console.error('Error getting accounts:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Groups fetched during auth, served from memory after that
let accountGroups = [];

app.get('/api/auth', (req, res) => {
  const accountName = req.query.account;

  if (!accountName) {
    res.writeHead(400, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"step":"error","message":"No account selected"}\n\n');
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  (async () => {
    try {
      // Step 1: op signin
      send({ step: 'signin', message: 'Signing in to 1Password CLI...' });

      try {
        execSync(`op signin --account "${accountName}"`, {
          stdio: 'pipe',
          timeout: 30000
        });
      } catch (e) {
        execSync(`op account get --account "${accountName}"`, { stdio: 'pipe' });
      }

      send({ step: 'signin', message: 'Signed in successfully' });

      // Step 2: fetch groups via CLI
      send({ step: 'groups', message: 'Fetching groups...' });

      const groupsRaw = execSync(`op group list --format json --account "${accountName}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      const allGroups = JSON.parse(groupsRaw);
      accountGroups = allGroups
        .filter(g => g.name && g.name.toLowerCase() !== 'recovery')
        .map(g => ({ id: g.id, name: g.name }));

      send({ step: 'groups', message: `Found ${accountGroups.length} groups` });

      // Step 3: SDK auth
      send({ step: 'sdk', message: 'Authorizing SDK — check 1Password for a permission prompt...' });

      await initializeClient(accountName);

      send({ step: 'done', message: 'Authenticated', user: accountName, groups: accountGroups });
      res.end();

    } catch (error) {
      send({ step: 'error', message: error.message });
      res.end();
    }
  })();
});

app.get('/api/vaults', async (req, res) => {
  try {
    if (!opClient) {
      await initializeClient();
    }
    
    const vaults = await opClient.vaults.list();
    
    const formattedVaults = vaults.map(vault => ({
      id: vault.id,
      name: vault.title || vault.name || vault.id,
      description: vault.description || '',
      itemCount: 0,
      type: vault.type || 'USER_CREATED',
      createdAt: vault.createdAt
    }));
    
    res.json(formattedVaults);
  } catch (error) {
    console.error('Error fetching vaults:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/vaults/:vaultId/permissions', async (req, res) => {
  try {
    if (!opClient) {
      await initializeClient();
    }
    
    const vaultDetails = await opClient.vaults.get(req.params.vaultId, { accessors: true });
    
    res.json({
      groups: vaultDetails.accessors?.groups || [],
      users: vaultDetails.accessors?.users || []
    });
  } catch (error) {
    console.error('Error fetching vault permissions:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/vaults/bulk-grant-permissions', async (req, res) => {
  try {
    if (!opClient) {
      await initializeClient();
    }
    
    const { vaultIds, groupIds, permissions } = req.body;
    
    // Calculate permission bitmask
    let permissionValue = 0;
    if (permissions.READ_ITEMS) permissionValue |= sdk.READ_ITEMS;
    if (permissions.CREATE_ITEMS) permissionValue |= sdk.CREATE_ITEMS;
    if (permissions.REVEAL_ITEM_PASSWORD) permissionValue |= sdk.REVEAL_ITEM_PASSWORD;
    if (permissions.UPDATE_ITEMS) permissionValue |= sdk.UPDATE_ITEMS;
    if (permissions.ARCHIVE_ITEMS) permissionValue |= sdk.ARCHIVE_ITEMS;
    if (permissions.DELETE_ITEMS) permissionValue |= sdk.DELETE_ITEMS;
    if (permissions.UPDATE_ITEM_HISTORY) permissionValue |= sdk.UPDATE_ITEM_HISTORY;
    if (permissions.IMPORT_ITEMS) permissionValue |= sdk.IMPORT_ITEMS;
    if (permissions.EXPORT_ITEMS) permissionValue |= sdk.EXPORT_ITEMS;
    if (permissions.SEND_ITEMS) permissionValue |= sdk.SEND_ITEMS;
    if (permissions.PRINT_ITEMS) permissionValue |= sdk.PRINT_ITEMS;
    if (permissions.MANAGE_VAULT) permissionValue |= sdk.MANAGE_VAULT;
    
    if (permissionValue === 0) {
      permissionValue = sdk.READ_ITEMS | sdk.CREATE_ITEMS;
    }
    
    const results = [];
    let successCount = 0;
    
    for (const vaultId of vaultIds) {
      try {
        const groupAccessList = groupIds.map(groupId => ({
          groupId: groupId,
          permissions: permissionValue
        }));
        
        await opClient.vaults.grantGroupPermissions(vaultId, groupAccessList);
        
        successCount++;
        results.push({ 
          vaultId, 
          success: true, 
          groupsGranted: groupIds.length 
        });
      } catch (error) {
        results.push({ 
          vaultId, 
          success: false, 
          error: error.message 
        });
      }
    }
    
    res.json({ 
      success: successCount > 0, 
      vaultsUpdated: successCount,
      totalVaults: vaultIds.length,
      results: results
    });
  } catch (error) {
    console.error('Error granting permissions:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/vaults/:vaultId/revoke-permissions', async (req, res) => {
  try {
    if (!opClient) {
      await initializeClient();
    }
    
    const { groupId } = req.body;
    const vaultId = req.params.vaultId;
    
    await opClient.vaults.revokeGroupPermissions(vaultId, groupId);
    
    res.json({ success: true, message: 'Revoked permissions from group' });
  } catch (error) {
    console.error('Error revoking permissions:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/vaults/:vaultId', async (req, res) => {
  try {
    if (!opClient) {
      await initializeClient();
    }
    
    await opClient.vaults.delete(req.params.vaultId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting vault:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/groups/:groupId/vaults', async (req, res) => {
  try {
    if (!opClient) {
      await initializeClient();
    }
    
    const groupId = req.params.groupId;
    const allVaults = await opClient.vaults.list();
    const vaultsWithAccess = [];
    
    for (const vault of allVaults) {
      try {
        const vaultDetails = await opClient.vaults.get(vault.id, { accessors: true });
        
        if (vaultDetails.accessors?.groups) {
          const groupAccess = vaultDetails.accessors.groups.find(g => g.groupId === groupId);
          if (groupAccess) {
            vaultsWithAccess.push({
              id: vault.id,
              name: vault.title || vault.name || vault.id,
              permissions: groupAccess.permissions || 'Access granted'
            });
          }
        }
      } catch (error) {
      }
    }
    
    res.json(vaultsWithAccess);
  } catch (error) {
    console.error('Error fetching group vaults:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/groups', (req, res) => {
  res.json(accountGroups);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📱 Make sure 1Password desktop app is running`);
});