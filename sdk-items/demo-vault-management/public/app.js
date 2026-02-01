// API Configuration
const API_BASE = 'http://localhost:3000/api';

// State
let currentTab = 'vaults';
let vaults = [];
let groups = [];
let selectedVaults = [];
let selectedGroup = null;
let user = null;
let isLoading = false;

document.addEventListener('DOMContentLoaded', () => {
    loadAccounts();
    
    const authBtn = document.getElementById('authBtn');
    if (!authBtn) {
        console.error('Auth button not found!');
        return;
    }
    
    authBtn.addEventListener('click', async () => {
        const btn = document.getElementById('authBtn');
        const errorDiv = document.getElementById('authError');
        const statusDiv = document.getElementById('authStatus');
        const accountSelect = document.getElementById('accountSelect');
        const selectedAccount = accountSelect?.value;
        
        if (!selectedAccount) {
            errorDiv.innerHTML = '<div class="alert alert-error">⚠️ Please select an account</div>';
            return;
        }
        
        btn.disabled = true;
        btn.innerHTML = '<span class="loader"></span> Connecting...';
        errorDiv.innerHTML = '';
        statusDiv.innerHTML = '';
        
        const es = new EventSource(`${API_BASE}/auth?account=${encodeURIComponent(selectedAccount)}`);

        es.onmessage = (event) => {
            const { step, message, user: authUser } = JSON.parse(event.data);

            if (step === 'error') {
                es.close();
                statusDiv.innerHTML = '';
                errorDiv.innerHTML = `<div class="alert alert-error">⚠️ ${message}</div>`;
                btn.disabled = false;
                btn.innerHTML = '🔐 Authenticate';
                return;
            }

            if (step === 'done') {
                es.close();
                user = authUser;
                statusDiv.innerHTML = '';
                document.getElementById('authScreen').classList.add('hidden');
                document.getElementById('app').classList.remove('hidden');
                document.getElementById('userEmail').textContent = user;
                document.getElementById('userInitial').textContent = user.charAt(0).toUpperCase();
                showLoadingState();
                loadInitialData();
                return;
            }

            // Live status updates for each step
            const icons = { signin: '🔐', groups: '👥', sdk: '🛡️' };
            btn.innerHTML = `<span class="loader"></span> ${message}`;
            statusDiv.innerHTML = `<p class="auth-step-text">${icons[step] || ''} ${message}</p>`;
        };

        es.onerror = () => {
            es.close();
            errorDiv.innerHTML = '<div class="alert alert-error">⚠️ Connection lost. Make sure the server is running.</div>';
            btn.disabled = false;
            btn.innerHTML = '🔐 Authenticate';
            statusDiv.innerHTML = '';
        };
    });

    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const tab = e.currentTarget.dataset.tab;
            currentTab = tab;
            
            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            e.currentTarget.classList.add('active');
            
            document.getElementById('topbarTitle').textContent = tab === 'vaults' ? 'Vaults' : 'Groups';
            selectedVaults = [];
            selectedGroup = null;
            updateBulkActionButton();
            
            if (tab === 'vaults') {
                renderVaultList();
            } else {
                renderGroupList();
            }
        });
    });

    document.getElementById('searchInput').addEventListener('input', () => {
        if (currentTab === 'vaults') {
            renderVaultList();
        } else if (!selectedGroup) {
            renderGroupList();
        }
    });

    document.getElementById('bulkActionBtn').addEventListener('click', () => {
        window.openBulkPermissions();
    });

    document.getElementById('bulkPermissionsSubmit').addEventListener('click', async () => {
        const selectedGroups = groups
            .filter(g => document.getElementById(`group-${g.id}`)?.checked)
            .map(g => g.id);
        
        if (selectedGroups.length === 0) {
            alert('Please select at least one group');
            return;
        }
        
        const permissions = {
            READ_ITEMS: document.getElementById('perm-view-items')?.checked || false,
            CREATE_ITEMS: document.getElementById('perm-create-items')?.checked || false,
            REVEAL_ITEM_PASSWORD: document.getElementById('perm-view-passwords')?.checked || false,
            UPDATE_ITEMS: document.getElementById('perm-edit-items')?.checked || false,
            ARCHIVE_ITEMS: document.getElementById('perm-archive-items')?.checked || false,
            DELETE_ITEMS: document.getElementById('perm-delete-items')?.checked || false,
            UPDATE_ITEM_HISTORY: document.getElementById('perm-view-history')?.checked || false,
            IMPORT_ITEMS: document.getElementById('perm-import-items')?.checked || false,
            EXPORT_ITEMS: document.getElementById('perm-export-items')?.checked || false,
            SEND_ITEMS: document.getElementById('perm-copy-share')?.checked || false,
            PRINT_ITEMS: document.getElementById('perm-print-items')?.checked || false,
            MANAGE_VAULT: document.getElementById('perm-manage-vault')?.checked || false
        };
        
        const submitBtn = document.getElementById('bulkPermissionsSubmit');
        const originalText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="loader"></span> Granting...';
        
        try {
            const response = await fetch(`${API_BASE}/vaults/bulk-grant-permissions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    vaultIds: selectedVaults, 
                    groupIds: selectedGroups,
                    permissions: permissions
                })
            });
            
            const result = await response.json();
            
            if (result.success) {
                submitBtn.innerHTML = '✅ Success!';
                submitBtn.style.background = '#10b981';
                
                await new Promise(resolve => setTimeout(resolve, 800));
                
                closeModal('bulkPermissionsModal');
                selectedVaults = [];
                updateBulkActionButton();
                renderVaultList();
                
                const groupNames = groups
                    .filter(g => selectedGroups.includes(g.id))
                    .map(g => g.name || g.id)
                    .join(', ');
                
                alert(`✅ Success!\n\nGranted permissions to:\n• ${selectedGroups.length} group(s): ${groupNames}\n• ${result.vaultsUpdated} vault(s)`);
            } else {
                alert('❌ Error granting permissions:\n\n' + (result.error || result.note || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error granting permissions:', error);
            alert('Error granting permissions: ' + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
        }
    });
});

function showLoadingState() {
    document.getElementById('loadingState').classList.remove('hidden');
    document.getElementById('listPanel').classList.add('hidden');
}

function hideLoadingState() {
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('listPanel').classList.remove('hidden');
}

async function loadInitialData() {
    isLoading = true;
    showLoadingState();
    
    await Promise.all([loadVaults(), loadGroups()]);
    
    isLoading = false;
    hideLoadingState();
    
    if (currentTab === 'vaults') {
        renderVaultList();
    } else {
        renderGroupList();
    }
}

async function loadAccounts() {
    try {
        const response = await fetch(`${API_BASE}/accounts`);
        const data = await response.json();
        
        const accountSelect = document.getElementById('accountSelect');
        if (!accountSelect) {
            console.error('Account select element not found');
            return;
        }
        
        if (data.accounts && data.accounts.length > 0) {
            accountSelect.innerHTML = '<option value="">Select an account...</option>' +
                data.accounts.map(account => 
                    `<option value="${account}">${account}</option>`
                ).join('');
        } else {
            document.getElementById('authError').innerHTML = 
                '<div class="alert alert-error">⚠️ No accounts configured. Set OP_ACCOUNT_NAMES in .env</div>';
        }
    } catch (error) {
        console.error('Error loading accounts:', error);
        document.getElementById('authError').innerHTML = 
            '<div class="alert alert-error">⚠️ Failed to load accounts: ' + error.message + '</div>';
    }
}

async function loadVaults() {
    try {
        const response = await fetch(`${API_BASE}/vaults`);
        const data = await response.json();
        vaults = data;
        
        document.getElementById('vaultsCount').textContent = vaults.length;
    } catch (error) {
        console.error('Error loading vaults:', error);
        vaults = [];
    }
}

async function loadGroups() {
    try {
        const response = await fetch(`${API_BASE}/groups`);
        const data = await response.json();
        groups = data;
        
        document.getElementById('groupsCount').textContent = groups.length;
    } catch (error) {
        console.error('Error loading groups:', error);
        groups = [];
    }
}

function toggleVaultSelection(vaultId) {
    const index = selectedVaults.indexOf(vaultId);
    if (index > -1) {
        selectedVaults.splice(index, 1);
    } else {
        selectedVaults.push(vaultId);
    }
    updateBulkActionButton();
    renderVaultList();
}

function updateBulkActionButton() {
    const bulkBtn = document.getElementById('bulkActionBtn');
    if (bulkBtn) {
        if (selectedVaults.length > 0) {
            bulkBtn.classList.remove('hidden');
            bulkBtn.textContent = `Grant Permissions (${selectedVaults.length})`;
        } else {
            bulkBtn.classList.add('hidden');
        }
    }
}

function renderVaultList() {
    const listPanel = document.getElementById('listPanel');
    if (!listPanel) return;
    
    listPanel.className = 'items-grid';
    
    if (!vaults || vaults.length === 0) {
        listPanel.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: var(--op-text-secondary); padding: 48px;">No vaults available</p>';
        return;
    }
    
    const searchInput = document.getElementById('searchInput');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
    const filtered = vaults.filter(v => v && v.name && v.name.toLowerCase().includes(searchTerm));
    
    if (filtered.length === 0) {
        listPanel.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: var(--op-text-secondary); padding: 48px;">No vaults found</p>';
        return;
    }
    
    listPanel.innerHTML = filtered.map(vault => {
        const isSelected = selectedVaults.includes(vault.id);
        return `
        <div class="card ${isSelected ? 'selected' : ''}" onclick="toggleVaultSelection('${vault.id}')">
            <div class="card-header">
                <input type="checkbox" class="card-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleVaultSelection('${vault.id}')">
                <div class="card-icon">📁</div>
                <div class="card-body">
                    <div class="card-title" title="${vault.name}">${vault.name}</div>
                    <div class="card-subtitle">${vault.type}</div>
                </div>
            </div>
        </div>
    `}).join('');
}

function selectGroup(groupId) {
    selectedGroup = groups.find(g => g.id === groupId);
    if (selectedGroup) {
        loadGroupVaults(groupId);
    }
}

function renderGroupList() {
    const listPanel = document.getElementById('listPanel');
    if (!listPanel) return;
    
    listPanel.className = 'items-grid';
    
    if (!groups || groups.length === 0) {
        listPanel.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: var(--op-text-secondary); padding: 48px;">No groups available</p>';
        return;
    }
    
    const searchInput = document.getElementById('searchInput');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
    const filtered = groups.filter(g => g && g.name && g.name.toLowerCase().includes(searchTerm));
    
    if (filtered.length === 0) {
        listPanel.innerHTML = '<p style="grid-column: 1 / -1; text-align: center; color: var(--op-text-secondary); padding: 48px;">No groups found</p>';
        return;
    }
    
    listPanel.innerHTML = filtered.map(group => `
        <div class="card ${selectedGroup?.id === group.id ? 'selected' : ''}" onclick="selectGroup('${group.id}')">
            <div class="card-header">
                <div class="card-icon">👥</div>
                <div class="card-body">
                    <div class="card-title" title="${group.name || group.id}">${group.name || group.id}</div>
                    <div class="card-subtitle">Click to view vaults</div>
                </div>
                <span style="color: var(--op-text-tertiary); font-size: 18px;">›</span>
            </div>
        </div>
    `).join('');
}

async function loadGroupVaults(groupId) {
    try {
        showLoadingState();
        const response = await fetch(`${API_BASE}/groups/${groupId}/vaults`);
        const data = await response.json();
        
        hideLoadingState();
        renderGroupVaults(data);
    } catch (error) {
        console.error('Error loading group vaults:', error);
        hideLoadingState();
    }
}

function renderGroupVaults(groupVaults) {
    const listPanel = document.getElementById('listPanel');
    if (!listPanel) return;
    
    listPanel.className = 'items-grid';
    
    if (groupVaults.length === 0) {
        listPanel.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 48px;">
                <p style="color: var(--op-text-secondary); margin-bottom: 16px;">No vaults accessible to this group</p>
                <button class="btn btn-secondary" onclick="backToGroups()">← Back to Groups</button>
            </div>
        `;
        return;
    }
    
    listPanel.innerHTML = `
        <div style="grid-column: 1 / -1; margin-bottom: 16px;">
            <button class="btn btn-secondary" onclick="backToGroups()">← Back to Groups</button>
        </div>
    ` + groupVaults.map(vault => `
        <div class="card">
            <div class="card-header">
                <div class="card-icon">📁</div>
                <div class="card-body">
                    <div class="card-title">${vault.name}</div>
                    <div class="card-subtitle">Permissions: ${vault.permissions}</div>
                </div>
            </div>
        </div>
    `).join('');
}

window.backToGroups = function() {
    selectedGroup = null;
    renderGroupList();
};

window.openBulkPermissions = function() {
    console.log('Opening bulk permissions modal...');
    console.log('Selected vaults:', selectedVaults);
    
    if (selectedVaults.length === 0) {
        alert('Please select at least one vault');
        return;
    }
    
    console.log('Groups available:', groups.length);
    renderGroupCheckboxes(groups);
    document.getElementById('groupSearch').value = '';
    document.getElementById('selectedVaultsCount').textContent = `${selectedVaults.length} vaults`;
    updateSelectedGroupsCount();
    
    console.log('Opening modal...');
    openModal('bulkPermissionsModal');
};

window.filterGroups = function() {
    const searchTerm = document.getElementById('groupSearch').value.toLowerCase();
    const filtered = groups.filter(g => g.name.toLowerCase().includes(searchTerm));
    renderGroupCheckboxes(filtered);
    updateSelectedGroupsCount();
};

window.selectAllGroups = function() {
    groups.forEach(g => {
        const checkbox = document.getElementById(`group-${g.id}`);
        if (checkbox) checkbox.checked = true;
    });
    updateSelectedGroupsCount();
};

window.clearAllGroups = function() {
    groups.forEach(g => {
        const checkbox = document.getElementById(`group-${g.id}`);
        if (checkbox) checkbox.checked = false;
    });
    updateSelectedGroupsCount();
};

function renderGroupCheckboxes(groupList) {
    const checkboxesHtml = groupList.map(group => `
        <div class="group-item" onclick="toggleGroupCheckbox('${group.id}')">
            <input type="checkbox" id="group-${group.id}" onclick="event.stopPropagation(); updateSelectedGroupsCount();">
            <div class="group-icon">👥</div>
            <div class="group-info">
                <div class="group-name">${group.name || group.id}</div>
                <div class="group-id">ID: ${group.id.substring(0, 12)}...</div>
            </div>
        </div>
    `).join('');
    
    document.getElementById('groupCheckboxes').innerHTML = groupList.length > 0 ? 
        checkboxesHtml : 
        '<p style="text-align: center; color: var(--op-text-secondary); padding: 20px;">No groups found</p>';
}

function updateSelectedGroupsCount() {
    const selectedCount = groups.filter(g => 
        document.getElementById(`group-${g.id}`)?.checked
    ).length;
    
    const countEl = document.getElementById('selectedGroupsCount');
    if (countEl) {
        countEl.textContent = `${selectedCount} selected`;
    }
}

window.toggleGroupCheckbox = function(groupId) {
    const checkbox = document.getElementById(`group-${groupId}`);
    if (checkbox) {
        checkbox.checked = !checkbox.checked;
        updateSelectedGroupsCount();
    }
};

// Permission dependencies - these auto-check required permissions when selecting higher-level ones
const permissionDeps = {
    'perm-view-items': [],
    'perm-create-items': ['perm-view-items'],
    'perm-view-passwords': ['perm-view-items'],
    'perm-edit-items': ['perm-view-items', 'perm-view-passwords'],
    'perm-archive-items': ['perm-view-items', 'perm-edit-items', 'perm-view-passwords'],
    'perm-delete-items': ['perm-view-items', 'perm-edit-items', 'perm-view-passwords'],
    'perm-view-history': ['perm-view-items', 'perm-view-passwords'],
    'perm-import-items': ['perm-view-items', 'perm-create-items'],
    'perm-export-items': ['perm-view-items', 'perm-view-history', 'perm-view-passwords'],
    'perm-copy-share': ['perm-view-items', 'perm-view-history', 'perm-view-passwords'],
    'perm-move-items': ['perm-view-items', 'perm-edit-items', 'perm-delete-items', 'perm-view-history', 'perm-view-passwords', 'perm-copy-share'],
    'perm-print-items': ['perm-view-items', 'perm-view-passwords', 'perm-view-history'],
    'perm-manage-vault': []
};

window.handlePermissionChange = function(permId) {
    const checkbox = document.getElementById(permId);
    
    if (checkbox.checked) {
        // When checking a permission, auto-check its dependencies
        const deps = permissionDeps[permId] || [];
        deps.forEach(depId => {
            const depCheckbox = document.getElementById(depId);
            if (depCheckbox && !depCheckbox.checked) {
                depCheckbox.checked = true;
            }
        });
    } else {
        // When unchecking, uncheck anything that depends on this
        Object.keys(permissionDeps).forEach(otherId => {
            const deps = permissionDeps[otherId];
            if (deps.includes(permId)) {
                const otherCheckbox = document.getElementById(otherId);
                if (otherCheckbox && otherCheckbox.checked) {
                    otherCheckbox.checked = false;
                }
            }
        });
    }
};

function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

window.closeModal = function(modalId) {
    document.getElementById(modalId).classList.remove('active');
};

// Allow clicking permission divs to toggle checkboxes
window.togglePermission = function(permId) {
    const checkbox = document.getElementById(permId);
    if (checkbox) {
        checkbox.checked = !checkbox.checked;
        handlePermissionChange(permId);
    }
};