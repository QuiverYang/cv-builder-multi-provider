#!/usr/bin/env python3
"""Lightweight ZIP pre-validator: checks for Profile.csv in namelist."""
import json, sys, zipfile

def main():
    if len(sys.argv) < 2:
        json.dump({"ok": False, "reason": "no path given"}, sys.stdout)
        return 1
    path = sys.argv[1]
    try:
        with zipfile.ZipFile(path) as zf:
            names = [n.lower() for n in zf.namelist()]
            has_profile = any(n.endswith('profile.csv') for n in names)
            if has_profile:
                json.dump({"ok": True}, sys.stdout)
            else:
                json.dump({"ok": False, "reason": "Profile.csv not found in ZIP"}, sys.stdout)
    except zipfile.BadZipFile as e:
        json.dump({"ok": False, "reason": f"bad zip: {e}"}, sys.stdout)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
