#!/usr/bin/env python3
"""RPC smoke test for the pi-clear extension.

Starts pi in RPC mode with this extension loaded, switches to a different
model and thinking level, runs /clear, and asserts that the new session
kept both.

Requires: pi on PATH, at least two models with configured auth.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
POLL_INTERVAL = 0.3
STARTUP_WAIT = 15
SETTLE_TIMEOUT = 30


class RpcSession:
	def __init__(self):
		self.log_path = os.path.join(tempfile.gettempdir(), "pi-clear-smoke-test.log")
		if os.path.exists(self.log_path):
			os.remove(self.log_path)
		self.proc = subprocess.Popen(
			["pi", "-e", str(REPO_ROOT / "index.ts"), "--mode", "rpc", "--no-session", "-ne"],
			cwd=REPO_ROOT,
			stdin=subprocess.PIPE,
			stdout=open(self.log_path, "w"),
			stderr=subprocess.STDOUT,
			text=True,
			bufsize=1,
		)
		self.next_id = 0

	def send(self, command, **fields):
		self.next_id += 1
		request_id = str(self.next_id)
		payload = {"id": request_id, "type": command, **fields}
		self.proc.stdin.write(json.dumps(payload) + "\n")
		self.proc.stdin.flush()
		return request_id

	def _responses(self, request_id):
		try:
			lines = open(self.log_path).read().splitlines()
		except FileNotFoundError:
			return
		for line in lines:
			line = line.strip()
			if not line:
				continue
			try:
				obj = json.loads(line)
			except json.JSONDecodeError:
				continue
			if obj.get("type") == "response" and obj.get("id") == request_id:
				yield obj

	def response(self, request_id):
		for obj in self._responses(request_id):
			return obj
		return None

	def wait_response(self, request_id, description, timeout=20):
		deadline = time.time() + timeout
		while time.time() < deadline:
			found = self.response(request_id)
			if found:
				return found
			time.sleep(POLL_INTERVAL)
		raise TimeoutError(f"timed out waiting for {description}")

	def get_state(self, timeout=20):
		"""Send get_state and wait for the response.

		Returns (model, thinkingLevel, sessionId); raises if pi has no model.
		"""
		request_id = self.send("get_state")
		data = self.wait_response(request_id, "get_state", timeout=timeout)["data"]
		model = data.get("model")
		if not model:
			raise RuntimeError("pi has no active model; smoke test cannot run")
		return (
			model["provider"] + "/" + model["id"],
			data.get("thinkingLevel"),
			data.get("sessionId"),
		)

	def terminate(self):
		self.proc.terminate()


def wait_until(predicate, timeout, description):
	deadline = time.time() + timeout
	while time.time() < deadline:
		result = predicate()
		if result is not None:
			return result
		time.sleep(POLL_INTERVAL)
	raise TimeoutError(f"timed out waiting for {description}")


def main():
	rpc = RpcSession()

	def fail(msg):
		print(f"RESULT: FAIL - {msg}")
		sys.exit(1)

	try:
		# Wait for pi to accept input; first successful get_state means it is ready.
		def ready():
			try:
				rpc.get_state(timeout=5)
				return True
			except TimeoutError:
				return None

		wait_until(ready, STARTUP_WAIT, "pi startup")
		initial_model, _, _ = rpc.get_state()
		print("initial:", initial_model)

		request_id = rpc.send("get_available_models")
		models = rpc.wait_response(request_id, "get_available_models")["data"]["models"]
		target = next(
			(m for m in models if m["provider"] == "anthropic" and f'{m["provider"]}/{m["id"]}' != initial_model),
			None,
		) or next(
			(m for m in models if f'{m["provider"]}/{m["id"]}' != initial_model),
			None,
		)
		if not target:
			fail("no alternative model with configured auth found")
		target_model = target["provider"] + "/" + target["id"]
		print("switching to:", target_model)

		request_id = rpc.send("set_model", provider=target["provider"], modelId=target["id"])
		if not rpc.wait_response(request_id, "set_model")["success"]:
			fail("set_model failed")
		request_id = rpc.send("set_thinking_level", level="high")
		if not rpc.wait_response(request_id, "set_thinking_level")["success"]:
			fail("set_thinking_level failed")

		switched_model, switched_level, _ = rpc.get_state()
		print("before /clear:", switched_model, "thinking:", switched_level)
		if switched_model != target_model:
			fail(f"model did not change before /clear (still {switched_model})")

		_, _, pre_clear_session_id = rpc.get_state()

		request_id = rpc.send("prompt", message="/clear")
		if not rpc.wait_response(request_id, "/clear prompt")["success"]:
			fail("/clear prompt failed")

		# Poll until the replacement session is live (sessionId changed); the
		# prompt response only confirms preflight, not the replacement itself.
		def cleared_state():
			model, level, session_id = rpc.get_state()
			if session_id == pre_clear_session_id:
				return None  # replacement session not active yet; keep polling
			return model, level

		final_model, final_level = wait_until(cleared_state, SETTLE_TIMEOUT, "session replacement")
		print("after /clear:", final_model, "thinking:", final_level)

		if final_model != target_model or final_level != "high":
			fail(f"expected {target_model}/high, got {final_model}/{final_level}")

		print("RESULT: PASS - model and thinking level preserved across /clear")
	finally:
		rpc.terminate()


if __name__ == "__main__":
	main()
