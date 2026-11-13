"""Command-line behaviour of mavframe-dump: FILE argument, --help, --version
and errors. Run from the repository root after building:  python3 -m pytest tests -v
"""
import os
import re
import subprocess

import harness as h

ROOT = h.ROOT


def header_version():
    text = open(os.path.join(ROOT, "include", "mavframe.h")).read()
    return re.search(r'#define MAVFRAME_VERSION_STRING "([^"]+)"', text).group(1)


def run(args, data=b""):
    return subprocess.run([h.DUMP, *args], input=data, capture_output=True)


def corrupted_bytes():
    frames = h.make_frames(11, 600)
    data, _, _, _ = h.corrupted_stream(frames, 111)
    return data


def test_help_exits_0_and_prints_usage_to_stdout():
    for flag in ("--help", "-h"):
        p = run([flag])
        assert p.returncode == 0, flag
        assert p.stdout.decode().startswith("usage: mavframe-dump [FILE]\n"), flag
        assert "--version" in p.stdout.decode()
        assert p.stderr == b""


def test_version_exits_0_and_matches_header():
    p = run(["--version"])
    assert p.returncode == 0
    assert p.stdout.decode() == f"mavframe-dump {header_version()}\n"
    assert p.stderr == b""


def test_file_mode_output_equals_stdin_mode(tmp_path):
    data = corrupted_bytes()
    path = tmp_path / "capture.bin"
    path.write_bytes(data)
    from_stdin = run([], data)
    from_file = run([str(path)])
    from_dash = run(["-"], data)
    assert from_stdin.returncode == from_file.returncode == from_dash.returncode == 0
    assert from_stdin.stdout.count(b"\n") > 300  # the stream really holds frames
    assert from_file.stdout == from_stdin.stdout == from_dash.stdout
    assert from_file.stderr == from_stdin.stderr == from_dash.stderr
    assert from_file.stderr.decode().startswith(f"bytes={len(data)} ")


def test_file_mode_ignores_stdin(tmp_path):
    path = tmp_path / "capture.bin"
    path.write_bytes(corrupted_bytes())
    assert run([str(path)], b"\xfd" * 50).stdout == run([str(path)]).stdout


def test_missing_file_is_a_clear_error(tmp_path):
    missing = tmp_path / "no-such.tlog"
    p = run([str(missing)])
    assert p.returncode == 1
    assert p.stdout == b""
    err = p.stderr.decode()
    assert err.startswith(f"mavframe-dump: cannot open {missing}: ")
    assert "No such file" in err
    assert "bytes=" not in err  # no counter line pretending a capture was read


def test_directory_is_a_clear_error(tmp_path):
    p = run([str(tmp_path)])
    assert p.returncode == 1
    assert p.stdout == b""
    assert p.stderr.decode().startswith(f"mavframe-dump: cannot read {tmp_path}: ")
    assert "bytes=" not in p.stderr.decode()


def test_bad_arguments_exit_2_with_usage_on_stderr(tmp_path):
    for args in (["--frobnicate"], ["a.bin", "b.bin"]):
        p = run(args)
        assert p.returncode == 2, args
        assert p.stdout == b""
        assert "usage: mavframe-dump [FILE]" in p.stderr.decode(), args
