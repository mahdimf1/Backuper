from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit
import os
import json
from backup_manager import BackupManager
import threading

app = Flask(__name__)
app.config['SECRET_KEY'] = 'backup_manager_secret'
CORS(app, cors_allowed_origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Initialize backup manager
backup_manager = BackupManager()

# Store active backup sessions
active_sessions = {}

# Serve static files
@app.route('/')
def serve_frontend():
    return send_from_directory('../frontend', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    if path.startswith('css/'):
        return send_from_directory('../frontend/css', path[4:])
    elif path.startswith('js/'):
        return send_from_directory('../frontend/js', path[3:])
    else:
        return send_from_directory('../frontend', path)

# WebSocket Events
@socketio.on('connect')
def handle_connect():
    print(f'Client connected: {request.sid}')
    emit('connected', {'status': 'Connected to backup server'})

@socketio.on('disconnect')
def handle_disconnect():
    print(f'Client disconnected: {request.sid}')
    # Clean up any active backup sessions for this client
    if request.sid in active_sessions:
        del active_sessions[request.sid]

@socketio.on('start_backup_session')
def handle_start_backup_session(data):
    session_id = request.sid
    server_name = data.get('serverName')
    active_sessions[session_id] = {
        'server_name': server_name,
        'status': 'active'
    }
    emit('backup_session_started', {'session_id': session_id, 'server_name': server_name})

# API Routes
@app.route('/api/test-connection', methods=['POST'])
def test_connection():
    try:
        data = request.get_json()
        address = data.get('address')
        username = data.get('username')
        password = data.get('password')
        
        success, message = backup_manager.test_connection(address, username, password)
        
        return jsonify({
            'success': success,
            'message': message,
            'error': None if success else message
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/start-backup', methods=['POST'])
def start_backup():
    try:
        data = request.get_json()
        server_name = data.get('serverName')
        address = data.get('address')
        username = data.get('username')
        password = data.get('password')
        paths = data.get('paths', [])
        session_id = data.get('sessionId')  # Frontend will send session ID
        
        # Start backup with progress callback
        def progress_callback(log_type, message, progress=None, current_file=None, file_progress=None, stats=None):
            socketio.emit('backup_progress', {
                'type': log_type,
                'message': message,
                'progress': progress,
                'current_file': current_file,
                'file_progress': file_progress,
                'stats': stats,
                'timestamp': backup_manager.get_timestamp()
            }, room=session_id)
        
        success, message = backup_manager.start_backup(
            server_name, address, username, password, paths, progress_callback
        )
        
        return jsonify({
            'success': success,
            'message': message,
            'error': None if success else message
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/get-backups', methods=['GET'])
def get_backups():
    try:
        server_id = request.args.get('serverId')
        backups = backup_manager.get_backups(server_id)
        
        return jsonify({
            'success': True,
            'backups': backups
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/delete-backup', methods=['DELETE'])
def delete_backup():
    try:
        data = request.get_json()
        backup_id = data.get('backupId')
        
        success, message = backup_manager.delete_backup(backup_id)
        
        return jsonify({
            'success': success,
            'message': message
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/backup-status/<server_name>', methods=['GET'])
def get_backup_status(server_name):
    try:
        status = backup_manager.get_backup_status(server_name)
        return jsonify({
            'success': True,
            'status': status
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

if __name__ == '__main__':
    # إنشاء مجلد backup إذا لم يكن موجوداً
    os.makedirs('../backup', exist_ok=True)
    
    print("Starting Ubuntu Backup Manager with WebSocket support...")
    print("Frontend available at: http://localhost:5000")
    print("API available at: http://localhost:5000/api")
    print("WebSocket available at: ws://localhost:5000")
    
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)