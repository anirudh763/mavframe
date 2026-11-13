"""Version drift: what the built tool reports (mavframe-dump --version, from
MAVFRAME_VERSION_STRING in mavframe.h) must be the version CMake installs under
and the top entry of CHANGELOG.md."""
import os
import re
import subprocess

import harness as h


def read(name):
    with open(os.path.join(h.ROOT, name), encoding="utf-8") as f:
        return f.read()


def reported_version():
    out = subprocess.run([h.DUMP, "--version"], capture_output=True, check=True).stdout.decode()
    return re.fullmatch(r"mavframe-dump (\d+\.\d+\.\d+)\n", out).group(1)


def test_dump_version_is_the_top_changelog_entry():
    m = re.search(r"^## (\d+\.\d+\.\d+) – \d{4}-\d{2}-\d{2}$", read("CHANGELOG.md"), re.M)
    assert m, "CHANGELOG.md needs a '## X.Y.Z – YYYY-MM-DD' entry"
    assert reported_version() == m.group(1)


def test_dump_version_is_the_cmake_project_version_and_numeric_macros():
    m = re.search(r"project\(mavframe VERSION (\S+)", read("CMakeLists.txt"))
    assert m, "CMakeLists.txt has no project(mavframe VERSION ...)"
    text = read("include/mavframe.h")
    parts = [re.search(rf"#define MAVFRAME_VERSION_{n} (\d+)", text).group(1) for n in ("MAJOR", "MINOR", "PATCH")]
    assert reported_version() == m.group(1) == ".".join(parts)
