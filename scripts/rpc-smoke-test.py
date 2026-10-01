import json, subprocess, time, os, sys

log = "/tmp/pi-clear-rpc-out.log"
if os.path.exists(log): os.remove(log)

proc = subprocess.Popen(
    ["pi", "-e", "./index.ts", "--mode", "rpc", "--no-session", "-ne"],
    cwd=os.path.expanduser("~/play/gadenbuie/pi-clear"),
    stdin=subprocess.PIPE, stdout=open(log, "w"), stderr=subprocess.STDOUT,
    text=True, bufsize=1)

def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n"); proc.stdin.flush()

def wait_response(rid, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            for line in open(log):
                line = line.strip()
                if not line: continue
                try: obj = json.loads(line)
                except: continue
                if obj.get("type") == "response" and obj.get("id") == rid:
                    return obj
        except FileNotFoundError:
            pass
        time.sleep(0.3)
    raise TimeoutError(f"no response for {rid}")

def die(msg):
    print("RESULT: FAIL -", msg); proc.terminate(); sys.exit(1)

time.sleep(3)
send({"id": "1", "type": "get_state"})
state0 = wait_response("1")["data"]
print("initial:", state0["model"]["provider"] + "/" + state0["model"]["id"], "thinking:", state0.get("thinkingLevel"))

send({"id": "2", "type": "get_available_models"})
models = wait_response("2")["data"]["models"]
target = next((m for m in models if m["provider"] == "anthropic" and m["id"] != state0["model"]["id"]), None) \
      or next((m for m in models if f'{m["provider"]}/{m["id"]}' != f'{state0["model"]["provider"]}/{state0["model"]["id"]}'), None)
if not target: die("no alternative model found")
print("switching to:", target["provider"] + "/" + target["id"])

send({"id": "3", "type": "set_model", "provider": target["provider"], "modelId": target["id"]})
if not wait_response("3")["success"]: die("set_model failed")
send({"id": "4", "type": "get_state"})
state1 = wait_response("4")["data"]
print("after switch:", state1["model"]["provider"] + "/" + state1["model"]["id"], "thinking:", state1.get("thinkingLevel"))
if (state1["model"]["provider"], state1["model"]["id"]) == (state0["model"]["provider"], state0["model"]["id"]):
    die("model did not actually change before /clear")

send({"id": "5", "type": "set_thinking_level", "level": "high"})
if not wait_response("5")["success"]: die("set_thinking_level failed")

send({"id": "6", "type": "prompt", "message": "/clear"})
if not wait_response("6")["success"]: die("/clear prompt failed")
time.sleep(4)

send({"id": "7", "type": "get_state"})
state2 = wait_response("7")["data"]
print("after /clear:", state2["model"]["provider"] + "/" + state2["model"]["id"], "thinking:", state2.get("thinkingLevel"))

model_ok = (state2["model"]["provider"], state2["model"]["id"]) == (target["provider"], target["id"])
level_ok = state2.get("thinkingLevel") == "high"
if model_ok and level_ok:
    print("RESULT: PASS - model and thinking level preserved across /clear")
else:
    print(f"RESULT: FAIL - model_ok={model_ok} level_ok={level_ok}")
proc.terminate()
