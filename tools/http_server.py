"""Serve existing browser apps and measure HTTP serving, not browser/domain work."""
import argparse
import datetime
import errno
import functools
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import signal
import socket
import stat
import threading
import time
from urllib.parse import unquote, urljoin, urlsplit
import uuid

from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

ROUTES = {
    'hashwing': ('/', '/verify', '/benchmarks', '/system'),
    'mavframe': ('/', '/anomalies', '/stream', '/system'),
    'cuereport': ('/', '/ablation', '/statistics', '/system'),
    'issue-warehouse': ('/', '/taxonomy', '/export', '/system'),
}
CANONICAL_ROUTES = ('/overview', '/workbench', '/reports', '/settings')
ROUTES = {app: (*paths, *CANONICAL_ROUTES) for app, paths in ROUTES.items()}
ENDPOINTS = ('/healthz', '/readyz', '/metrics', '/api/system')
REQUIRED_ASSETS = {
    'hashwing': ('console/precache.json',),
    'mavframe': ('mavframe.wasm', 'js/app.js'),
    'cuereport': (),  # The public entry bundles the core and dataset inline.
    'issue-warehouse': ('data/issues.json', 'data/manifest.json', 'explorer.js'),
}
READINESS_SCOPE = 'Local HTTP asset availability only; no browser/domain verification'
RESPONSE_HEADERS = (
    ('X-Content-Type-Options', 'nosniff'),
    ('X-Frame-Options', 'DENY'),
    ('Referrer-Policy', 'no-referrer'),
    ('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"),
    ('Cache-Control', 'no-cache'),
)


def open_asset(root_fd, relative, directory_index=False):
    """Anchor every component to an open directory; never follow symlinks."""
    if root_fd is None:
        raise OSError(errno.EBADF, 'Serving process is closing')
    parts = [part for part in relative.split('/') if part]
    if relative.startswith('/') or not parts or any(part.startswith('.') or '\\' in part or '\x00' in part for part in parts):
        raise FileNotFoundError(errno.ENOENT, 'Not found')
    directory = os.dup(root_fd)
    descriptor = None
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        name = parts[-1]
        if directory_index and stat.S_ISDIR(os.fstat(descriptor).st_mode):
            child = os.open('index.html', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
            os.close(descriptor)
            descriptor, name = child, 'index.html'
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise FileNotFoundError(errno.ENOENT, 'Not found')
        source = os.fdopen(descriptor, 'rb')
        descriptor = None
        return source, name
    finally:
        os.close(directory)
        if descriptor is not None:
            os.close(descriptor)


class EntryAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script':
            path = attrs.get('src')
        elif tag == 'link' and 'stylesheet' in (attrs.get('rel') or '').split():
            path = attrs.get('href')
        else:
            return
        if path:
            self.paths.add(path)
            if len(self.paths) > 64:
                raise ValueError('Too many entry asset dependencies')


def required_assets(root_fd, app, index):
    source, _ = open_asset(root_fd, index)
    with source:
        html = source.read(1024 * 1024 + 1)
    if len(html) > 1024 * 1024:
        raise ValueError('Application entry exceeds 1 MiB')
    parser = EntryAssets()
    parser.feed(html.decode('utf-8'))
    assets = {index, *REQUIRED_ASSETS[app]}
    for reference in parser.paths:
        url = urlsplit(urljoin('/' + index, reference))
        if not url.scheme and not url.netloc:
            path = unquote(url.path)
            assets.add(path.removeprefix('/flightseal/') if app == 'hashwing' and path.startswith('/flightseal/') else path.lstrip('/'))
    valid = True
    if app == 'hashwing':
        try:
            source, _ = open_asset(root_fd, 'console/precache.json')
            with source:
                data = source.read(65537)
            if len(data) > 65536:
                raise ValueError('Build manifest exceeds 64 KiB')
            files = json.loads(data).get('files')
            if not isinstance(files, list) or len(files) > 64 or not all(isinstance(path, str) for path in files) or not any(path.endswith('.wasm') for path in files):
                raise ValueError('Build manifest must name its Wasm asset')
            assets.update(path for path in files if not path.endswith('/'))
        except (OSError, ValueError, AttributeError):
            valid = False
    return tuple(sorted(assets)), valid


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    _DRAIN_SECONDS = 10
    _ABORT_SECONDS = 1

    def __init__(self, *args, **kwargs):
        self._active_connections = set()
        self._connections_changed = threading.Condition()
        super().__init__(*args, **kwargs)

    def process_request(self, request, address):
        started = time.monotonic()
        request.settimeout(10)
        if not self.slots.acquire(blocking=False):
            try:
                # A bare TCP connection has no HTTP request to reject or measure.
                request.settimeout(.05)
                if not request.recv(1, socket.MSG_PEEK):
                    self.shutdown_request(request)
                    return
            except (ConnectionError, TimeoutError):
                self.shutdown_request(request)
                return
            request.settimeout(10)
            trace_id = uuid.uuid4().hex
            status = 503
            try:
                headers = ''.join(f'{name}: {value}\r\n' for name, value in RESPONSE_HEADERS)
                request.sendall(f'HTTP/1.0 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\nX-Request-ID: {trace_id}\r\n{headers}\r\n'.encode('ascii'))
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
                status = 499
            finally:
                self.shutdown_request(request)
                self.record('overload', status, started, trace_id, transfer_failed=status == 499)
            return
        with self._connections_changed:
            self._active_connections.add(request)
        try:
            super().process_request(request, address)
        except BaseException:
            self._release_connection(request)
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self._release_connection(request)

    def _release_connection(self, request):
        with self._connections_changed:
            self._active_connections.discard(request)
            self.slots.release()
            self._connections_changed.notify_all()

    def record(self, route, status, started, trace_id, transfer_failed=False):
        elapsed = time.monotonic() - started
        self.requests.labels(route, f'{status // 100}xx').inc()
        self.latency.labels(route).observe(elapsed)
        if transfer_failed:
            self.transfer_errors.labels(route).inc()
        print(json.dumps({'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'level': 'error' if status >= 500 or transfer_failed else 'info', 'service': self.app, 'trace_id': trace_id, 'latency_ms': round(elapsed * 1000, 3), 'route': route, 'status': status, 'transfer_failed': transfer_failed}), flush=True)
        with self.totals_lock:
            self.totals['requests_total'] += 1
            self.totals['errors_total'] += int(status >= 400 or transfer_failed)

    def ready(self):
        if self.persistence is not None and not self.persistence.ready():
            return False
        if not self.asset_config_valid:
            return False
        for asset in self.required_assets:
            try:
                source, _ = open_asset(self.root_fd, asset)
                source.close()
            except OSError:
                return False
        return True

    def server_close(self):
        super().server_close()
        with self._connections_changed:
            self._connections_changed.wait_for(lambda: not self._active_connections, self._DRAIN_SECONDS)
            remaining = tuple(self._active_connections)
        for connection in remaining:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.close_request(connection)
        with self._connections_changed:
            self._connections_changed.wait_for(lambda: not self._active_connections, self._ABORT_SECONDS)
            if getattr(self, 'root_fd', None) is not None:
                os.close(self.root_fd)
                self.root_fd = None


class Handler(SimpleHTTPRequestHandler):
    server_version = 'AppHTTP'
    sys_version = ''

    def handle_one_request(self):
        started = time.monotonic()
        self.trace_id, self.route, self.status_code = uuid.uuid4().hex, 'bad_request', None
        self.private_api = False
        self.raw_requestline = b''
        self.response_headers_sent = self.transfer_failed = False
        try:
            super().handle_one_request()
        except OSError:
            self._connection_failure()
        finally:
            if self.status_code is not None:
                self.server.record(self.route, self.status_code, started, self.trace_id, self.transfer_failed)

    def _connection_failure(self):
        self.close_connection = True
        if self.response_headers_sent:
            self.transfer_failed = True
        elif self.raw_requestline:
            self.status_code = 499

    def parse_request(self):
        parsed = super().parse_request()
        if parsed:
            trace = self.headers.get('X-Request-ID', '')
            if re.fullmatch(r'[A-Za-z0-9._-]{1,64}', trace):
                self.trace_id = trace
        return parsed

    def send_error(self, code, message=None, explain=None):
        self.route = 'method_not_allowed' if code == 501 else 'bad_request'
        self.close_connection = True
        self._json(code, {'error': self.responses.get(code, ('Request rejected',))[0]}, getattr(self, 'command', '') == 'HEAD')

    def log_message(self, *_):
        pass

    def log_request(self, code='-', size='-'):
        self.status_code = int(code) if str(code).isdigit() else 500

    def end_headers(self):
        for name, value in RESPONSE_HEADERS:
            if name == 'Cache-Control' and getattr(self, 'private_api', False):
                continue
            self.send_header(name, value)
        self.send_header('X-Request-ID', getattr(self, 'trace_id', ''))
        super().end_headers()
        self.response_headers_sent = True

    def _json(self, status, value, head=False):
        data = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        if getattr(self, 'private_api', False):
            self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def do_HEAD(self):
        self._get(head=True)

    def do_GET(self):
        self._get()

    def do_POST(self):
        if self.server.persistence is None or not self.path.startswith('/api/'):
            self.send_error(501)
            return
        if not self._api():
            self._json(404, {'error': 'Unknown API endpoint'})

    do_PUT = do_PATCH = do_DELETE = do_POST

    def _api(self, head=False):
        if self.server.persistence is None or not self.path.startswith('/api/'):
            return False
        self.route = '/'.join(urlsplit(self.path).path.split('/')[:3])
        self.private_api = True
        body, upload_slot = b'', False
        try:
            if self.headers.get('Transfer-Encoding'):
                self.close_connection = True
                self._json(400, {'error': 'Transfer-Encoding is unsupported'}, head)
                return True
            length_text = self.headers.get('Content-Length', '0')
            if not re.fullmatch(r'[0-9]{1,10}', length_text) or len(self.headers.get_all('Content-Length', [])) > 1:
                self.close_connection = True
                self._json(400, {'error': 'Invalid Content-Length'}, head)
                return True
            length = int(length_text)
            artifact = urlsplit(self.path).path == '/api/artifacts'
            if length > (32 * 1024 * 1024 if artifact else 65536):
                self.close_connection = True
                self._json(413, {'error': 'Request exceeds the upload limit'}, head)
                return True
            if length > 65536:
                upload_slot = self.server.upload_slot.acquire(blocking=False)
                if not upload_slot:
                    self.close_connection = True
                    self._json(429, {'error': 'Another upload is in progress; retry later'}, head)
                    return True
            if length:
                body = self.rfile.read(length)
                if len(body) != length:
                    self.close_connection = True
                    self._json(400, {'error': 'Incomplete request body'}, head)
                    return True
            result = self.server.persistence.handle('GET' if head else self.command, self.path, dict(self.headers), body, self.client_address[0])
            if result is None:
                return False
            status, headers, content = result
            self.send_response(status)
            for name, value in headers.items():
                if name.lower() != 'content-length':
                    self.send_header(name, value)
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            if not head:
                self.wfile.write(content)
            return True
        finally:
            if upload_slot:
                self.server.upload_slot.release()

    def _get(self, head=False):
        self.status_code = 500
        self.route = 'not_found'
        try:
            if len(self.path) > 4096:
                self.route = 'bad_request'
                self._json(414, {'error': 'URL too long'}, head)
                return
            try:
                path = unquote(urlsplit(self.path).path)
            except ValueError:
                self.route = 'bad_request'
                self._json(400, {'error': 'Invalid request target'}, head)
                return
            if '\x00' in path or '\\' in path or any(part == '..' or part.startswith('.') for part in path.split('/') if part):
                self._json(404, {'error': 'Not found'}, head)
                return
            if path in ENDPOINTS:
                self.route = path
                if path == '/healthz':
                    self._json(200, {'status': 'ok', 'service': self.server.app}, head)
                elif path == '/readyz':
                    ready = self.server.ready()
                    scope = 'HTTP assets and application persistence availability' if self.server.persistence else READINESS_SCOPE
                    self._json(200 if ready else 503, {'status': 'ready' if ready else 'not_ready', 'scope': scope}, head)
                elif path == '/api/system':
                    ready = self.server.ready()
                    with self.server.totals_lock:
                        totals = dict(self.server.totals)
                    scope = 'HTTP assets and application persistence availability' if self.server.persistence else READINESS_SCOPE
                    self._json(200, {'service': self.server.app, 'status': 'ready' if ready else 'not_ready', 'uptime_seconds': round(time.monotonic()-self.server.started, 3), 'health': {'status': 'ok'}, 'readiness': {'status': 'ready' if ready else 'not_ready', 'scope': scope}, 'persistence': {'enabled': self.server.persistence is not None}, 'http': totals, 'scope': 'HTTP serving process; domain/browser operations are not measured'}, head)
                else:
                    data = generate_latest(self.server.registry)
                    self.send_response(200)
                    self.send_header('Content-Type', CONTENT_TYPE_LATEST)
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    if not head:
                        self.wfile.write(data)
                return
            if path.startswith('/api/'):
                if self._api(head):
                    return
                self._json(404, {'error': 'Unknown API endpoint'}, head)
                return
            if path in ROUTES[self.server.app]:
                self.route = path
                relative = self.server.index
            else:
                relative = path.removeprefix('/flightseal/') if self.server.app == 'hashwing' and path.startswith('/flightseal/') else path.lstrip('/')
                self.route = 'static'
            source, name = open_asset(self.server.root_fd, relative, directory_index=self.route == 'static')
            with source:
                size = os.fstat(source.fileno()).st_size
                kind = {'.wasm': 'application/wasm', '.mjs': 'text/javascript', '.webmanifest': 'application/manifest+json', '.md': 'text/plain', '.sql': 'text/plain', '.ttf': 'font/ttf', '.woff2': 'font/woff2'}.get(Path(name).suffix) or mimetypes.guess_type(name)[0] or 'application/octet-stream'
                entry = self.server.persistence is not None and (self.route != 'static' or relative.rstrip('/') in {self.server.index, str(Path(self.server.index).parent)})
                body = source.read(1024 * 1024 + 1) if entry else None
                if body is not None:
                    if b'<meta name="server-persistence" content="enabled">' not in body:
                        body = body.replace(b'<head>', b'<head><meta name="server-persistence" content="enabled">', 1)
                    size = len(body)
                self.send_response(200)
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(size))
                self.end_headers()
                if not head:
                    if body is not None:
                        self.wfile.write(body)
                    else:
                        self.copyfile(source, self.wfile)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
            self._connection_failure()
        except OSError as error:
            if self.response_headers_sent:
                self._connection_failure()
            elif error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                self.route = 'not_found'
                self._json(404, {'error': 'Not found'}, head)
            else:
                self._json(503, {'error': 'Asset unavailable; retry or restart the serving process'}, head)


def make_server(host, port, root, app):
    root = Path(root).resolve()
    if app not in ROUTES:
        raise ValueError('Unsupported application')
    index = 'console/index.html' if app == 'hashwing' else 'index.html'
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        assets, valid = required_assets(root_fd, app, index)
    except (OSError, ValueError) as error:
        os.close(root_fd)
        raise ValueError('Built application entry is missing or invalid') from error
    persistence = None
    if os.environ.get('APP_DATA_DIR'):
        try:
            try:
                from persistence import Persistence
            except ModuleNotFoundError as error:
                if error.name != 'persistence':
                    raise
                from runtime.persistence import Persistence
            persistence = Persistence(app, root)
        except BaseException:
            os.close(root_fd)
            raise
    try:
        server = AppServer((host, port), functools.partial(Handler, directory=str(root)))
    except BaseException:
        os.close(root_fd)
        raise
    server.app, server.root, server.index = app, root, index
    server.persistence = persistence
    server.upload_slot = threading.BoundedSemaphore(1)
    server.root_fd, server.required_assets, server.asset_config_valid = root_fd, assets, valid
    server.started = time.monotonic()
    server.slots = threading.BoundedSemaphore(32)
    server.registry = CollectorRegistry()
    server.requests = Counter('app_http_requests_total', 'Completed HTTP requests', ['route', 'status_class'], registry=server.registry)
    server.transfer_errors = Counter('app_http_transfer_errors_total', 'HTTP responses with a failed transfer', ['route'], registry=server.registry)
    server.latency = Histogram('app_http_request_duration_seconds', 'HTTP serving duration in seconds', ['route'], registry=server.registry, buckets=(.001, .005, .01, .025, .05, .1, .25, .5, 1, 2, 5))
    server.totals = {'requests_total': 0, 'errors_total': 0}
    server.totals_lock = threading.Lock()
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--app', choices=ROUTES, required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    server = make_server(args.host, args.port, args.root, args.app)
    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=.2)
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
