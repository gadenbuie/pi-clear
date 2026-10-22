#!/usr/bin/env python3
"""RPC smoke test for the pi-clear /hand-off command.

Starts pi in RPC mode with this extension, runs /hand-off, answers the
model / thinking / steering dialogs, waits for the agent to write the
hand-off prompt, and asserts that the replacement session:

  * uses the model chosen in the dialog,
  * kept the chosen thinking level (as reported by get_state),
  * received the hand-off prompt via a set_editor_text request.

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
DIALOG_TIMEOUT = 20
SETTLE_TIMEOUT = 180


class RpcSession:
	def __init__(self):
		self.log_path = os.path.join(tempfile.gettempdir(), "pi-clear-handoff-smoke-test.log")
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
		self.ui_seen = 0  # number of extension_ui_request lines already processed

	def send(self, command, **fields):
		self.next_id += 1
		request_id = str(self.next_id)
		payload = {"id": request_id, "type": command, **fields}
		self.proc.stdin.write(json.dumps(payload) + "\n")
		self.proc.stdin.flush()
		return request_id

	def respond_ui(self, request_id, **fields):
		payload = {"id": request_id, "type": "extension_ui_response", **fields}
		self.proc.stdin.write(json.dumps(payload) + "\n")
		self.proc.stdin.flush()

	def _log_lines(self):
		try:
			with open(self.log_path) as log:
				return log.read().splitlines()
		except FileNotFoundError:
			return []

	def next_ui_request(self, method, timeout):
		"""Wait for the next extension_ui_request with the given method."""
		deadline = time.time() + timeout
		while time.time() < deadline:
			lines = self._log_lines()
			for line in lines[self.ui_seen:]:
				self.ui_seen += 1
				try:
					obj = json.loads(line)
				except json.JSONDecodeError:
					continue
				if obj.get("type") == "extension_ui_request" and obj.get("method") == method:
					return obj
			time.sleep(POLL_INTERVAL)
		raise TimeoutError(f"timed out waiting for {method} dialog")

	def wait_response(self, request_id, description, timeout=20):
		deadline = time.time() + timeout
		while time.time() < deadline:
			for line in self._log_lines():
				try:
					obj = json.loads(line)
				except json.JSONDecodeError:
					continue
				if obj.get("type") == "response" and obj.get("id") == request_id:
					return obj
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
		initial_model, _, initial_session = rpc.get_state()
		print("initial:", initial_model)

		# Run /hand-off. The RPC prompt response only arrives after the command
		# handler finishes, which requires answering the dialogs first, so the
		# response is checked at the end rather than awaited here.
		prompt_request_id = rpc.send("prompt", message="/hand-off")

		# Dialog 1: model select — or provider select first when the session has
		# no model scoping (the RPC fallback shows provider → model).
		model_dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
		options = model_dialog.get("options") or []
		if "provider" in model_dialog.get("title", ""):
			initial_provider = initial_model.split("/")[0]
			provider_label = next(
				(o for o in options if o.split("  (")[0] == initial_provider),
				None,
			)
			if not provider_label:
				fail(f"current provider not offered in the provider dialog: {options}")
			print("provider dialog answered:", provider_label)
			rpc.respond_ui(model_dialog["id"], value=provider_label)
			model_dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
			options = model_dialog.get("options") or []
		target_label = next(
			(o for o in options if o.split("  (current)")[0] != initial_model),
			None,
		)
		if not target_label:
			fail(f"no alternative model offered in the select dialog: {options}")
		target_model = target_label.split("  (current)")[0]
		print("handing off to:", target_model)
		rpc.respond_ui(model_dialog["id"], value=target_label)

		# Dialog 2: thinking level select.
		level_dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
		rpc.respond_ui(level_dialog["id"], value="high")

		# Dialog 3: steering editor.
		editor_dialog = rpc.next_ui_request("editor", DIALOG_TIMEOUT)
		rpc.respond_ui(editor_dialog["id"], value="Mention that the smoke test passed.")

		# The agent now writes the hand-off prompt; wait for the replacement
		# session, then confirm the chosen model and thinking level applied.
		last_state = {"session_id": initial_session, "model": None, "level": None}

		def handed_off():
			try:
				model, level, session_id = rpc.get_state(timeout=5)
			except TimeoutError:
				return None
			except RuntimeError as err:
				fail(f"replacement session has no model: {err}")
			last_state.update(model=model, level=level, session_id=session_id)
			if session_id == initial_session:
				return None  # replacement session not active yet
			if model == target_model:
				return model, level
			return None

		try:
			final_model, final_level = wait_until(handed_off, SETTLE_TIMEOUT, "session hand-off")
		except TimeoutError:
			fail(
				f"session was never handed off; last saw "
				f"{last_state['model']}/{last_state['level']} in session {last_state['session_id']}"
			)
		print("after hand-off:", final_model, "thinking:", final_level)

		# The hand-off prompt should have been inserted into the editor via a
		# fire-and-forget set_editor_text request.
		editor_text = None
		for line in rpc._log_lines():
			try:
				obj = json.loads(line)
			except json.JSONDecodeError:
				continue
			if obj.get("type") == "extension_ui_request" and obj.get("method") == "set_editor_text":
				text = (obj.get("text") or "").strip()
				if text:
					editor_text = text
		if not editor_text:
			fail("no set_editor_text request with a non-empty prompt was sent")
		if "smoke test" not in editor_text.lower():
			fail(f"editor text ignores the steering instructions: {editor_text[:200]!r}")
		print("editor prompt (first 120 chars):", editor_text[:120].replace("\n", " "))

		# The /hand-off prompt response should now have been emitted.
		prompt_response = rpc.wait_response(prompt_request_id, "/hand-off prompt response", timeout=5)
		if not prompt_response.get("success"):
			fail(f"/hand-off prompt was not accepted: {prompt_response}")

		if final_level != "high":
			print(f"note: thinking level is {final_level!r} (pi may clamp it for the target model)")

		print("RESULT: PASS - hand-off prompt carried into a fresh session with the chosen model")
	finally:
		rpc.terminate()


if __name__ == "__main__":
	main()
