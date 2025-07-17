class BackupManager {
    constructor() {
        this.servers = JSON.parse(localStorage.getItem('servers')) || [];
        this.currentTheme = localStorage.getItem('theme') || 'light';
        this.socket = null;
        this.currentBackupSession = null;
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupTheme();
        this.updateStats();
        this.renderServers();
        this.loadRecentActivity();
        this.initializeSocket();
    }

    initializeSocket() {
        this.socket = io();
        
        this.socket.on('connect', () => {
            console.log('Connected to backup server');
            this.addActivity('Connected to backup server');
        });
        
        this.socket.on('disconnect', () => {
            console.log('Disconnected from backup server');
            this.addActivity('Disconnected from backup server');
        });
        
        this.socket.on('backup_progress', (data) => {
            this.handleBackupProgress(data);
        });
        
        this.socket.on('backup_session_started', (data) => {
            console.log('Backup session started:', data);
        });
    }

    handleBackupProgress(data) {
        const { type, message, progress, current_file, file_progress, stats, timestamp } = data;
        
        // Update progress bar
        if (progress !== null && progress !== undefined) {
            document.getElementById('progressFill').style.width = `${progress}%`;
            document.getElementById('progressPercentage').textContent = `${Math.floor(progress)}%`;
        }
        
        // Update status message
        if (message) {
            document.getElementById('progressStatus').textContent = message;
        }
        
        // Update current file
        if (current_file) {
            document.getElementById('currentFileName').textContent = current_file;
            
            // Animate file progress
            if (file_progress !== null && file_progress !== undefined) {
                document.getElementById('fileProgressFill').style.width = `${file_progress}%`;
            } else {
                // Simulate file progress
                this.animateFileProgress();
            }
        }
        
        // Update stats
        if (stats) {
            if (stats.files_processed !== undefined) {
                document.getElementById('filesProcessed').textContent = stats.files_processed;
            }
            if (stats.total_size_mb !== undefined) {
                document.getElementById('dataSize').textContent = `${stats.total_size_mb} MB`;
            }
            if (stats.total_files !== undefined) {
                this.totalFiles = stats.total_files;
            }
        }
        
        // Add to log
        this.addBackupLog(type, `[${timestamp}] ${message}`);
        
        // Handle completion
        if (progress === 100 || type === 'success' && message.includes('completed')) {
            this.completeBackupProgress();
        } else if (type === 'error') {
            this.failBackupProgress(message);
        }
    }

    animateFileProgress() {
        const fileProgressFill = document.getElementById('fileProgressFill');
        let currentWidth = 0;
        const targetWidth = 100;
        const duration = 2000; // 2 seconds
        const steps = 50;
        const increment = targetWidth / steps;
        const stepDuration = duration / steps;
        
        const animate = () => {
            if (currentWidth < targetWidth) {
                currentWidth += increment;
                fileProgressFill.style.width = `${Math.min(currentWidth, targetWidth)}%`;
                setTimeout(animate, stepDuration);
            }
        };
        
        animate();
    }

    async startBackup(serverId) {
        const server = this.servers.find(s => s.id === serverId);
        if (!server) return;

        // Show progress modal
        this.showBackupProgressModal(server);
        
        // Start backup session with socket
        this.currentBackupSession = this.socket.id;
        this.socket.emit('start_backup_session', {
            serverName: server.name
        });
        
        // Mark server as backing up
        const serverCard = document.querySelector(`[data-server-id="${serverId}"]`);
        if (serverCard) {
            serverCard.classList.add('backing-up');
        }

        try {
            this.addActivity(`Starting backup for "${server.name}"...`);
            this.addBackupLog('info', 'Initializing backup process...');
            
            const response = await fetch('/api/start-backup', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    serverName: server.name,
                    address: server.address,
                    username: server.username,
                    password: server.password,
                    paths: server.backupPaths,
                    sessionId: this.currentBackupSession
                })
            });

            const result = await response.json();
            
            if (result.success) {
                this.addActivity(`Backup started for "${server.name}"`);
                // Progress will be handled by WebSocket events
            } else {
                this.failBackupProgress(result.error);
                this.addActivity(`Backup failed for "${server.name}": ${result.error}`);
            }
        } catch (error) {
            console.error('Backup failed:', error);
            this.failBackupProgress('Network error');
            this.addActivity(`Backup failed for "${server.name}": Network error`);
        } finally {
            // Remove backing up state will be handled by completion events
        }
    }

    completeBackupProgress() {
        // Update UI for completion
        document.getElementById('progressStatus').textContent = 'Backup completed successfully!';
        document.getElementById('currentFileName').textContent = 'Backup completed';
        
        // Show complete button
        document.getElementById('cancelBackupBtn').style.display = 'none';
        document.getElementById('completeBackupBtn').style.display = 'inline-flex';
        document.getElementById('completeBackupBtn').textContent = 'Complete';
        document.getElementById('completeBackupBtn').className = 'btn btn-success';
        
        // Add success animation
        const modal = document.querySelector('.backup-progress-modal');
        modal.classList.add('backup-success');
        setTimeout(() => {
            modal.classList.remove('backup-success');
        }, 600);
        
        // Update server data
        if (this.currentBackupSession) {
            const serverName = document.getElementById('backupServerName').textContent;
            const server = this.servers.find(s => s.name === serverName);
            if (server) {
                server.lastBackup = new Date().toISOString();
                this.saveServers();
                this.updateStats();
                this.renderServers();
            }
        }
        
        // Remove backing up state
        document.querySelectorAll('.server-card.backing-up').forEach(card => {
            card.classList.remove('backing-up');
        });
    }

    failBackupProgress(error) {
        document.getElementById('progressStatus').textContent = 'Backup failed!';
        document.getElementById('currentFileName').textContent = 'Error occurred';
        document.getElementById('progressFill').style.background = 'var(--danger-color)';
        
        // Show complete button
        document.getElementById('cancelBackupBtn').style.display = 'none';
        document.getElementById('completeBackupBtn').style.display = 'inline-flex';
        document.getElementById('completeBackupBtn').textContent = 'Close';
        document.getElementById('completeBackupBtn').className = 'btn btn-danger';
        
        // Remove backing up state
        document.querySelectorAll('.server-card.backing-up').forEach(card => {
            card.classList.remove('backing-up');
        });
    }

    addBackupLog(type, message) {
        const logContainer = document.getElementById('logContainer');
        
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.innerHTML = `<span class="log-message">${message}</span>`;
        
        logContainer.appendChild(logEntry);
        logContainer.scrollTop = logContainer.scrollHeight;
        
        // Keep only last 100 log entries
        const entries = logContainer.querySelectorAll('.log-entry');
        if (entries.length > 100) {
            entries[0].remove();
        }
    }

    setupEventListeners() {
        // Menu navigation
        document.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                this.switchSection(e.currentTarget.dataset.section);
            });
        });

        // Theme toggle
        document.getElementById('themeToggle').addEventListener('click', () => {
            this.toggleTheme();
        });

        // Add server modal
        document.getElementById('addServerBtn').addEventListener('click', () => {
            this.showAddServerModal();
        });

        document.getElementById('closeModal').addEventListener('click', () => {
            this.hideAddServerModal();
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
            this.hideAddServerModal();
        });

        // Add server form
        document.getElementById('addServerForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.addServer();
        });

        // Settings
        document.getElementById('saveSettings').addEventListener('click', () => {
            this.saveSettings();
        });

        // Close modal on outside click
        document.getElementById('addServerModal').addEventListener('click', (e) => {
            if (e.target.id === 'addServerModal') {
                this.hideAddServerModal();
            }
        });
    }

    setupTheme() {
        document.documentElement.setAttribute('data-theme', this.currentTheme);
        const themeToggle = document.getElementById('themeToggle');
        const icon = themeToggle.querySelector('i');
        const text = themeToggle.querySelector('span');
        
        if (this.currentTheme === 'dark') {
            icon.className = 'fas fa-sun';
            text.textContent = 'Light Mode';
        } else {
            icon.className = 'fas fa-moon';
            text.textContent = 'Dark Mode';
        }
    }

    toggleTheme() {
        this.currentTheme = this.currentTheme === 'light' ? 'dark' : 'light';
        localStorage.setItem('theme', this.currentTheme);
        this.setupTheme();
    }

    switchSection(section) {
        // Update menu
        document.querySelectorAll('.menu-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-section="${section}"]`).classList.add('active');

        // Update content
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById(section).classList.add('active');

        // Update page title
        const titles = {
            dashboard: 'Dashboard',
            servers: 'Servers',
            backups: 'Backups',
            settings: 'Settings'
        };
        document.getElementById('pageTitle').textContent = titles[section];
    }

    showAddServerModal() {
        document.getElementById('addServerModal').classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    hideAddServerModal() {
        document.getElementById('addServerModal').classList.remove('show');
        document.body.style.overflow = 'auto';
        document.getElementById('addServerForm').reset();
    }

    addServer() {
        const formData = new FormData(document.getElementById('addServerForm'));
        const server = {
            id: Date.now().toString(),
            name: document.getElementById('serverName').value,
            address: document.getElementById('serverAddress').value,
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
            backupPaths: document.getElementById('backupPaths').value.split('\n').filter(path => path.trim()),
            status: 'offline',
            lastBackup: null,
            createdAt: new Date().toISOString()
        };

        this.servers.push(server);
        this.saveServers();
        this.updateStats();
        this.renderServers();
        this.hideAddServerModal();
        this.addActivity(`Server "${server.name}" added successfully`);
        
        // Test connection
        this.testServerConnection(server.id);
    }

    async testServerConnection(serverId) {
        const server = this.servers.find(s => s.id === serverId);
        if (!server) return;

        try {
            const response = await fetch('/api/test-connection', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    address: server.address,
                    username: server.username,
                    password: server.password
                })
            });

            const result = await response.json();
            server.status = result.success ? 'online' : 'offline';
            this.saveServers();
            this.updateStats();
            this.renderServers();
            
            if (result.success) {
                this.addActivity(`Connection to "${server.name}" established`);
            } else {
                this.addActivity(`Failed to connect to "${server.name}": ${result.error}`);
            }
        } catch (error) {
            console.error('Connection test failed:', error);
            server.status = 'offline';
            this.saveServers();
            this.renderServers();
            this.addActivity(`Connection test failed for "${server.name}"`);
        }
    }

    showBackupProgressModal(server) {
        document.getElementById('backupServerName').textContent = server.name;
        document.getElementById('backupServerAddress').textContent = server.address;
        document.getElementById('backupProgressModal').classList.add('show');
        document.body.style.overflow = 'hidden';
        
        // Reset progress
        this.resetBackupProgress();
        
        // Setup modal event listeners
        this.setupProgressModalListeners();
    }

    hideBackupProgressModal() {
        document.getElementById('backupProgressModal').classList.remove('show');
        document.body.style.overflow = 'auto';
        this.stopProgressSimulation();
    }

    setupProgressModalListeners() {
        document.getElementById('closeProgressModal').onclick = () => {
            this.hideBackupProgressModal();
        };
        
        document.getElementById('clearLogBtn').onclick = () => {
            document.getElementById('logContainer').innerHTML = '';
        };
        
        document.getElementById('completeBackupBtn').onclick = () => {
            this.hideBackupProgressModal();
        };
    }

    resetBackupProgress() {
        document.getElementById('progressFill').style.width = '0%';
        document.getElementById('progressPercentage').textContent = '0%';
        document.getElementById('progressStatus').textContent = 'Initializing...';
        document.getElementById('currentFileName').textContent = 'Preparing...';
        document.getElementById('fileProgressFill').style.width = '0%';
        document.getElementById('elapsedTime').textContent = '00:00';
        document.getElementById('filesProcessed').textContent = '0';
        document.getElementById('dataSize').textContent = '0 MB';
        document.getElementById('logContainer').innerHTML = '';
        document.getElementById('cancelBackupBtn').style.display = 'inline-flex';
        document.getElementById('completeBackupBtn').style.display = 'none';
    }

    startProgressSimulation() {
        this.backupStartTime = Date.now();
        this.currentProgress = 0;
        this.filesProcessed = 0;
        this.dataSize = 0;
        
        // Simulate file processing
        this.progressInterval = setInterval(() => {
            this.updateBackupProgress();
        }, 500);
        
        // Update elapsed time
        this.timeInterval = setInterval(() => {
            this.updateElapsedTime();
        }, 1000);
    }

    stopProgressSimulation() {
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
        if (this.timeInterval) {
            clearInterval(this.timeInterval);
            this.timeInterval = null;
        }
    }

    updateBackupProgress() {
        if (this.currentProgress < 90) {
            // Simulate progress
            this.currentProgress += Math.random() * 5;
            this.filesProcessed += Math.floor(Math.random() * 3) + 1;
            this.dataSize += Math.random() * 2;
            
            // Update UI
            document.getElementById('progressFill').style.width = `${this.currentProgress}%`;
            document.getElementById('progressPercentage').textContent = `${Math.floor(this.currentProgress)}%`;
            document.getElementById('filesProcessed').textContent = this.filesProcessed;
            document.getElementById('dataSize').textContent = `${this.dataSize.toFixed(1)} MB`;
            
            // Simulate current file
            const files = [
                '/home/user/documents/file1.txt',
                '/home/user/documents/file2.pdf',
                '/var/www/html/index.html',
                '/etc/nginx/nginx.conf',
                '/home/user/photos/image.jpg'
            ];
            const currentFile = files[Math.floor(Math.random() * files.length)];
            document.getElementById('currentFileName').textContent = currentFile;
            
            // Update file progress
            const fileProgress = Math.random() * 100;
            document.getElementById('fileProgressFill').style.width = `${fileProgress}%`;
            
            // Add random log entries
            if (Math.random() > 0.7) {
                this.addBackupLog('info', `Processing: ${currentFile}`);
            }
        }
    }

    updateElapsedTime() {
        const elapsed = Math.floor((Date.now() - this.backupStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        document.getElementById('elapsedTime').textContent = 
            `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    completeBackupProgress(server) {
        this.stopProgressSimulation();
        
        // Complete progress
        document.getElementById('progressFill').style.width = '100%';
        document.getElementById('progressPercentage').textContent = '100%';
        document.getElementById('progressStatus').textContent = 'Backup completed successfully!';
        document.getElementById('currentFileName').textContent = 'Creating archive...';
        document.getElementById('fileProgressFill').style.width = '100%';
        
        // Show complete button
        document.getElementById('cancelBackupBtn').style.display = 'none';
        document.getElementById('completeBackupBtn').style.display = 'inline-flex';
        
        // Add success animation
        const modal = document.querySelector('.backup-progress-modal');
        modal.classList.add('backup-success');
        setTimeout(() => {
            modal.classList.remove('backup-success');
        }, 600);
    }

    failBackupProgress(error) {
        this.stopProgressSimulation();
        
        document.getElementById('progressStatus').textContent = 'Backup failed!';
        document.getElementById('currentFileName').textContent = 'Error occurred';
        document.getElementById('progressFill').style.background = 'var(--danger-color)';
        
        // Show complete button
        document.getElementById('cancelBackupBtn').style.display = 'none';
        document.getElementById('completeBackupBtn').style.display = 'inline-flex';
        document.getElementById('completeBackupBtn').textContent = 'Close';
        document.getElementById('completeBackupBtn').className = 'btn btn-danger';
    }

    addBackupLog(type, message) {
        const logContainer = document.getElementById('logContainer');
        const timestamp = new Date().toLocaleTimeString();
        
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.innerHTML = `
            <span class="log-timestamp">[${timestamp}]</span>
            <span class="log-message">${message}</span>
        `;
        
        logContainer.appendChild(logEntry);
        logContainer.scrollTop = logContainer.scrollHeight;
        
        // Keep only last 50 log entries
        const entries = logContainer.querySelectorAll('.log-entry');
        if (entries.length > 50) {
            entries[0].remove();
        }
    }

    deleteServer(serverId) {
        if (confirm('Are you sure you want to delete this server?')) {
            const server = this.servers.find(s => s.id === serverId);
            this.servers = this.servers.filter(s => s.id !== serverId);
            this.saveServers();
            this.updateStats();
            this.renderServers();
            this.addActivity(`Server "${server.name}" deleted`);
        }
    }

    renderServers() {
        const serversList = document.getElementById('serversList');
        
        if (this.servers.length === 0) {
            serversList.innerHTML = '<p class="no-data">No servers configured. Click "Add Server" to get started.</p>';
            return;
        }

        serversList.innerHTML = this.servers.map(server => `
            <div class="server-card">
                <div class="server-header">
                    <div class="server-name">${server.name}</div>
                    <div class="server-status ${server.status === 'online' ? 'status-online' : 'status-offline'}">
                        ${server.status === 'online' ? 'Online' : 'Offline'}
                    </div>
                </div>
                <div class="server-info">
                    <div class="info-item">
                        <i class="fas fa-server"></i>
                        <span>${server.address}</span>
                    </div>
                    <div class="info-item">
                        <i class="fas fa-user"></i>
                        <span>${server.username}</span>
                    </div>
                    <div class="info-item">
                        <i class="fas fa-folder"></i>
                        <span>${server.backupPaths.length} paths</span>
                    </div>
                    <div class="info-item">
                        <i class="fas fa-clock"></i>
                        <span>${server.lastBackup ? new Date(server.lastBackup).toLocaleDateString() : 'Never'}</span>
                    </div>
                </div>
                <div class="server-actions">
                    <button class="btn btn-primary" onclick="backupManager.testServerConnection('${server.id}')">
                        <i class="fas fa-plug"></i>
                        Test Connection
                    </button>
                    <button class="btn btn-success" onclick="backupManager.startBackup('${server.id}')" ${server.status !== 'online' ? 'disabled' : ''}>
                        <i class="fas fa-play"></i>
                        Start Backup
                    </button>
                    <button class="btn btn-danger" onclick="backupManager.deleteServer('${server.id}')">
                        <i class="fas fa-trash"></i>
                        Delete
                    </button>
                </div>
            </div>
        `).join('');
    }

    updateStats() {
        const totalServers = this.servers.length;
        const activeServers = this.servers.filter(s => s.status === 'online').length;
        const totalBackups = this.servers.filter(s => s.lastBackup).length;
        const lastBackupDate = this.servers
            .filter(s => s.lastBackup)
            .map(s => new Date(s.lastBackup))
            .sort((a, b) => b - a)[0];

        document.getElementById('totalServers').textContent = totalServers;
        document.getElementById('activeServers').textContent = activeServers;
        document.getElementById('totalBackups').textContent = totalBackups;
        document.getElementById('lastBackup').textContent = lastBackupDate 
            ? lastBackupDate.toLocaleDateString() 
            : 'Never';
    }

    addActivity(message) {
        const activities = JSON.parse(localStorage.getItem('activities')) || [];
        activities.unshift({
            id: Date.now(),
            message,
            timestamp: new Date().toISOString()
        });
        
        // Keep only last 10 activities
        if (activities.length > 10) {
            activities.splice(10);
        }
        
        localStorage.setItem('activities', JSON.stringify(activities));
        this.loadRecentActivity();
    }

    loadRecentActivity() {
        const activities = JSON.parse(localStorage.getItem('activities')) || [];
        const activityList = document.getElementById('activityList');
        
        if (activities.length === 0) {
            activityList.innerHTML = '<p class="no-data">No recent activity</p>';
            return;
        }

        activityList.innerHTML = activities.map(activity => `
            <div class="activity-item" style="padding: 10px 0; border-bottom: 1px solid var(--border-color);">
                <div style="font-weight: 500;">${activity.message}</div>
                <div style="font-size: 12px; color: #7f8c8d; margin-top: 5px;">
                    ${new Date(activity.timestamp).toLocaleString()}
                </div>
            </div>
        `).join('');
    }

    saveSettings() {
        const settings = {
            backupInterval: document.getElementById('backupInterval').value,
            maxBackups: document.getElementById('maxBackups').value
        };
        
        localStorage.setItem('settings', JSON.stringify(settings));
        this.addActivity('Settings saved successfully');
        
        // Show success message
        const btn = document.getElementById('saveSettings');
        const originalText = btn.textContent;
        btn.textContent = 'Saved!';
        btn.style.backgroundColor = '#27ae60';
        
        setTimeout(() => {
            btn.textContent = originalText;
            btn.style.backgroundColor = '';
        }, 2000);
    }

    saveServers() {
        localStorage.setItem('servers', JSON.stringify(this.servers));
    }
}

// Initialize the application
const backupManager = new BackupManager();

// Auto-refresh server status every 5 minutes
setInterval(() => {
    backupManager.servers.forEach(server => {
        if (server.status === 'online') {
            backupManager.testServerConnection(server.id);
        }
    });
}, 5 * 60 * 1000);