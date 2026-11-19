#!/usr/bin/env python3
"""Replaces the Tauri-generated "Build Rust Code" phase with a direct cargo build.

Usage: python3 scripts/patch-ios-pbxproj.py [lib_name]
"""
import glob
import re
import sys

LIB_NAME = sys.argv[1] if len(sys.argv) > 1 else "libapp.a"
CRATE_LIB = "libhghubx_lib.a"
TARGET = "aarch64-apple-ios"

projects = glob.glob("src-tauri/gen/apple/*.xcodeproj/project.pbxproj")
if not projects:
    sys.exit("Project file not found: src-tauri/gen/apple/*.xcodeproj/project.pbxproj")
path = projects[0]

DQ = '\\"'
script = (
    "cd " + DQ + "$SRCROOT/../.." + DQ + " && "
    "cargo build --target " + TARGET + " --release --lib && "
    "mkdir -p " + DQ + "$SRCROOT/Externals/arm64/$CONFIGURATION" + DQ + " && "
    "cp target/" + TARGET + "/release/" + CRATE_LIB + " "
    + DQ + "$SRCROOT/Externals/arm64/$CONFIGURATION/" + LIB_NAME + DQ
)

src = open(path, encoding="utf-8").read()

pat = re.compile(r'shellScript = "((?:[^"\\]|\\.)*)";')
hits = []


def repl(m):
    body = m.group(1)
    if "xcode-script" not in body:
        return m.group(0)
    hits.append(body[:60])
    return 'shellScript = "' + script + '";'


new = pat.sub(repl, src)

if len(hits) != 1:
    for m in pat.finditer(src):
        print("Existing script:", m.group(1)[:100])
    sys.exit("Found %d xcode-script matches; expected 1" % len(hits))

open(path, "w", encoding="utf-8").write(new)
print("Replaced Build Rust Code script ->", path)
print("Original script prefix:", hits[0])
print("New script:", script)
