import paramiko
import os
import json
import zipfile
from datetime import datetime
import threading
import time
from pathlib import Path
import tempfile
import shutil

class BackupManager:
    def __init__(self):
        # Use absolute path for backup directory
        project_root = Path(__file__).parent.parent
        self.backup_dir = project_root / 'backup'
        self.backup_dir.mkdir(exist_ok=True)
        self.active_backups = {}
        
    def get_timestamp(self):
        return datetime.now().strftime('%H:%M:%S')
        
    def test_connection(self, address, username, password, port=22):
        """
        Test SSH connection to the server
        """
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            ssh.connect(
                hostname=address,
                username=username,
                password=password,
                port=port,
                timeout=10
            )
            
            # Test basic command
            stdin, stdout, stderr = ssh.exec_command('echo "Connection test successful"')
            result = stdout.read().decode().strip()
            
            ssh.close()
            
            if "Connection test successful" in result:
                return True, "Connection successful"
            else:
                return False, "Connection test failed"
                
        except paramiko.AuthenticationException:
            return False, "Authentication failed - Invalid username or password"
        except paramiko.SSHException as e:
            return False, f"SSH connection failed: {str(e)}"
        except Exception as e:
            return False, f"Connection failed: {str(e)}"
    
    def start_backup(self, server_name, address, username, password, paths, progress_callback=None, port=22):
        """
        Start backup process for specified paths with real-time progress
        """
        if server_name in self.active_backups:
            return False, "Backup already in progress for this server"
        
        # Start backup in a separate thread
        backup_thread = threading.Thread(
            target=self._perform_backup,
            args=(server_name, address, username, password, paths, progress_callback, port)
        )
        backup_thread.daemon = True
        backup_thread.start()
        
        self.active_backups[server_name] = {
            'status': 'running',
            'started_at': datetime.now().isoformat(),
            'thread': backup_thread,
            'progress': 0,
            'current_file': None,
            'files_processed': 0,
            'total_files': 0,
            'data_size': 0
        }
        
        return True, "Backup started successfully"
    
    def _perform_backup(self, server_name, address, username, password, paths, progress_callback=None, port=22):
        """
        Perform the actual backup process with detailed progress tracking
        """
        try:
            if progress_callback:
                progress_callback('info', f'Connecting to server {address}...', 0)
            
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            ssh.connect(
                hostname=address,
                username=username,
                password=password,
                port=port,
                timeout=30
            )
            
            if progress_callback:
                progress_callback('success', 'Connected successfully!', 5)
            
            sftp = ssh.open_sftp()
            
            # إنشاء مجلد النسخ الاحتياطي للخادم باسم الخادم
            server_backup_dir = self.backup_dir / server_name
            server_backup_dir.mkdir(exist_ok=True)
            
            # إنشاء نسخة احتياطية مع الطابع الزمني
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            backup_name = f"backup_{timestamp}.zip"
            backup_path = server_backup_dir / backup_name
            
            if progress_callback:
                progress_callback('info', 'Analyzing files and directories...', 10)
            
            # Count total files first
            total_files = 0
            file_list = []
            for path in paths:
                files_in_path = self._count_files(ssh, path)
                total_files += files_in_path
                file_list.extend(self._get_file_list(ssh, path))
            
            if progress_callback:
                progress_callback('info', f'Found {total_files} files to backup', 15, stats={'total_files': total_files})
            
            # Update active backup info
            if server_name in self.active_backups:
                self.active_backups[server_name]['total_files'] = total_files
            
            # إنشاء مجلد مؤقت للتحميل
            with tempfile.TemporaryDirectory() as temp_dir:
                temp_path = Path(temp_dir)
                
                files_processed = 0
                total_size = 0
                
                try:
                    # تحميل الملفات والمجلدات مع تتبع التقدم
                    for i, path in enumerate(paths):
                        try:
                            if progress_callback:
                                progress_callback('info', f'Processing path: {path}', 
                                               15 + (i * 60 // len(paths)), path)
                            
                            files_in_path, size_in_path = self._download_path_with_progress(
                                ssh, sftp, path, temp_path, progress_callback, 
                                files_processed, total_files
                            )
                            
                            files_processed += files_in_path
                            total_size += size_in_path
                            
                            if server_name in self.active_backups:
                                self.active_backups[server_name]['files_processed'] = files_processed
                                self.active_backups[server_name]['data_size'] = total_size
                            
                        except Exception as e:
                            if progress_callback:
                                progress_callback('error', f'Error backing up {path}: {str(e)}')
                            continue
                    
                    if progress_callback:
                        progress_callback('info', 'Creating ZIP archive...', 80)
                    
                    # إنشاء ملف ZIP مع تتبع التقدم
                    with zipfile.ZipFile(backup_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                        files_to_zip = []
                        for root, dirs, files in os.walk(temp_path):
                            for file in files:
                                files_to_zip.append((root, file))
                        
                        for i, (root, file) in enumerate(files_to_zip):
                            file_path = Path(root) / file
                            arcname = file_path.relative_to(temp_path)
                            try:
                                zipf.write(file_path, arcname)
                            except Exception as e:
                                if progress_callback:
                                    progress_callback('warning', f'Skipped file during compression: {arcname} - {str(e)}')
                                continue
                            
                            zip_progress = 80 + (i * 15 // len(files_to_zip))
                            if progress_callback and i % 10 == 0:  # Update every 10 files
                                progress_callback('info', f'Compressing: {arcname}', 
                                               zip_progress, str(arcname))
                
                except Exception as e:
                    # Force cleanup of temp directory
                    try:
                        # Close any open file handles
                        import gc
                        gc.collect()
                        time.sleep(0.1)  # Brief pause to allow file handles to close
                    except:
                        pass
                    raise e
            
            # حفظ البيانات الوصفية للنسخة الاحتياطية
            metadata = {
                'server_name': server_name,
                'server_address': address,
                'backup_name': backup_name,
                'backup_paths': paths,
                'created_at': datetime.now().isoformat(),
                'size_bytes': backup_path.stat().st_size,
                'files_count': files_processed
            }
            
            metadata_path = server_backup_dir / f"{backup_name}.json"
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f, indent=2)
            
            sftp.close()
            ssh.close()
            
            if progress_callback:
                progress_callback('success', f'Backup completed successfully! {files_processed} files backed up.', 
                               100, stats={
                                   'files_processed': files_processed,
                                   'total_size_mb': round(total_size / (1024 * 1024), 2),
                                   'backup_file': str(backup_path)
                               })
            
            # تحديث حالة النسخ الاحتياطي
            if server_name in self.active_backups:
                self.active_backups[server_name]['status'] = 'completed'
                self.active_backups[server_name]['completed_at'] = datetime.now().isoformat()
                self.active_backups[server_name]['backup_file'] = str(backup_path)
                self.active_backups[server_name]['progress'] = 100
            
            # تنظيف النسخ القديمة (الاحتفاظ بآخر 7)
            self._cleanup_old_backups(server_backup_dir)
            
        except Exception as e:
            error_msg = f"Backup failed for server {server_name}: {str(e)}"
            print(error_msg)
            if progress_callback:
                progress_callback('error', error_msg)
            
            if server_name in self.active_backups:
                self.active_backups[server_name]['status'] = 'failed'
                self.active_backups[server_name]['error'] = str(e)
    
    def _count_files(self, ssh, remote_path):
        """Count total files in a path"""
        try:
            stdin, stdout, stderr = ssh.exec_command(f'find "{remote_path}" -type f | wc -l')
            count = int(stdout.read().decode().strip())
            return count
        except:
            return 0
    
    def _get_file_list(self, ssh, remote_path):
        """Get list of all files in a path"""
        try:
            stdin, stdout, stderr = ssh.exec_command(f'find "{remote_path}" -type f')
            files = stdout.read().decode().strip().split('\n')
            return [f for f in files if f.strip()]
        except:
            return []
    
    def _download_path_with_progress(self, ssh, sftp, remote_path, local_base_path, progress_callback, files_processed, total_files):
        """
        تحميل مسار من الخادم البعيد مع تتبع التقدم
        """
        files_downloaded = 0
        total_size = 0
        
        try:
            # التحقق من وجود المسار ونوعه
            stdin, stdout, stderr = ssh.exec_command(f'test -e "{remote_path}" && echo "exists"')
            if "exists" not in stdout.read().decode():
                if progress_callback:
                    progress_callback('warning', f'Path does not exist: {remote_path}')
                return 0, 0
            
            # التحقق من كونه ملف أم مجلد
            stdin, stdout, stderr = ssh.exec_command(f'test -f "{remote_path}" && echo "file" || echo "dir"')
            path_type = stdout.read().decode().strip()
            
            # إنشاء المسار المحلي
            path_name = os.path.basename(remote_path)
            local_path = local_base_path / path_name
            
            if path_type == "file":
                # Skip problematic files like SQLite databases that might be locked
                if remote_path.lower().endswith(('.sqlite', '.sqlite3', '.db')):
                    if progress_callback:
                        progress_callback('warning', f'Skipping locked database file: {remote_path}')
                    return 0, 0
                
                # تحميل الملف
                if progress_callback:
                    progress_callback('info', f'Downloading: {remote_path}', 
                                   15 + (files_processed * 60 // total_files), remote_path)
                
                try:
                    sftp.get(remote_path, str(local_path))
                    file_size = local_path.stat().st_size
                    files_downloaded = 1
                    total_size = file_size
                    
                    if progress_callback:
                        progress_callback('success', f'Downloaded: {remote_path} ({file_size} bytes)')
                except Exception as e:
                    if progress_callback:
                        progress_callback('warning', f'Skipped locked file: {remote_path} - {str(e)}')
                    return 0, 0
                    
            else:
                # إنشاء المجلد المحلي
                local_path.mkdir(exist_ok=True)
                
                # تحميل محتويات المجلد
                try:
                    files = sftp.listdir(remote_path)
                    for file in files:
                        file_path = f"{remote_path}/{file}"
                        sub_files, sub_size = self._download_path_with_progress(
                            ssh, sftp, file_path, local_path, progress_callback, 
                            files_processed + files_downloaded, total_files
                        )
                        files_downloaded += sub_files
                        total_size += sub_size
                        
                except Exception as e:
                    if progress_callback:
                        progress_callback('error', f'Error accessing directory {remote_path}: {str(e)}')
                    
        except Exception as e:
            if progress_callback:
                progress_callback('error', f'Error downloading {remote_path}: {str(e)}')
        
        return files_downloaded, total_size
    
    def _cleanup_old_backups(self, server_backup_dir, keep_count=7):
        """
        إزالة ملفات النسخ الاحتياطي القديمة، والاحتفاظ بالأحدث فقط
        """
        try:
            backup_files = []
            for file in server_backup_dir.glob("backup_*.zip"):
                backup_files.append((file.stat().st_mtime, file))
            
            # ترتيب حسب وقت التعديل (الأحدث أولاً)
            backup_files.sort(reverse=True)
            
            # إزالة النسخ القديمة
            for _, backup_file in backup_files[keep_count:]:
                backup_file.unlink()
                # إزالة ملف البيانات الوصفية المقابل أيضاً
                metadata_file = backup_file.with_suffix('.zip.json')
                if metadata_file.exists():
                    metadata_file.unlink()
                    
        except Exception as e:
            print(f"Error cleaning up old backups: {str(e)}")
    
    def get_backups(self, server_name=None):
        """
        الحصول على قائمة النسخ الاحتياطية المتاحة
        """
        backups = []
        
        if server_name:
            server_dirs = [self.backup_dir / server_name]
        else:
            server_dirs = [d for d in self.backup_dir.iterdir() if d.is_dir()]
        
        for server_dir in server_dirs:
            if not server_dir.exists():
                continue
                
            for metadata_file in server_dir.glob("backup_*.json"):
                try:
                    with open(metadata_file, 'r') as f:
                        metadata = json.load(f)
                    
                    backup_file = server_dir / metadata['backup_name']
                    if backup_file.exists():
                        metadata['file_path'] = str(backup_file)
                        metadata['size_mb'] = round(metadata['size_bytes'] / (1024 * 1024), 2)
                        backups.append(metadata)
                        
                except Exception as e:
                    print(f"Error reading backup metadata: {str(e)}")
                    continue
        
        # ترتيب حسب تاريخ الإنشاء (الأحدث أولاً)
        backups.sort(key=lambda x: x['created_at'], reverse=True)
        return backups
    
    def delete_backup(self, backup_id):
        """
        حذف نسخة احتياطية محددة
        """
        try:
            # البحث عن النسخة الاحتياطية بالمعرف (استخدام created_at كمعرف)
            backups = self.get_backups()
            backup_to_delete = None
            
            for backup in backups:
                if backup['created_at'] == backup_id:
                    backup_to_delete = backup
                    break
            
            if not backup_to_delete:
                return False, "Backup not found"
            
            # حذف ملف النسخة الاحتياطية والبيانات الوصفية
            backup_file = Path(backup_to_delete['file_path'])
            metadata_file = backup_file.with_suffix('.zip.json')
            
            if backup_file.exists():
                backup_file.unlink()
            
            if metadata_file.exists():
                metadata_file.unlink()
            
            return True, "Backup deleted successfully"
            
        except Exception as e:
            return False, f"Error deleting backup: {str(e)}"
    
    def get_backup_status(self, server_name):
        """
        الحصول على حالة النسخ الاحتياطي الحالية للخادم
        """
        if server_name in self.active_backups:
            return self.active_backups[server_name]
        else:
            return {'status': 'idle'}