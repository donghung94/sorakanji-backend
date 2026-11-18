#!/usr/bin/env python3
"""List sv_lessons docs in Firestore (project donghung-3208d) via REST API.
Exchanges the firebase-tools CLI refresh token for an access token.
Prints ONLY doc IDs and lesson line start-times — never any credential value.
Usage: python3 list_lessons.py [videoId-to-inspect]"""
import json, sys, urllib.request, urllib.parse

STORE = "/home/hatch/.config/configstore/firebase-tools.json"
CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com"
CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi"
PROJECT = "donghung-3208d"

def get_token():
    d = json.load(open(STORE))
    rt = d["tokens"]["refresh_token"]
    body = urllib.parse.urlencode({
        "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
        "refresh_token": rt, "grant_type": "refresh_token"}).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body)
    return json.load(urllib.request.urlopen(req, timeout=30))["access_token"]

def fs_get(tok, path):
    url = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    return json.load(urllib.request.urlopen(req, timeout=30))

tok = get_token()
docs = fs_get(tok, "sv_lessons?pageSize=50")
print("=== sv_lessons docs ===")
for doc in docs.get("documents", []):
    name = doc["name"].split("/")[-1]
    f = doc.get("fields", {})
    n = f.get("lines", {}).get("arrayValue", {}).get("values", [])
    dur = f.get("durationSec", {}).get("doubleValue", f.get("durationSec", {}).get("integerValue", "?"))
    print(f"{name}: {len(n)} lines, dur={dur}")

vid = sys.argv[1] if len(sys.argv) > 1 else None
if vid:
    doc = fs_get(tok, f"sv_lessons/{vid}")
    lines = doc["fields"]["lines"]["arrayValue"]["values"]
    print(f"=== {vid}: start times ===")
    starts = []
    for lv in lines:
        lf = lv["mapValue"]["fields"]
        st = lf.get("start", {}).get("doubleValue", lf.get("start", {}).get("integerValue", "MISSING"))
        en = lf.get("end", {}).get("doubleValue", lf.get("end", {}).get("integerValue", "MISSING"))
        starts.append((st, en))
    for i, (s, e) in enumerate(starts):
        print(f"  line {i}: start={s} end={e}")
    print("all starts zero:", all(s == 0 or s == "0" for s, _ in starts))
