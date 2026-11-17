"""Owned browser-computed results in SQLite; opaque Beaker file sessions.

Limits per application: 64 MiB record bodies, 256 MiB artifacts, 256 MiB snapshots,
1000 active guests. Requests: 64 KiB metadata/JSON artifacts (Warehouse datasets:2 MiB),
32 MiB binary artifacts; snapshots contain at most 32 MiB/1000 items per collection.
Per IP/minute: 120 mutations, 600 reads; guest bootstrap 30 and authentication 10.
Session lifetime: APP_SESSION_TTL_SECONDS=60..2592000, default 2592000 seconds.
"""
import base64
import csv
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import threading
import time
from urllib.parse import parse_qs, urlsplit
import uuid

from argon2 import PasswordHasher, Type
from argon2.exceptions import VerificationError
from beaker.session import Session
from beaker.container import FileNamespaceManager
from beaker.synchronization import FileSynchronizer

JSON_LIMIT = 65536
WAREHOUSE_JSON_LIMIT = 2 * 1024 * 1024
WAREHOUSE_JSON_NODES = 220000  # 2000 rows of100 scalar fields plus containers.
BINARY_LIMIT = 32 * 1024 * 1024
TOTAL_LIMIT = 256 * 1024 * 1024
SNAPSHOT_LIMIT = 32 * 1024 * 1024
RECORD_LIMIT = 64 * 1024 * 1024
MAX_ACTIVE_GUEST_SESSIONS = 1000
KINDS = {
    'hashwing': {'verification', 'sealing'},
    'mavframe': {'capture', 'analysis'},
    'cuereport': {'report', 'triage', 'ablation', 'evaluation'},
    'issue-warehouse': {'query', 'filter', 'split'},
}
SAMPLE_PATHS = {
    'hashwing': ('samples/intact.fseal', 'samples/tampered.fseal', 'samples/pubkey.txt'),
    'mavframe': ('sample/scenario-heartbeat.tlog',),
    'cuereport': ('index.html',),
    'issue-warehouse': ('data/issues.json',),
}
FORBIDDEN = {'password', 'passwordhash', 'session', 'sessionid', 'sessionsecret', 'csrf', 'csrftoken', 'token', 'accesstoken', 'refreshtoken', 'authorization', 'cookie', 'privatekey', 'privatejwk', 'apikey', 'clientsecret', 'awssecretaccesskey', 'passphrase', 'mnemonic', 'secretkey', 'signingkey', 'secret'}
PRIVATE_PEM = re.compile(rb'-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----', re.I)


def dump(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def now():
    return datetime.now(timezone.utc).isoformat()


class APIError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def fail(status, code, message):
    raise APIError(status, code, message)


def safe_value(value, depth=0, budget=None, max_nodes=10000):
    if budget is None:
        budget = [0]
    budget[0] += 1
    if depth > 16 or budget[0] > max_nodes:
        fail(400, 'invalid_shape', 'JSON structure is too complex')
    if isinstance(value, dict):
        normalized = {re.sub('[^a-z0-9]', '', key.lower()): child for key, child in value.items()}
        kty = normalized.get('kty')
        private_fields = {'EC': {'d'}, 'OKP': {'d'}, 'RSA': {'d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'}, 'OCT': {'k'}}
        if isinstance(kty, str) and set(normalized).intersection(private_fields.get(kty.upper(), set())):
            fail(400, 'sensitive_data', 'Private JWK material cannot be stored')
        for key, child in value.items():
            normalized = re.sub('[^a-z0-9]', '', key.lower())
            if normalized in FORBIDDEN or normalized.endswith('privatekey'):
                fail(400, 'sensitive_data', 'Private credentials cannot be stored in records')
            safe_value(child, depth + 1, budget, max_nodes)
    elif isinstance(value, list):
        for child in value:
            safe_value(child, depth + 1, budget, max_nodes)
    elif isinstance(value, str) and PRIVATE_PEM.search(value.encode()):
        fail(400, 'sensitive_data', 'Private keys cannot be stored')


def check_parents(path):
    for parent in (Path(path).parent, *Path(path).parent.parents):
        if parent.is_symlink():
            raise ValueError('Invalid storage directory')


def session_directory(path):
    """Create private session trees through directory descriptors only."""
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in Path(path).parts[1:]:
            if part in {'.', '..'}:
                raise ValueError('Invalid session directory')
            try:
                os.mkdir(part, 0o700, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
    finally:
        os.close(directory)


class SafeSessionLock(FileSynchronizer):
    def __init__(self, identifier, lock_dir):
        ident = hashlib.sha1(identifier.encode()).hexdigest()
        session_directory(Path(lock_dir) / ident[0] / ident[:2])
        super().__init__(identifier, lock_dir)

    def _open(self, mode):
        check_parents(self.filename)
        if Path(self.filename).is_symlink():
            raise ValueError('Invalid session lock')
        return super()._open(mode | os.O_NOFOLLOW)


class JSONFileNamespace(FileNamespaceManager):
    """Keep Beaker session semantics without its pickle file envelope."""
    def __init__(self, namespace, data_dir=None, file_dir=None, lock_dir=None, digest_filenames=True, **kwargs):
        file_dir = file_dir or str(Path(data_dir) / 'container_file')
        lock_dir = lock_dir or str(Path(data_dir) / 'container_file_lock')
        ident = hashlib.sha1(namespace.encode()).hexdigest() if digest_filenames else os.path.basename(namespace)
        session_directory(Path(file_dir) / ident[0] / ident[:2])
        session_directory(Path(lock_dir))
        super().__init__(namespace, data_dir=data_dir, file_dir=file_dir, lock_dir=lock_dir,
                         digest_filenames=digest_filenames, **kwargs)

    def get_access_lock(self):
        return SafeSessionLock(self.namespace, self.lock_dir)

    def get_creation_lock(self, key):
        return SafeSessionLock('session-create-' + self.namespace + str(key), self.lock_dir)

    def do_open(self, flags, replace):
        check_parents(self.file)
        self.hash = {}
        if not replace:
            try:
                fd = os.open(self.file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, 'rb') as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                        raise ValueError('Invalid session file')
                    content = stream.read(JSON_LIMIT + 1)
                if len(content) > JSON_LIMIT:
                    raise ValueError('Invalid session file')
                self.hash = json.loads(content)
            except FileNotFoundError:
                pass
        self.flags = flags

    def do_close(self):
        if self.flags in {'c', 'w'}:
            check_parents(self.file)
            temporary = self.file + '.tmp-' + uuid.uuid4().hex
            try:
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(dump(self.hash).encode())
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.file)
            finally:
                Path(temporary).unlink(missing_ok=True)
        self.hash = {}
        self.flags = None


class Persistence:
    def __init__(self, app, public_root, environ=None):
        env = os.environ if environ is None else environ
        if app not in KINDS:
            raise ValueError('Unsupported persistence application')
        self.app, self.public_root = app, Path(public_root)
        self.origin = env.get('APP_PUBLIC_ORIGIN', '')
        url = urlsplit(self.origin)
        local = env.get('APP_LOCAL_HTTP') == '1' and url.hostname in {'localhost', '127.0.0.1', '::1'}
        if not url.hostname or url.username or url.password or url.query or url.fragment or url.path or (url.scheme != 'https' and not (url.scheme == 'http' and local)):
            raise ValueError('APP_PUBLIC_ORIGIN must be an explicit HTTPS origin or approved loopback HTTP origin')
        self.secret = env.get('APP_SESSION_SECRET', '')
        if len(self.secret.encode()) < 32:
            raise ValueError('APP_SESSION_SECRET must contain at least 32 bytes')
        if not env.get('APP_DATA_DIR') or not Path(env['APP_DATA_DIR']).is_absolute():
            raise ValueError('APP_DATA_DIR must be an absolute persistent directory')
        self.root = Path(env['APP_DATA_DIR']) / app
        if self.root.resolve().is_relative_to(self.public_root.resolve()):
            raise ValueError('APP_DATA_DIR must keep private storage outside the public asset root')
        self.lock = threading.RLock()
        self.auth_slots = threading.BoundedSemaphore(2)
        self.auth_enabled = env.get('APP_PASSWORD_AUTH') == '1'
        self.passwords = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1, type=Type.ID)
        try:
            self.ttl = int(env.get('APP_SESSION_TTL_SECONDS', '2592000'))
        except (TypeError, ValueError):
            raise ValueError('APP_SESSION_TTL_SECONDS must be an integer from 60 to 2592000') from None
        if not 60 <= self.ttl <= 2592000:
            raise ValueError('APP_SESSION_TTL_SECONDS must be an integer from 60 to 2592000')
        self.rates = {}
        self.cookie_name = 'app_' + app.replace('-', '_') + '_session'
        for directory in (Path(env['APP_DATA_DIR']), self.root, self.root / 'sessions', self.root / 'artifacts', self.root / 'snapshots'):
            self._directory(directory)
        self.db_path = self.root / 'state.sqlite3'
        fd = os.open(self.db_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise ValueError('Invalid database file')
        os.close(fd)
        with self._db() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
            for migration in sorted((Path(__file__).parent / 'migrations').glob('*.sql')):
                if not db.execute('SELECT 1 FROM schema_migrations WHERE version=?', (migration.name,)).fetchone():
                    # executescript commits implicitly; include the migration marker in its transaction.
                    script = 'BEGIN IMMEDIATE;\n' + migration.read_text() + "\nINSERT INTO schema_migrations VALUES ('" + migration.name.replace("'", "''") + "', '" + now() + "');\nCOMMIT;"
                    db.executescript(script)
            self._seed(db)
        if not self.ready():
            raise ValueError('Persistent storage is not usable')

    @staticmethod
    def _directory(path):
        # Existing ancestors are checked too: no storage operation traverses a symlink.
        for parent in reversed((path, *path.parents)):
            if parent.exists() and (parent.is_symlink() or not parent.is_dir()):
                raise ValueError('Invalid storage directory')
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.is_symlink():
            raise ValueError('Invalid storage directory')
        path.chmod(0o700)

    @contextmanager
    def _db(self):
        check_parents(self.db_path)
        if any(Path(str(self.db_path) + suffix).is_symlink() for suffix in ('', '-wal', '-shm', '-journal')):
            raise ValueError('Invalid database file')
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA busy_timeout=10000')
        try:
            with db:
                yield db
        finally:
            db.close()

    def ready(self):
        try:
            with self.lock, self._db() as db:
                if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    return False
                db.execute('BEGIN IMMEDIATE')
                db.execute('UPDATE schema_migrations SET applied_at=applied_at')
                db.rollback()
                for name in ('artifacts', 'snapshots', 'sessions'):
                    directory = self.root / name
                    if directory.is_symlink():
                        return False
                    path = directory / ('.probe-' + uuid.uuid4().hex)
                    self._write(path, b'')
                    path.unlink()
            return True
        except (OSError, ValueError, sqlite3.Error):
            return False

    def _seed(self, db):
        for relative in SAMPLE_PATHS[self.app]:
            source = self.public_root / relative
            try:
                for parent in (source, *source.parents):
                    if parent.is_symlink():
                        raise OSError('Invalid source')
                fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as stream:
                    content = stream.read(BINARY_LIMIT + 1)
                if len(content) > BINARY_LIMIT or PRIVATE_PEM.search(content):
                    continue
            except OSError:
                continue
            sample = {'id': relative, 'source': 'public-source', 'path': relative, 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
            db.execute('INSERT INTO samples VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', (relative, dump(sample)))

    def _session(self, headers):
        request = {'cookie': headers.get('cookie', '')}
        return Session(request, type='file', data_dir=str(self.root / 'sessions'), key=self.cookie_name,
                       timeout=self.ttl, cookie_expires=timedelta(seconds=self.ttl), data_serializer='json',
                       secret=self.secret, namespace_class=JSONFileNamespace, secure=self.origin.startswith('https:'), httponly=True, samesite='Lax', invalidate_corrupt=False)

    @staticmethod
    def _session_hash(session):
        return hashlib.sha256(session.id.encode()).hexdigest()

    def _valid_session(self, db, session):
        row = db.execute('SELECT * FROM sessions WHERE id_hash=? AND revoked=0 AND expires>?', (self._session_hash(session), time.time())).fetchone()
        return row is not None and session.get('principal') == row['principal'] and session.get('expires', 0) > time.time()

    def _new_session(self, db, principal, role):
        db.execute('DELETE FROM sessions WHERE expires<=? OR revoked=1', (time.time(),))
        if role == 'guest' and db.execute("SELECT count(*) FROM sessions WHERE principal LIKE 'guest:%' AND expires>? AND revoked=0", (time.time(),)).fetchone()[0] >= MAX_ACTIVE_GUEST_SESSIONS:
            fail(409, 'quota', 'Active guest session limit reached')
        if db.execute('SELECT count(*) FROM sessions').fetchone()[0] >= 10000:
            fail(409, 'quota', 'Session limit reached')
        session = self._session({})
        session.update(principal=principal, role=role, csrf=secrets.token_urlsafe(32), expires=time.time() + self.ttl)
        session.save()
        db.execute('INSERT INTO sessions VALUES (?,?,?,0)', (self._session_hash(session), principal, session['expires']))
        return session

    def _cookie(self, session, expired=False):
        if expired:
            return f'{self.cookie_name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax' + ('; Secure' if self.origin.startswith('https:') else '')
        session._update_cookie_out()
        return session.request['cookie_out'].strip() + f'; Max-Age={self.ttl}'

    def _rate(self, ip, category, limit):
        minute = int(time.time() // 60)
        if len(self.rates) > 4096:
            self.rates = {key: value for key, value in self.rates.items() if key[2] == minute}
            if len(self.rates) > 4096:
                fail(429, 'rate_limit', 'Try again later')
        key = (ip, category, minute)
        self.rates[key] = self.rates.get(key, 0) + 1
        if self.rates[key] > limit:
            fail(429, 'rate_limit', 'Try again later')

    @staticmethod
    def _json(raw):
        if len(raw) > JSON_LIMIT:
            fail(413, 'too_large', 'JSON exceeds 64 KiB')
        try:
            data = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError, RecursionError):
            fail(400, 'invalid_json', 'A JSON object is required')
        if not isinstance(data, dict):
            fail(400, 'invalid_json', 'A JSON object is required')
        return data

    def handle(self, method, path_with_query, headers_dict, raw_body_bytes, client_ip='unknown'):
        parsed = urlsplit(path_with_query)
        if not parsed.path.startswith('/api/'):
            return None
        routes = ('/api/session', '/api/workspaces', '/api/runs', '/api/exports', '/api/artifacts', '/api/sync', '/api/samples')
        if not any(parsed.path == route or parsed.path.startswith(route + '/') for route in routes):
            return None
        headers = {str(key).lower(): value for key, value in headers_dict.items()}
        try:
            with self.lock:
                self._rate(client_ip, 'mutations' if method.upper() not in {'GET', 'HEAD'} else 'reads', 120 if method.upper() not in {'GET', 'HEAD'} else 600)
                self._pending_files = []
                try:
                    with self._db() as db:
                        db.execute('BEGIN IMMEDIATE')
                        result = self._handle(db, method.upper(), parsed.path, parse_qs(parsed.query, keep_blank_values=True), headers, raw_body_bytes, client_ip)
                        if method.upper() not in {'GET', 'HEAD'}:
                            self._record_capacity(db)
                    return result
                except BaseException:
                    for file in self._pending_files:
                        file.unlink(missing_ok=True)
                    raise
                finally:
                    del self._pending_files
        except APIError as exc:
            return self._response(exc.status, {'error': {'code': exc.code, 'message': exc.message}})
        except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
            return self._response(503, {'error': {'code': 'storage_unavailable', 'message': 'Persistent storage is unavailable'}})
        except Exception:
            return self._response(500, {'error': {'code': 'internal_error', 'message': 'The request could not be completed'}})

    @staticmethod
    def _response(status, data, headers=None):
        return status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', **(headers or {})}, dump(data).encode()

    @staticmethod
    def _resource(row):
        return json.loads(row['data'])

    def _owned(self, db, table, resource_id, owner):
        row = db.execute(f'SELECT * FROM {table} WHERE id=? AND owner=?', (resource_id, owner)).fetchone()
        if row is None:
            fail(404, 'not_found', 'Resource not found')
        return row

    def _workspace(self, db, owner, workspace_id):
        if not isinstance(workspace_id, str):
            fail(400, 'invalid_workspace', 'workspace_id is required')
        return self._owned(db, 'workspaces', workspace_id, owner)

    def _create_workspace(self, db, owner, title='Workspace', metadata=None):
        count = db.execute('SELECT count(*) FROM workspaces WHERE owner=?', (owner,)).fetchone()[0]
        if count >= 100:
            fail(409, 'quota', 'Workspace limit reached')
        data = {'id': str(uuid.uuid4()), 'name': self._title(title), 'title': self._title(title), 'metadata': metadata or {}, 'revision': 1, 'created_at': now(), 'updated_at': now()}
        safe_value(data)
        db.execute('INSERT INTO workspaces VALUES (?,?,1,?)', (data['id'], owner, dump(data)))
        return data

    @staticmethod
    def _title(title):
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            fail(400, 'invalid_title', 'title must contain 1–200 characters')
        return title.strip()

    def _session_data(self, db, session):
        owner = session['principal']
        row = db.execute('SELECT * FROM workspaces WHERE owner=? AND id=?', (owner, session.get('workspace_id'))).fetchone()
        if row is None:
            row = db.execute('SELECT * FROM workspaces WHERE owner=? ORDER BY rowid LIMIT 1', (owner,)).fetchone()
        workspace = self._resource(row) if row else self._create_workspace(db, owner, metadata={'samples': [json.loads(item[0]) for item in db.execute('SELECT data FROM samples')]})
        return {'role': session['role'], 'principal_id': session['principal'], 'migrated_from': session.get('migrated_from'), 'csrf_token': session['csrf'], 'workspace_id': workspace['id'], 'workspace': workspace, 'auth_enabled': self.auth_enabled, 'expires_at': datetime.fromtimestamp(session['expires'], timezone.utc).isoformat()}

    def _list(self, db, table, owner, query):
        try:
            limit = int(query.get('limit', ['50'])[0])
            offset = int(query.get('offset', ['0'])[0])
        except ValueError:
            fail(400, 'invalid_page', 'Invalid pagination')
        if not 1 <= limit <= 50 or not 0 <= offset <= 100000:
            fail(400, 'invalid_page', 'limit must be 1–50 and offset 0–100000')
        args = [owner]
        where = 'owner=?'
        if 'workspace_id' in query:
            workspace_id = query['workspace_id'][0]
            self._workspace(db, owner, workspace_id)
            if table == 'workspaces':
                where += ' AND id=?'
            else:
                where += ' AND workspace_id=?'
            args.append(workspace_id)
        rows = db.execute(f'SELECT data FROM {table} WHERE {where} ORDER BY rowid DESC LIMIT ? OFFSET ?', (*args, limit, offset))
        total = db.execute(f'SELECT count(*) FROM {table} WHERE {where}', args).fetchone()[0]
        return {'items': [json.loads(row[0]) for row in rows], 'total': total, 'limit': limit, 'offset': offset}

    @staticmethod
    def _record_capacity(db):
        stored_bytes = sum(db.execute(f'SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM {table}').fetchone()[0] for table in ('workspaces', 'runs', 'exports', 'artifacts', 'snapshots'))
        stored_bytes += db.execute('SELECT coalesce(sum(length(CAST(response AS BLOB))),0) FROM idempotency').fetchone()[0]
        if stored_bytes > RECORD_LIMIT:
            fail(409, 'quota', 'Application record storage limit reached')

    def _handle(self, db, method, path, query, headers, raw, ip):
        mutation = method not in {'GET', 'HEAD'}
        if method == 'HEAD':
            fail(405, 'method_not_allowed', 'Use GET')
        is_artifact = path == '/api/artifacts' and method == 'POST'
        if len(raw) > (BINARY_LIMIT if is_artifact else JSON_LIMIT):
            fail(413, 'too_large', 'Request body exceeds its limit')
        if mutation:
            if headers.get('origin') != self.origin:
                fail(403, 'origin', 'An exact trusted Origin is required')
            if not is_artifact and headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
                fail(415, 'content_type', 'Content-Type application/json is required')
        if path == '/api/samples' and method == 'GET':
            return self._response(200, {'items': [json.loads(row[0]) for row in db.execute('SELECT data FROM samples')]})
        session = self._session(headers)
        valid = self._valid_session(db, session)
        if path == '/api/session/guest' and method == 'POST':
            self._json(raw)
            if not valid:
                self._rate(ip, 'guest', 30)
                self._record_capacity(db)
                principal = 'guest:' + str(uuid.uuid4())
                self._create_workspace(db, principal, metadata={'samples': [json.loads(item[0]) for item in db.execute('SELECT data FROM samples')]})
                self._record_capacity(db)
                session = self._new_session(db, principal, 'guest')
            return self._response(200, self._session_data(db, session), {'Set-Cookie': self._cookie(session)})
        if not valid:
            fail(401, 'session_required', 'Start or sign in to a session')
        if mutation and not hmac.compare_digest(str(headers.get('x-csrf-token', '')).encode(), session['csrf'].encode()):
            fail(403, 'csrf', 'A valid CSRF token is required')
        owner = session['principal']
        if path == '/api/session' and method == 'GET':
            return self._response(200, self._session_data(db, session))
        if path == '/api/session/workspace' and method == 'POST':
            data = self._json(raw)
            workspace = self._workspace(db, owner, data.get('workspace_id'))
            session['workspace_id'] = workspace['id']
            session.save()
            return self._response(200, self._session_data(db, session))
        if path == '/api/session/logout' and method == 'POST':
            self._json(raw)
            db.execute('UPDATE sessions SET revoked=1 WHERE id_hash=?', (self._session_hash(session),))
            return self._response(200, {'logged_out': True}, {'Set-Cookie': self._cookie(session, True)})
        if path in {'/api/session/signup', '/api/session/login'} and method == 'POST':
            return self._auth(db, path, headers, raw, ip, session)
        data = self._json(raw) if mutation and not is_artifact else {}
        if mutation:
            safe_value(data)
            self._record_capacity(db)
        idem_key = headers.get('idempotency-key') if method == 'POST' and path in {'/api/workspaces', '/api/runs', '/api/exports', '/api/artifacts', '/api/sync'} else None
        request_hash = hashlib.sha256(method.encode() + path.encode() + dump(query).encode() + raw).hexdigest()
        if idem_key:
            if len(idem_key) > 128 or not re.fullmatch(r'[A-Za-z0-9._:-]+', idem_key):
                fail(400, 'idempotency_key', 'Invalid Idempotency-Key')
            prior = db.execute('SELECT * FROM idempotency WHERE owner=? AND key=?', (owner, idem_key)).fetchone()
            if prior:
                if prior['request_hash'] != request_hash:
                    fail(409, 'idempotency_conflict', 'Idempotency-Key was used for a different request')
                return self._response(prior['status'], json.loads(prior['response']))
        parts = path.strip('/').split('/')
        collection = parts[1]
        if len(parts) > 3 and not (collection == 'sync' and len(parts) == 4 and parts[3] == 'restore'):
            fail(404, 'not_found', 'API route not found')
        resource_id = parts[2] if len(parts) > 2 else None
        if collection in {'workspaces', 'runs', 'exports', 'artifacts', 'sync'} and resource_id is None and method == 'GET':
            return self._response(200, self._list(db, 'snapshots' if collection == 'sync' else collection, owner, query))
        if collection == 'workspaces':
            result = self._workspaces(db, method, resource_id, owner, data)
        elif collection == 'runs':
            result = self._runs(db, method, resource_id, owner, data)
        elif collection == 'artifacts':
            result = self._artifacts(db, method, resource_id, owner, query, raw)
        elif collection == 'exports':
            result = self._exports(db, method, resource_id, owner, data)
        elif collection == 'sync':
            result = self._snapshots(db, method, resource_id, owner, data, parts)
        else:
            fail(404, 'not_found', 'API route not found')
        if idem_key:
            count = db.execute('SELECT count(*) FROM idempotency WHERE owner=?', (owner,)).fetchone()[0]
            if count >= 10000:
                fail(409, 'quota', 'Idempotency record limit reached')
            db.execute('INSERT INTO idempotency VALUES (?,?,?,?,?)', (owner, idem_key, request_hash, result[0], result[2].decode()))
        return result

    def _auth(self, db, path, headers, raw, ip, old):
        if not self.auth_enabled:
            fail(404, 'auth_disabled', 'Password authentication is disabled')
        self._rate(ip, 'auth', 10)
        data = self._json(raw)
        username, password = data.get('username', data.get('email')), data.get('password')
        if not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9_.@+-]{3,100}', username) or not isinstance(password, str) or not 12 <= len(password) <= 256:
            fail(400, 'credentials', 'Use a 3–100 character username and a 12–256 character password')
        username = username.lower()
        if not self.auth_slots.acquire(blocking=False):
            fail(429, 'auth_busy', 'Authentication is busy; retry later')
        try:
            account = db.execute('SELECT * FROM accounts WHERE username=?', (username,)).fetchone()
            if path.endswith('/signup'):
                if account:
                    fail(409, 'account_exists', 'Username is unavailable')
                if db.execute('SELECT count(*) FROM accounts').fetchone()[0] >= 1000:
                    fail(409, 'quota', 'Account limit reached')
                principal = 'account:' + str(uuid.uuid4())
                db.execute('INSERT INTO accounts VALUES (?,?,?,?)', (principal, username, self.passwords.hash(password), now()))
            else:
                try:
                    # Unknown users still perform the same bounded password work.
                    password_hash = account['password_hash'] if account else self.passwords.hash('unavailable-account-password')
                    verified = self.passwords.verify(password_hash, password)
                except VerificationError:
                    verified = False
                if not account or not verified:
                    fail(401, 'credentials', 'Invalid username or password')
                principal = account['id']
        finally:
            self.auth_slots.release()
        migrated_from = None
        if old['role'] == 'guest':
            for table in ('workspaces', 'runs', 'artifacts', 'exports', 'snapshots'):
                updated = db.execute(f'UPDATE {table} SET owner=? WHERE owner=?', (principal, old['principal']))
                if table == 'workspaces' and updated.rowcount:
                    migrated_from = old['principal']
            db.execute('UPDATE idempotency SET owner=? WHERE owner=? AND key NOT IN (SELECT key FROM idempotency WHERE owner=?)', (principal, old['principal'], principal))
            db.execute('DELETE FROM idempotency WHERE owner=?', (old['principal'],))
        db.execute('UPDATE sessions SET revoked=1 WHERE id_hash=?', (self._session_hash(old),))
        session = self._new_session(db, principal, 'account')
        session['migrated_from'] = migrated_from
        if old.get('workspace_id'):
            session['workspace_id'] = old['workspace_id']
        session.save()
        return self._response(200, self._session_data(db, session), {'Set-Cookie': self._cookie(session)})

    @staticmethod
    def _revision(data, row):
        expected = data.get('expected_revision', data.get('expected_version'))
        if type(expected) is not int:
            fail(400, 'expected_revision', 'An integer expected_revision is required')
        if expected != row['revision']:
            fail(409, 'revision_conflict', 'Resource revision changed; reload before saving')

    def _workspaces(self, db, method, resource_id, owner, data):
        if resource_id is None and method == 'POST':
            metadata = data.get('metadata', {})
            if not isinstance(metadata, dict):
                fail(400, 'invalid_metadata', 'metadata must be an object')
            return self._response(201, self._create_workspace(db, owner, data.get('title', data.get('name', 'Workspace')), metadata))
        row = self._owned(db, 'workspaces', resource_id, owner)
        result = self._resource(row)
        if method == 'PATCH':
            self._revision(data, row)
            if 'name' in data and 'title' not in data:
                data['title'] = data['name']
            if 'title' in data:
                result['title'] = self._title(data['title'])
                result['name'] = result['title']
            if 'metadata' in data:
                if not isinstance(data['metadata'], dict):
                    fail(400, 'invalid_metadata', 'metadata must be an object')
                result['metadata'] = data['metadata']
            result.update(revision=row['revision'] + 1, updated_at=now())
            db.execute('UPDATE workspaces SET revision=?,data=? WHERE id=?', (result['revision'], dump(result), resource_id))
        elif method != 'GET':
            fail(405, 'method_not_allowed', 'Use GET or PATCH')
        return self._response(200, result)

    def _runs(self, db, method, resource_id, owner, data):
        if method == 'GET' and resource_id:
            return self._response(200, self._resource(self._owned(db, 'runs', resource_id, owner)))
        if method not in {'POST', 'PUT'} or (method == 'POST' and resource_id) or (method == 'PUT' and not resource_id):
            fail(405, 'method_not_allowed', 'Use POST or PUT')
        existing = self._owned(db, 'runs', resource_id, owner) if resource_id else None
        if existing:
            self._revision(data, existing)
        workspace_id = data.get('workspace_id')
        self._workspace(db, owner, workspace_id)
        if existing and workspace_id != existing['workspace_id']:
            fail(400, 'workspace_immutable', 'Run workspace cannot change')
        kind = data.get('kind')
        if kind not in KINDS[self.app] or not isinstance(data.get('payload'), (dict, list)):
            fail(400, 'invalid_run', 'A supported kind and object or array payload are required')
        artifact_ids = data.get('artifact_ids', [])
        if not isinstance(artifact_ids, list) or len(artifact_ids) > 50 or not all(isinstance(item, str) for item in artifact_ids):
            fail(400, 'invalid_artifacts', 'artifact_ids must contain at most 50 IDs')
        for artifact_id in artifact_ids:
            artifact = self._owned(db, 'artifacts', artifact_id, owner)
            if artifact['workspace_id'] != workspace_id:
                fail(400, 'artifact_workspace', 'Artifact belongs to a different workspace')
        count = db.execute('SELECT count(*) FROM runs WHERE owner=?', (owner,)).fetchone()[0]
        if not existing and count >= 10000:
            fail(409, 'quota', 'Run limit reached')
        result = {'id': resource_id or str(uuid.uuid4()), 'workspace_id': workspace_id, 'kind': kind, 'title': self._title(data.get('title', kind)), 'payload': data['payload'], 'artifact_ids': artifact_ids, 'source': 'browser-computed', 'revision': existing['revision'] + 1 if existing else 1, 'created_at': self._resource(existing)['created_at'] if existing else now(), 'updated_at': now()}
        result['version'] = result['revision']
        if len(dump(result).encode()) > JSON_LIMIT:
            fail(413, 'too_large', 'Stored run exceeds 64 KiB')
        if existing:
            db.execute('UPDATE runs SET revision=?,data=? WHERE id=?', (result['revision'], dump(result), result['id']))
        else:
            db.execute('INSERT INTO runs VALUES (?,?,?,?,?)', (result['id'], owner, workspace_id, result['revision'], dump(result)))
        return self._response(200 if existing else 201, result)

    def _write(self, path, content):
        check_parents(path)
        temporary = path.parent / ('.tmp-' + uuid.uuid4().hex)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            if hasattr(self, '_pending_files'):
                self._pending_files.append(path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _read(path, limit):
        check_parents(path)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('Invalid storage file')
            content = stream.read(limit + 1)
        if len(content) > limit:
            fail(413, 'too_large', 'Stored file exceeds its limit')
        return content

    def _artifacts(self, db, method, resource_id, owner, query, raw):
        if method == 'GET' and resource_id:
            record = self._resource(self._owned(db, 'artifacts', resource_id, owner))
            content = self._read(self.root / 'artifacts' / resource_id, BINARY_LIMIT)
            if hashlib.sha256(content).hexdigest() != record['sha256']:
                fail(409, 'integrity', 'Artifact integrity check failed')
            return 200, {'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + record['name'] + '"'}, content
        if method != 'POST' or resource_id:
            fail(405, 'method_not_allowed', 'Use POST or GET')
        workspace_id, name = query.get('workspace_id', [None])[0], query.get('name', ['artifact.bin'])[0]
        self._workspace(db, owner, workspace_id)
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._ -]{0,119}', name) or re.search(r'(private|secret|id_rsa|id_ed25519|\.key$|\.p12$|\.pfx$)', name, re.I) or PRIVATE_PEM.search(raw):
            fail(400, 'unsafe_artifact', 'Use a simple filename and exclude private key material')
        encoding = json.detect_encoding(raw)
        try:
            json_like = raw.lstrip().startswith((b'{', b'[')) if encoding == 'utf-8' else raw.decode(encoding).lstrip().startswith(('{', '['))
        except UnicodeError:
            json_like = False
        if json_like:
            limit = WAREHOUSE_JSON_LIMIT if self.app == 'issue-warehouse' else JSON_LIMIT
            if len(raw) > limit:
                fail(413, 'too_large', 'JSON artifact exceeds the supported '+('2 MiB dataset limit' if self.app == 'issue-warehouse' else '64 KiB limit'))
            try:
                content = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            except (ValueError, UnicodeError, RecursionError):
                fail(400, 'invalid_json', 'JSON-looking artifacts must contain valid JSON')
            safe_value(content, max_nodes=WAREHOUSE_JSON_NODES if self.app == 'issue-warehouse' else 10000)
        rows = db.execute('SELECT data FROM artifacts').fetchall()
        if len(rows) >= 1000 or sum(json.loads(row[0])['size'] for row in rows) + len(raw) > TOTAL_LIMIT:
            fail(409, 'quota', 'Artifact storage limit reached')
        result = {'id': str(uuid.uuid4()), 'workspace_id': workspace_id, 'name': name, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'created_at': now()}
        self._write(self.root / 'artifacts' / result['id'], raw)
        db.execute('INSERT INTO artifacts VALUES (?,?,?,?)', (result['id'], owner, workspace_id, dump(result)))
        return self._response(201, result)

    def _exports(self, db, method, resource_id, owner, data):
        if method == 'GET' and resource_id:
            return self._response(200, self._resource(self._owned(db, 'exports', resource_id, owner)))
        if method != 'POST' or resource_id:
            fail(405, 'method_not_allowed', 'Use POST or GET')
        run = self._resource(self._owned(db, 'runs', data.get('run_id'), owner))
        format_ = data.get('format', 'json')
        if format_ not in {'json', 'markdown', 'csv'}:
            fail(400, 'export_format', 'Supported formats are json, markdown, and csv')
        if db.execute('SELECT count(*) FROM exports WHERE owner=?', (owner,)).fetchone()[0] >= 10000:
            fail(409, 'quota', 'Export limit reached')
        if format_ == 'json':
            content = dump(run)
        elif format_ == 'markdown':
            content = '# ' + run['title'].replace('\n', ' ') + '\n\nSource: browser-computed\n\n```json\n' + dump(run['payload']) + '\n```\n'
        else:
            output = io.StringIO(newline='')
            writer = csv.writer(output)
            writer.writerow(['run_id', 'kind', 'title', 'source', 'payload_json'])
            values = [run['id'], run['kind'], run['title'], run['source'], dump(run['payload'])]
            writer.writerow(["'" + value if value.startswith(('=', '+', '-', '@', '\t', '\r', '\n')) else value for value in values])
            content = output.getvalue()
        result = {'id': str(uuid.uuid4()), 'workspace_id': run['workspace_id'], 'run_id': run['id'], 'run_revision': run['revision'], 'format': format_, 'source': 'browser-computed', 'content': content, 'sha256': hashlib.sha256(content.encode()).hexdigest(), 'created_at': now()}
        db.execute('INSERT INTO exports VALUES (?,?,?,?,?)', (result['id'], owner, run['workspace_id'], run['id'], dump(result)))
        return self._response(201, result)

    def _snapshot_document(self, db, owner, workspace_id):
        workspace = self._resource(self._workspace(db, owner, workspace_id))
        document = {'schema_version': 1, 'app': self.app, 'workspace': workspace, 'runs': [], 'exports': [], 'artifacts': []}
        total = 0
        for table in ('runs', 'exports', 'artifacts'):
            rows = db.execute(f'SELECT data FROM {table} WHERE owner=? AND workspace_id=?', (owner, workspace_id)).fetchall()
            if len(rows) > 1000:
                fail(409, 'snapshot_limit', 'Snapshot supports at most 1000 resources per collection')
            for row in rows:
                record = json.loads(row[0])
                if table == 'artifacts':
                    content = self._read(self.root / 'artifacts' / record['id'], BINARY_LIMIT)
                    if hashlib.sha256(content).hexdigest() != record['sha256']:
                        fail(409, 'integrity', 'Artifact integrity check failed')
                    total += len(content)
                    if total > SNAPSHOT_LIMIT:
                        fail(409, 'snapshot_limit', 'Snapshot exceeds 32 MiB')
                    record = {**record, 'content_base64': base64.b64encode(content).decode()}
                document[table].append(record)
        safe_value(document)
        if len(dump(document).encode()) > SNAPSHOT_LIMIT:
            fail(409, 'snapshot_limit', 'Snapshot exceeds 32 MiB')
        return document

    def _snapshot_file(self, snapshot_id, document):
        destination = self.root / 'snapshots' / snapshot_id
        temporary = destination.parent / ('.tmp-' + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        try:
            with sqlite3.connect(':memory:') as staging, sqlite3.connect(temporary) as backup:
                staging.execute('CREATE TABLE manifest(data TEXT NOT NULL)')
                staging.execute('INSERT INTO manifest VALUES (?)', (dump(document),))
                staging.commit()
                staging.backup(backup)
            content = self._read(temporary, SNAPSHOT_LIMIT + 1024 * 1024)
            self._write(destination, content)
            return hashlib.sha256(content).hexdigest(), len(content)
        finally:
            temporary.unlink(missing_ok=True)

    def _load_snapshot(self, record):
        path = self.root / 'snapshots' / record['id']
        content = self._read(path, SNAPSHOT_LIMIT + 1024 * 1024)
        if hashlib.sha256(content).hexdigest() != record['sha256']:
            fail(409, 'integrity', 'Snapshot integrity check failed')
        # Deserialize from the verified bytes so pathname replacement cannot change what is restored.
        with sqlite3.connect(':memory:') as staging:
            staging.deserialize(content)
            staging.execute('PRAGMA trusted_schema=OFF')
            staging.execute('PRAGMA query_only=ON')
            try:
                tables = staging.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                if tables != [('manifest',)]:
                    fail(409, 'snapshot_schema', 'Unsupported snapshot schema')
                rows = staging.execute('SELECT data FROM manifest').fetchall()
                if len(rows) != 1:
                    fail(409, 'snapshot_schema', 'Unsupported snapshot schema')
                document = json.loads(rows[0][0])
            except sqlite3.Error:
                fail(409, 'snapshot_schema', 'Unsupported snapshot schema')
        if document.get('schema_version') != 1 or document.get('app') != self.app:
            fail(409, 'snapshot_schema', 'Unsupported snapshot schema')
        safe_value(document)
        self._validate_snapshot(document)
        return document

    def _validate_snapshot(self, document):
        try:
            workspace = document['workspace']
            original_id = workspace['id']
            uuid.UUID(original_id)
            self._title(workspace['title'])
            if not isinstance(workspace['metadata'], dict) or type(workspace['revision']) is not int or workspace['revision'] < 1:
                raise ValueError()
            ids = set()
            for table in ('runs', 'exports', 'artifacts'):
                records = document[table]
                if not isinstance(records, list) or len(records) > 1000:
                    raise ValueError()
                for item in records:
                    uuid.UUID(item['id'])
                    if item['id'] in ids or item['workspace_id'] != original_id:
                        raise ValueError()
                    ids.add(item['id'])
            artifact_ids = {item['id'] for item in document['artifacts']}
            run_ids = {item['id'] for item in document['runs']}
            total_bytes = 0
            for item in document['artifacts']:
                content = base64.b64decode(item['content_base64'], validate=True)
                total_bytes += len(content)
                if total_bytes > SNAPSHOT_LIMIT or len(content) != item['size'] or hashlib.sha256(content).hexdigest() != item['sha256'] or PRIVATE_PEM.search(content):
                    raise ValueError()
            for item in document['runs']:
                if item['kind'] not in KINDS[self.app] or item['source'] != 'browser-computed' or not isinstance(item['payload'], (dict, list)) or type(item['revision']) is not int or item['revision'] < 1 or not set(item['artifact_ids']) <= artifact_ids:
                    raise ValueError()
            for item in document['exports']:
                if item['run_id'] not in run_ids or item['format'] not in {'json', 'markdown', 'csv'} or hashlib.sha256(item['content'].encode()).hexdigest() != item['sha256']:
                    raise ValueError()
        except (KeyError, TypeError, ValueError, AttributeError):
            fail(409, 'snapshot_schema', 'Snapshot schema or references are invalid')

    def _snapshots(self, db, method, resource_id, owner, data, parts):
        if method == 'POST' and resource_id is None:
            workspace = self._workspace(db, owner, data.get('workspace_id'))
            self._revision(data, workspace)
            if db.execute('SELECT count(*) FROM snapshots WHERE owner=?', (owner,)).fetchone()[0] >= 100:
                fail(409, 'quota', 'Snapshot limit reached')
            total_size = sum(json.loads(row[0]).get('size', 0) for row in db.execute('SELECT data FROM snapshots'))
            if total_size >= TOTAL_LIMIT:
                fail(409, 'quota', 'Snapshot storage limit reached')
            result = {'id': str(uuid.uuid4()), 'workspace_id': workspace['id'], 'workspace_revision': workspace['revision'], 'schema_version': 1, 'created_at': now(), 'status': 'completed'}
            try:
                document = self._snapshot_document(db, owner, workspace['id'])
                result['sha256'], result['size'] = self._snapshot_file(result['id'], document)
                if total_size + result['size'] > TOTAL_LIMIT:
                    fail(409, 'quota', 'Snapshot storage limit reached')
            except (APIError, OSError, sqlite3.Error, ValueError) as error:
                (self.root / 'snapshots' / result['id']).unlink(missing_ok=True)
                result.pop('sha256', None)
                result.pop('size', None)
                result.update(status='failed', error='snapshot_failed')
                db.execute('INSERT INTO snapshots VALUES (?,?,?,?)', (result['id'], owner, workspace['id'], dump(result)))
                return self._response(409, {'error': {'code': 'snapshot_failed', 'message': (error.message + '. Export source files separately or use a smaller workspace.' if isinstance(error, APIError) else 'Snapshot could not be completed; retry or keep a local export.')}, 'snapshot': result})
            db.execute('INSERT INTO snapshots VALUES (?,?,?,?)', (result['id'], owner, workspace['id'], dump(result)))
            return self._response(201, result)
        row = self._owned(db, 'snapshots', resource_id, owner)
        record = self._resource(row)
        if record['status'] != 'completed':
            return self._response(409, {'error': {'code': 'snapshot_failed', 'message': 'Snapshot is incomplete'}, 'snapshot': record})
        if method == 'GET' and len(parts) == 3:
            return self._response(200, {**record, 'snapshot': self._load_snapshot(record)})
        if method == 'POST' and len(parts) == 4 and parts[3] == 'restore':
            if data.get('sha256') != record['sha256'] or data.get('schema_version') != 1:
                fail(409, 'snapshot_version', 'The expected sha256 and schema_version are required')
            return self._response(201, self._restore(db, owner, record, self._load_snapshot(record)))
        fail(405, 'method_not_allowed', 'Use GET or POST restore')

    def _restore(self, db, owner, record, document):
        # The document came from an owner-filtered logical backup, never the live authentication DB.
        artifacts, runs, exports = document['artifacts'], document['runs'], document['exports']
        if any(len(items) > 1000 for items in (artifacts, runs, exports)):
            fail(409, 'snapshot_limit', 'Snapshot resource limit exceeded')
        self._validate_snapshot(document)
        for table, items, limit in (('artifacts', artifacts, 1000), ('runs', runs, 10000), ('exports', exports, 10000)):
            if db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] + len(items) > limit:
                fail(409, 'quota', 'Restore would exceed resource storage limits')
        current_bytes = sum(json.loads(row[0])['size'] for row in db.execute('SELECT data FROM artifacts'))
        if current_bytes + sum(item['size'] for item in artifacts) > TOTAL_LIMIT:
            fail(409, 'quota', 'Restore would exceed artifact storage limits')
        workspace = self._create_workspace(db, owner, document['workspace']['title'][:189] + ' (restored)', {**document['workspace']['metadata'], 'restored_from_snapshot': record['id'], 'original_workspace_id': document['workspace']['id']})
        mapping = {item['id']: str(uuid.uuid4()) for items in (artifacts, runs, exports) for item in items}
        files = []
        try:
            for artifact in artifacts:
                content = base64.b64decode(artifact['content_base64'], validate=True)
                if len(content) != artifact['size'] or hashlib.sha256(content).hexdigest() != artifact['sha256'] or PRIVATE_PEM.search(content):
                    fail(409, 'integrity', 'Snapshot artifact integrity check failed')
                result = {key: value for key, value in artifact.items() if key != 'content_base64'}
                result.update(id=mapping[artifact['id']], workspace_id=workspace['id'], restored_from=artifact['id'])
                path = self.root / 'artifacts' / result['id']
                self._write(path, content)
                files.append(path)
                db.execute('INSERT INTO artifacts VALUES (?,?,?,?)', (result['id'], owner, workspace['id'], dump(result)))
            for run in runs:
                result = {**run, 'id': mapping[run['id']], 'workspace_id': workspace['id'], 'artifact_ids': [mapping[item] for item in run['artifact_ids']], 'restored_from': run['id'], 'source': 'browser-computed'}
                db.execute('INSERT INTO runs VALUES (?,?,?,?,?)', (result['id'], owner, workspace['id'], result['revision'], dump(result)))
            for export in exports:
                result = {**export, 'id': mapping[export['id']], 'workspace_id': workspace['id'], 'run_id': mapping[export['run_id']], 'restored_from': export['id']}
                db.execute('INSERT INTO exports VALUES (?,?,?,?,?)', (result['id'], owner, workspace['id'], result['run_id'], dump(result)))
        except BaseException:
            for path in files:
                path.unlink(missing_ok=True)
            raise
        return {'workspace': workspace, 'restored_from_snapshot': record['id'], 'counts': {'runs': len(runs), 'artifacts': len(artifacts), 'exports': len(exports)}}
