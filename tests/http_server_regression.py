import contextlib
import errno
import http.client
import importlib.util
import io
import json
import os
import socket
import time
from unittest.mock import Mock, patch
from pathlib import Path
import tempfile
import threading
import unittest


class StaticServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'index.html').write_text('<!doctype html><title>Test</title><script src="app.js"></script><link rel="stylesheet" href="site.css">')
        (self.root / 'site.css').write_text('body{}')
        (self.root / 'js').mkdir()
        (self.root / 'js/app.js').write_text('export const ready = true;')
        (self.root / 'mavframe.wasm').write_bytes(b'fixture wasm')
        (self.root / 'app.js').write_text('export const ready = true;')
        (self.root / '.env').write_text('DO_NOT_SERVE_THIS')
        spec = importlib.util.spec_from_file_location('app_static_server', Path(__file__).parents[1] / 'tools' / 'http_server.py')
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        self.server = self.mod.make_server('127.0.0.1', 0, self.root, 'mavframe')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def get(self, path, headers=None, method='GET'):
        before = self.server.totals['requests_total']
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        deadline = time.monotonic() + 1
        while self.server.totals['requests_total'] == before and time.monotonic() < deadline:
            time.sleep(.001)
        return result

    def test_exact_routes_and_missing_asset_api(self):
        for path in ['/', '/anomalies', '/stream', '/system']:
            status, headers, body = self.get(path)
            self.assertEqual(status, 200)
            self.assertIn(b'<title>Test</title>', body)
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        for path in ['/api/missing', '/missing.js', '/unknown', '/.env', '/%2e%2e/.env']:
            status, _, body = self.get(path)
            self.assertIn(status, (400, 404))
            self.assertNotIn(b'DO_NOT_SERVE_THIS', body)
            self.assertNotIn(b'<title>Test</title>', body)

    def test_directory_index_preserves_legacy_links_without_listing(self):
        (self.root / 'legacy').mkdir()
        (self.root / 'legacy/index.html').write_text('Legacy entry')
        self.assertEqual(self.get('/legacy/')[0], 200)
        (self.root / 'empty').mkdir()
        self.assertEqual(self.get('/empty/')[0], 404)

    def test_offline_asset_mime_contracts(self):
        for suffix, expected in [('.md', 'text/plain'), ('.sql', 'text/plain'), ('.ttf', 'font/ttf'), ('.wasm', 'application/wasm')]:
            (self.root / ('asset'+suffix)).write_bytes(b'fixture')
            self.assertEqual(self.get('/asset'+suffix)[1]['Content-Type'], expected)

    def test_real_health_readiness_and_metrics(self):
        self.assertEqual(json.loads(self.get('/healthz')[2])['status'], 'ok')
        self.assertEqual(self.get('/readyz')[0], 200)
        self.get('/missing.js')
        status, _, body = self.get('/metrics')
        self.assertEqual(status, 200)
        self.assertIn(b'app_http_requests_total', body)
        self.assertIn(b'app_http_request_duration_seconds_bucket', body)
        system = json.loads(self.get('/api/system')[2])
        self.assertGreater(system['http']['requests_total'], 0)
        self.assertGreater(system['http']['errors_total'], 0)
        (self.root / 'index.html').unlink()
        self.assertEqual(self.get('/readyz')[0], 503)
        self.assertEqual(self.get('/healthz')[0], 200)

    def test_query_and_credentials_never_enter_logs_or_labels(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status, headers, _ = self.get('/?token=PRIVATE_VALUE', {'Authorization': 'Bearer PRIVATE_VALUE', 'X-Request-ID': 'valid-id'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['X-Request-ID'], 'valid-id')
        record = json.loads(output.getvalue().strip())
        self.assertEqual(record['trace_id'], 'valid-id')
        self.assertTrue(all(k in record for k in ['timestamp', 'level', 'service', 'latency_ms']))
        self.assertNotIn('PRIVATE_VALUE', output.getvalue())
        self.assertNotIn(b'PRIVATE_VALUE', self.get('/metrics')[2])

    def test_symlink_outside_root_is_not_served(self):
        with tempfile.TemporaryDirectory() as outside:
            secret = Path(outside) / 'secret.txt'
            secret.write_text('PRIVATE_OUTSIDE')
            (self.root / 'escape.txt').symlink_to(secret)
            status, _, body = self.get('/escape.txt')
            self.assertEqual(status, 404)
            self.assertNotIn(b'PRIVATE_OUTSIDE', body)

    def test_exact_route_rejects_index_symlink_even_after_startup(self):
        with tempfile.TemporaryDirectory() as outside:
            secret = Path(outside) / 'index.html'
            secret.write_text('OUTSIDE_INDEX_CANARY')
            (self.root / 'index.html').unlink()
            (self.root / 'index.html').symlink_to(secret)
            for route in ['/', '/anomalies', '/stream', '/system']:
                status, _, body = self.get(route)
                self.assertEqual(status, 404)
                self.assertNotIn(b'OUTSIDE_INDEX_CANARY', body)
            self.assertEqual(self.get('/readyz')[0], 503)
            other = None
            try:
                with self.assertRaises(ValueError):
                    other = self.mod.make_server('127.0.0.1', 0, self.root, 'mavframe')
            finally:
                if other:
                    other.server_close()

    def test_file_and_directory_swap_to_symlink_cannot_escape(self):
        for swap_directory in [False, True]:
            with self.subTest(directory=swap_directory), tempfile.TemporaryDirectory() as outside:
                root = self.root.resolve()
                folder = root / ('nested' if swap_directory else 'single')
                folder.mkdir()
                target = folder / 'asset.txt'
                target.write_text('public fixture')
                (Path(outside) / 'asset.txt').write_text('SWAP_OUTSIDE_CANARY')
                original_path_open, original_os_open = Path.open, os.open
                swapped = []

                def swap_once():
                    if swapped:
                        return
                    swapped.append(True)
                    if swap_directory:
                        folder.rename(root / 'old-nested')
                        folder.symlink_to(outside, target_is_directory=True)
                    else:
                        target.unlink()
                        target.symlink_to(Path(outside) / 'asset.txt')

                def path_open(path, *args, **kwargs):
                    if path == target:
                        swap_once()
                    return original_path_open(path, *args, **kwargs)

                def fd_open(path, flags, *args, **kwargs):
                    if kwargs.get('dir_fd') is not None and path == ('nested' if swap_directory else 'asset.txt'):
                        swap_once()
                    return original_os_open(path, flags, *args, **kwargs)

                with patch.object(Path, 'open', path_open), patch.object(self.mod.os, 'open', fd_open):
                    status, _, body = self.get(f'/{folder.name}/asset.txt')
                self.assertTrue(swapped, 'the swap must happen at the actual open boundary')
                self.assertEqual(status, 404)
                self.assertNotIn(b'SWAP_OUTSIDE_CANARY', body)

    def test_required_parser_and_html_assets_affect_readiness_only(self):
        for name in ['mavframe.wasm', 'js/app.js', 'app.js', 'site.css']:
            path = self.root / name
            original = path.read_bytes()
            path.unlink()
            self.assertEqual(self.get('/readyz')[0], 503, name)
            system = json.loads(self.get('/api/system')[2])
            self.assertEqual(system['readiness']['status'], 'not_ready')
            self.assertEqual(self.get('/healthz')[0], 200)
            path.write_bytes(original)
            self.assertEqual(self.get('/readyz')[0], 200, name)
        self.assertIn('asset availability', json.loads(self.get('/readyz')[2])['scope'])

    def test_unsupported_methods_are_counted_once_and_logged_without_query(self):
        before = dict(self.server.totals)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status, headers, _ = self.get('/?token=METHOD_PRIVATE', method='POST')
        self.assertEqual(status, 501)
        self.assertTrue(headers['X-Request-ID'])
        self.assertEqual(self.server.totals['requests_total'], before['requests_total'] + 1)
        self.assertEqual(self.server.totals['errors_total'], before['errors_total'] + 1)
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['status'], 501)
        self.assertNotIn('METHOD_PRIVATE', output.getvalue())

    def test_overload_response_is_counted_and_logged(self):
        before = dict(self.server.totals)
        output = io.StringIO()
        for _ in range(32):
            self.server.slots.acquire()
        try:
            with contextlib.redirect_stdout(output):
                status, _, _ = self.get('/healthz?token=OVERLOAD_PRIVATE')
        finally:
            for _ in range(32):
                self.server.slots.release()
        self.assertEqual(status, 503)
        self.assertEqual(self.server.totals['requests_total'], before['requests_total'] + 1)
        self.assertEqual(self.server.totals['errors_total'], before['errors_total'] + 1)
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['status'], 503)
        self.assertNotIn('OVERLOAD_PRIVATE', output.getvalue())

    def test_malformed_target_returns_400_without_traceback(self):
        before = dict(self.server.totals)
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with socket.create_connection(self.server.server_address, timeout=3) as connection:
                connection.sendall(b'GET http://[invalid/ HTTP/1.0\r\nHost: local\r\n\r\n')
                response = b''
                while chunk := connection.recv(65536):
                    response += chunk
            deadline = time.monotonic() + 1
            while self.server.totals['requests_total'] == before['requests_total'] and time.monotonic() < deadline:
                time.sleep(.001)
        self.assertTrue(response.startswith(b'HTTP/1.0 400'), response)
        self.assertNotIn('Traceback', errors.getvalue())
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['status'], 400)
        self.assertEqual(self.server.totals['requests_total'], before['requests_total'] + 1)

    def test_all_app_readiness_checks_local_critical_assets(self):
        cases = {
            'hashwing': ['console/entry.js', 'console/site.css', 'console/assets/engine.wasm', 'console/precache.json'],
            'mavframe': ['js/app.js', 'mavframe.wasm', 'site.css'],
            'cuereport': ['index.html'],
            'issue-warehouse': ['explorer.js', 'data/issues.json', 'data/manifest.json'],
        }
        for app, critical in cases.items():
            with self.subTest(app=app), tempfile.TemporaryDirectory() as work:
                root = Path(work)
                for name in [*critical, 'index.html']:
                    path = root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text('fixture')
                index = root / ('console/index.html' if app == 'hashwing' else 'index.html')
                if app == 'hashwing':
                    index.write_text('<script src="/flightseal/console/entry.js"></script><link rel="stylesheet" href="site.css">')
                    (root / 'console/precache.json').write_text(json.dumps({'files': ['console/index.html', 'console/assets/engine.wasm']}))
                elif app == 'mavframe':
                    index.write_text('<script src="js/app.js"></script><link rel="stylesheet" href="site.css">')
                else:
                    index.write_text('<script>/* bundled public core */</script>')
                server = self.mod.make_server('127.0.0.1', 0, root, app)
                try:
                    self.assertTrue(server.ready(), app)
                    for name in critical:
                        path = root / name
                        original = path.read_bytes()
                        path.unlink()
                        self.assertFalse(server.ready(), f'{app}: {name}')
                        path.write_bytes(original)
                        self.assertTrue(server.ready(), f'{app}: {name} restored')
                finally:
                    server.server_close()

    def test_asset_discovery_has_a_finite_entry_and_dependency_limit(self):
        index = self.root / 'index.html'
        for html in ['x' * (1024 * 1024 + 1), ''.join(f'<script src="asset-{n}.js"></script>' for n in range(65))]:
            index.write_text(html)
            with self.assertRaises(ValueError):
                self.mod.make_server('127.0.0.1', 0, self.root, 'mavframe')

    def test_nonregular_asset_is_rejected_without_blocking(self):
        os.mkfifo(self.root / 'pipe')
        self.assertEqual(self.get('/pipe')[0], 404)
        self.assertEqual(self.get('/healthz')[0], 200)

    def test_document_root_descriptor_closes_with_server(self):
        descriptor = self.server.root_fd
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        with self.assertRaises(OSError):
            os.fstat(descriptor)

    def test_head_is_observed_once_with_no_response_body(self):
        before = dict(self.server.totals)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status, headers, body = self.get('/readyz', method='HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'')
        self.assertGreater(int(headers['Content-Length']), 0)
        self.assertEqual(self.server.totals['requests_total'], before['requests_total'] + 1)
        self.assertEqual(len(output.getvalue().splitlines()), 1)

    def test_server_close_drains_an_inflight_file_before_closing_root(self):
        payload = b'complete static response' * 4096
        (self.root / 'drain.bin').write_bytes(payload)
        copying, release, closing, closed = (threading.Event() for _ in range(4))
        result, errors = [], []
        original_copy = self.mod.Handler.copyfile

        def held_copy(handler, source, output):
            copying.set()
            if not release.wait(2):
                raise TimeoutError('test copy gate was not released')
            original_copy(handler, source, output)

        def download():
            try:
                result.append(self.get('/drain.bin'))
            except Exception as error:
                errors.append(error)

        def close():
            closing.set()
            self.server.server_close()
            closed.set()

        with patch.object(self.mod.Handler, 'copyfile', held_copy), patch.object(self.mod.AppServer, '_DRAIN_SECONDS', .5, create=True), patch.object(self.mod.AppServer, '_ABORT_SECONDS', .1, create=True):
            request = threading.Thread(target=download, daemon=True)
            closer = threading.Thread(target=close, daemon=True)
            request.start()
            try:
                self.assertTrue(copying.wait(1), 'real file copy must be in flight')
                self.server.shutdown()
                closer.start()
                self.assertTrue(closing.wait(1))
                self.assertFalse(closed.wait(.05), 'close must wait for the active response')
                os.fstat(self.server.root_fd)
            finally:
                release.set()
                request.join(timeout=2)
                if closer.ident is not None:
                    closer.join(timeout=2)
        self.assertEqual(errors, [])
        self.assertTrue(closed.is_set())
        self.assertEqual(result[0][0], 200)
        self.assertEqual(result[0][2], payload)
        self.assertIsNone(self.server.root_fd)
        self.assertEqual(self.server.slots._value, 32)

    def test_server_close_aborts_idle_connection_after_bounded_drain(self):
        connection = socket.create_connection(self.server.server_address, timeout=1)
        try:
            deadline = time.monotonic() + 1
            while self.server.slots._value == 32 and time.monotonic() < deadline:
                time.sleep(.001)
            self.assertEqual(self.server.slots._value, 31, 'the server must own the idle connection')
            self.server.shutdown()
            with patch.object(self.mod.AppServer, '_DRAIN_SECONDS', .05, create=True), patch.object(self.mod.AppServer, '_ABORT_SECONDS', .05, create=True):
                started = time.monotonic()
                self.server.server_close()
                elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, .04)
            self.assertLess(elapsed, 1, 'shutdown must remain bounded')
            self.assertEqual(connection.recv(1), b'')
            self.assertEqual(self.server.slots._value, 32)
            self.assertIsNone(self.server.root_fd)
        finally:
            connection.close()

    def test_partial_read_write_and_disconnect_failures_keep_wire_status(self):
        payload = b'packet bytes ' * 16384
        (self.root / 'transfer.bin').write_bytes(payload)
        original_copy = self.mod.Handler.copyfile
        for fault in ['read', 'write', 'aborted']:
            with self.subTest(fault=fault):
                calls = 0
                error = ConnectionAbortedError(errno.ECONNABORTED, 'PRIVATE_IO') if fault == 'aborted' else OSError(errno.EIO, 'PRIVATE_IO')

                def fail_copy(handler, source, output):
                    bounded_source = Mock(wraps=source)
                    bounded_source.read.side_effect = lambda size: source.read(min(size, 65536))
                    stream = bounded_source if fault == 'read' else output
                    method = 'read' if fault == 'read' else 'write'
                    operation = getattr(stream, method)
                    proxy = Mock(wraps=stream)

                    def fail_after_first(*args):
                        nonlocal calls
                        calls += 1
                        if calls > 1:
                            raise error
                        return operation(*args)

                    getattr(proxy, method).side_effect = fail_after_first
                    original_copy(handler, proxy if fault == 'read' else bounded_source, output if fault == 'read' else proxy)

                before = dict(self.server.totals)
                logs, errors = io.StringIO(), io.StringIO()
                with patch.object(self.mod.Handler, 'copyfile', fail_copy), contextlib.redirect_stdout(logs), contextlib.redirect_stderr(errors):
                    with socket.create_connection(self.server.server_address, timeout=3) as connection:
                        connection.sendall(b'GET /transfer.bin?token=PRIVATE_QUERY HTTP/1.0\r\nHost: local\r\n\r\n')
                        raw = b''
                        while chunk := connection.recv(65536):
                            raw += chunk
                    deadline = time.monotonic() + 1
                    while self.server.totals['requests_total'] == before['requests_total'] and time.monotonic() < deadline:
                        time.sleep(.001)
                self.assertEqual(raw.count(b'HTTP/1.0 '), 1)
                self.assertTrue(raw.startswith(b'HTTP/1.0 200'))
                self.assertNotIn(b'503 Service', raw)
                headers, body = raw.split(b'\r\n\r\n', 1)
                self.assertGreater(len(body), 0)
                self.assertLess(len(body), len(payload))

                class Wire:
                    def makefile(self, *_):
                        return io.BytesIO(raw)

                response = http.client.HTTPResponse(Wire())
                response.begin()
                self.assertEqual(response.status, 200)
                with self.assertRaises(http.client.IncompleteRead):
                    response.read()
                records = [json.loads(line) for line in logs.getvalue().splitlines()]
                self.assertEqual(len(records), 1)
                self.assertEqual(records[0]['status'], 200)
                self.assertTrue(records[0]['transfer_failed'])
                self.assertEqual(records[0]['level'], 'error')
                self.assertEqual(self.server.totals['requests_total'], before['requests_total'] + 1)
                self.assertEqual(self.server.totals['errors_total'], before['errors_total'] + 1)
                self.assertNotIn('Traceback', errors.getvalue())
                self.assertNotIn('PRIVATE', logs.getvalue())
        metrics = self.get('/metrics')[2]
        self.assertIn(b'app_http_transfer_errors_total{route="static"} 3.0', metrics)

    def test_io_error_before_headers_returns_one_503(self):
        logs = io.StringIO()
        with patch.object(self.mod, 'open_asset', side_effect=OSError(errno.EIO, 'PRIVATE_IO')), contextlib.redirect_stdout(logs):
            status, _, body = self.get('/app.js')
        self.assertEqual(status, 503)
        self.assertIn(b'Asset unavailable', body)
        record = json.loads(logs.getvalue())
        self.assertEqual(record['status'], 503)
        self.assertFalse(record['transfer_failed'])
        self.assertNotIn('PRIVATE_IO', logs.getvalue())

    def test_zero_byte_connection_is_not_an_http_request(self):
        before = dict(self.server.totals)
        logs = io.StringIO()
        with contextlib.redirect_stdout(logs):
            connection = socket.create_connection(self.server.server_address, timeout=1)
            deadline = time.monotonic() + 1
            while self.server.slots._value == 32 and time.monotonic() < deadline:
                time.sleep(.001)
            self.assertEqual(self.server.slots._value, 31)
            connection.close()
            deadline = time.monotonic() + 1
            while self.server.slots._value != 32 and time.monotonic() < deadline:
                time.sleep(.001)
        self.assertEqual(self.server.totals, before)
        self.assertEqual(logs.getvalue(), '')

    def test_zero_byte_overload_connection_is_not_counted(self):
        before = dict(self.server.totals)
        logs = io.StringIO()
        for _ in range(32):
            self.server.slots.acquire()
        try:
            with contextlib.redirect_stdout(logs):
                with socket.create_connection(self.server.server_address, timeout=1) as connection:
                    self.assertEqual(connection.recv(4096), b'')
            self.assertEqual(self.server.totals, before)
            self.assertEqual(logs.getvalue(), '')
        finally:
            for _ in range(32):
                self.server.slots.release()

    def test_414_and_overload_use_bounded_routes_and_security_headers(self):
        logs = io.StringIO()
        with contextlib.redirect_stdout(logs):
            status, normal, _ = self.get('/' + 'x' * 4100)
        self.assertEqual(status, 414)
        self.assertEqual(json.loads(logs.getvalue())['route'], 'bad_request')
        for _ in range(32):
            self.server.slots.acquire()
        try:
            status, overload, _ = self.get('/healthz')
        finally:
            for _ in range(32):
                self.server.slots.release()
        self.assertEqual(status, 503)
        for name in ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Content-Security-Policy', 'Cache-Control']:
            self.assertEqual(overload[name], normal[name], name)

    def test_wrong_app_and_missing_index_fail_startup(self):
        with self.assertRaises(ValueError):
            self.mod.make_server('127.0.0.1', 0, self.root, 'unknown')
        (self.root / 'index.html').unlink()
        with self.assertRaises(ValueError):
            self.mod.make_server('127.0.0.1', 0, self.root, 'mavframe')


if __name__ == '__main__':
    unittest.main()
