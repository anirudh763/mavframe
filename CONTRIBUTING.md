# Contributing

Thanks for helping. The parser is meant to stay small enough to read in one
sitting, so the most useful contributions are careful ones.

## Ways to help

- **Try it on a real capture.** No capture from a real radio link has been
  tested yet. If you run `mavframe-dump` or the inspector on one, open an issue
  with what it reported and what you expected. Check the file first: a `.tlog`
  holds GPS positions and system ids.
- **Report a wrong result.** A frame mavframe rejects that pymavlink accepts (or
  the other way round) that the differential tests do not explain.
- **Fuzz for longer** and send any crash input for `fuzz/regressions/`.

## Setting up

You need CMake 3.16 or later, a C99 compiler and Python 3.

```sh
cmake -S . -B build -DMAVFRAME_WERROR=ON && cmake --build build
./build/test_mavframe
pip install -r requirements-dev.txt
python3 -m pytest tests -v
```

The browser inspector needs Node.js 22, zig from PyPI and Playwright:

```sh
pip install ziglang==0.17.1
sh tools/build_wasm.sh
node --test tests/web/test_wasm.mjs
npm install --no-save --no-package-lock playwright@1.63.0 axe-core@4.14.0
npx playwright install chromium
node --test tests/web/test_ui.mjs
```

## Before you open a pull request

- Build with `-DMAVFRAME_WERROR=ON`; CI does.
- Keep the parser free of heap allocation and of any dependency beyond the C
  standard headers it already uses.
- If you change `src/mavframe.c` or `web/wasm/`, rebuild `docs/mavframe.wasm`
  with zig 0.17.1 and commit it; CI fails when it differs from a fresh build.
- If you change the generators, commit their output: `src/mavframe_crc_extra_common.h`
  (`tools/gen_crc_extra.py`), `docs/js/msgdefs.js` (`tools/gen_web_defs.py`), and
  `docs/sample/` plus `tests/web/sample-truth.json` (`tools/gen_sample_tlog.py`).
- A new behaviour needs a test that fails without it.
- If you change the version, change it in `include/mavframe.h`, `CMakeLists.txt`
  and `CHANGELOG.md`; `tests/test_version.py` checks all three.
- Numbers in the README must come from a command shown next to them.

## Reporting a problem

Open an issue. Say what you ran, what you expected and what happened. For
security problems see [SECURITY.md](SECURITY.md).
