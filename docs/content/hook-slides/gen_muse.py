# Generate one hook slide via OpenRouter meta/muse-image (same call shape as src/lib/openrouter.ts).
import json, os, sys, base64, urllib.request
name, prompt, out = sys.argv[1], sys.argv[2], sys.argv[3]
base = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
body = json.dumps({"model": "meta/muse-image",
                   "prompt": prompt + "\nCompose the image in 3:4 aspect ratio."}).encode()
req = urllib.request.Request(base + "/images", data=body,
    headers={"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"], "Content-Type": "application/json",
             "X-Title": "slashloop"})
try:
    r = json.load(urllib.request.urlopen(req, timeout=180))
except urllib.error.HTTPError as e:
    print(name, "ERR", e.code, e.read().decode()[:500]); sys.exit(1)
d = r["data"][0]
ext = "png" if "png" in d.get("media_type", "image/jpeg") else "jpg"
path = f"{out}.{ext}"
open(path, "wb").write(base64.b64decode(d["b64_json"]))
print(name, "OK", path, "cost", r.get("usage", {}).get("cost"))
