#!/usr/bin/env python3
"""Fetch the checksum-pinned MAVLink common/ArduPilot dialect include graph.

Run when changing the source pin (network required):
    python3 tools/fetch_mavlink_xml.py

The generators consume the committed XML offline and cross-check definitions
against pymavlink 2.4.50.
"""
import hashlib
import importlib.util
import os
import ssl
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
from contextlib import redirect_stdout

COMMIT = "12c898d88ce18d24e8caf6338596e98c5005bc97"
PYMAVLINK_VERSION = "2.4.50"
BASE = "https://raw.githubusercontent.com/mavlink/mavlink/%s/message_definitions/v1.0/" % COMMIT
PINS = {
    "ardupilotmega.xml": "8cff0bf2ae5bec60d16118bf37e1ec6e9f55f54aecc486df0b18f89977479047",
    "common.xml": "a4ac8a1144529195af6f948e5b4429bae0bd7b8650472d0ce09fbc5ca7bde7d6",
    "standard.xml": "0c08a5be4a858910ac02111a51551e0b8fa2088675a5ca0a48dfd7792fa94018",
    "minimal.xml": "7b1e79a1cadedb618042a3f78c09a76ef1f7440df71fa179e647001eeab7475b",
    "uAvionix.xml": "bd9adf101205744270be9b5fc7205d1c73e365a619435fffc2623958069da516",
    "icarous.xml": "e40ec11a6d76b48eb815c101c96b1849c76a8ba5302a01d39f1941ff9c501bbb",
    "loweheiser.xml": "31f20f01d436f2fbaaaf86f4a51c60cc01bc42722ae4c5ad403afeaaaa512deb",
    "cubepilot.xml": "b4f76d660b41b16746f67fa8e17321ea6b65448791045154105f29b3a70ce7b9",
    "csAirLink.xml": "f5b5ba62d0b65953438981ca95fc45dceb98d63601dfc0705ad91184227ee24d",
}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mavlink-xml")


def tls_context():
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def fetch(name):
    if name not in PINS:
        sys.exit("unpinned MAVLink include: %s" % name)
    with urllib.request.urlopen(BASE + name, context=tls_context(), timeout=60) as response:
        data = response.read()
    got = hashlib.sha256(data).hexdigest()
    if got != PINS[name]:
        sys.exit("%s: sha256 %s, expected %s" % (name, got, PINS[name]))
    return data


def load_graph():
    """Load and verify the committed dialect graph without network access."""
    pending, seen = ["ardupilotmega.xml"], {}
    while pending:
        name = pending.pop(0)
        if name in seen:
            continue
        path = os.path.join(OUT, name)
        with open(path, "rb") as f:
            data = f.read()
        got = hashlib.sha256(data).hexdigest()
        if got != PINS.get(name):
            raise ValueError("%s: sha256 %s, expected %s" % (name, got, PINS.get(name, "unpinned")))
        root = ET.fromstring(data)
        seen[name] = root
        pending.extend(x.text.strip() for x in root.findall("include") if x.text)
    if set(seen) != set(PINS):
        raise ValueError("MAVLink include graph differs from pin list")
    return seen


def load_pymavlink_dialect():
    """Compile the pinned XML graph with the installed pymavlink generator."""
    import pymavlink
    from pymavlink.generator import mavgen

    if pymavlink.__version__ != PYMAVLINK_VERSION:
        raise ValueError("expected pymavlink %s, got %s" % (PYMAVLINK_VERSION, pymavlink.__version__))
    with tempfile.TemporaryDirectory(prefix="mavframe-pymavlink-") as temp:
        output = os.path.join(temp, "ardupilotmega")
        opts = mavgen.Opts(output, wire_protocol="2.0", language="Python", validate=False)
        with open(os.devnull, "w") as sink, redirect_stdout(sink):
            if not mavgen.mavgen(opts, [os.path.join(OUT, "ardupilotmega.xml")]):
                raise ValueError("pymavlink could not generate the pinned dialect")
        spec = importlib.util.spec_from_file_location("mavframe_pymavlink_dialect", output + ".py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


def main():
    os.makedirs(OUT, exist_ok=True)
    pending, seen = ["ardupilotmega.xml"], set()
    while pending:
        name = pending.pop(0)
        if name in seen:
            continue
        data = fetch(name)
        root = ET.fromstring(data)
        seen.add(name)
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        pending.extend(x.text.strip() for x in root.findall("include") if x.text)
    if seen != set(PINS):
        sys.exit("include graph differs from pin list: missing %s" % ", ".join(sorted(set(PINS) - seen)))
    with open(os.path.join(OUT, "SHA256SUMS"), "w", encoding="ascii") as f:
        for name in sorted(PINS):
            f.write("%s  %s\n" % (PINS[name], name))
    print("fetched %d pinned MAVLink XML files at %s" % (len(seen), COMMIT))


if __name__ == "__main__":
    main()
