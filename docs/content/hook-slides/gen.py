import json, os, sys, base64, urllib.request
name, prompt, out = sys.argv[1], sys.argv[2], sys.argv[3]
body = json.dumps({"model": "gpt-image-2", "prompt": prompt, "size": "1024x1536", "quality": "high", "n": 1}).encode()
req = urllib.request.Request("https://api.openai.com/v1/images/generations", data=body,
    headers={"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"], "Content-Type": "application/json"})
try:
    r = json.load(urllib.request.urlopen(req, timeout=300))
except urllib.error.HTTPError as e:
    print(name, "ERR", e.code, e.read().decode()[:500]); sys.exit(1)
open(out, "wb").write(base64.b64decode(r["data"][0]["b64_json"]))
print(name, "OK", out)
