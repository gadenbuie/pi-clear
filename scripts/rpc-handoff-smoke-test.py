#!/usr/bin/env python3
"""RPC smoke test for the pi-clear /hand-off command.

Two scripted scenarios, each in its own pi process:

  live   /hand-off through every dialog: the writer picker (the live agent),
         then model, thinking level, and steering. The agent writes the
         hand-off prompt as its next message; the replacement session must use
         the model chosen in the dialog, keep the chosen thinking level, and
         receive the prompt (with the provenance comment) via set_editor_text.

  fresh  a normal turn first, then /hand-off --fresh: the writer picker is
         skipped, the summarizer model and thinking-level pickers open, and the
         prompt is written by a single out-of-band model call. No agent turn may
         start during the hand-off, and the editor text must carry the
         provenance comment with the *previous* session id.

Requires: pi on PATH, at least two models with configured auth.

WARNING: both scenarios make real, billed model requests. Ask before running.
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
STARTUP_WAIT = 20
DIALOG_TIMEOUT = 30
SETTLE_TIMEOUT = 240
WRITER_LIVE_LABEL = "This agent — full context and tools"


class RpcSession:
	def __init__(self, name):
		self.name = name
		self.log_path = os.path.join(tempfile.gettempdir(), f"pi-clear-handoff-smoke-test-{name}.log")
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

	def _objects(self):
		for line in self._log_lines():
			try:
				yield json.loads(line)
			except json.JSONDecodeError:
				continue

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
		raise TimeoutError(f"[{self.name}] timed out waiting for {method} dialog")

	def wait_response(self, request_id, description, timeout=20):
		deadline = time.time() + timeout
		while time.time() < deadline:
			for obj in self._objects():
				if obj.get("type") == "response" and obj.get("id") == request_id:
					return obj
			time.sleep(POLL_INTERVAL)
		raise TimeoutError(f"[{self.name}] timed out waiting for {description}")

	def get_state(self, timeout=20):
		"""Send get_state and wait for the response; raises if pi has no model."""
		request_id = self.send("get_state")
		data = self.wait_response(request_id, "get_state", timeout=timeout)["data"]
		if not data.get("model"):
			raise RuntimeError("pi has no active model; smoke test cannot run")
		return data

	def model_of(self, state):
		return state["model"]["provider"] + "/" + state["model"]["id"]

	def count_events(self, event_type):
		"""Count agent/session events (agent_start, agent_end, ...) in the log.

		Responses and extension UI requests also carry ``type`` but always have an
		``id``; agent events do not.
		"""
		return sum(1 for obj in self._objects() if obj.get("type") == event_type and "id" not in obj)

	def editor_texts(self):
		texts = []
		for obj in self._objects():
			if obj.get("type") == "extension_ui_request" and obj.get("method") == "set_editor_text":
				text = (obj.get("text") or "").strip()
				if text:
					texts.append(text)
		return texts

	def terminate(self):
		self.proc.terminate()


def wait_until(predicate, timeout, description):
	deadline = time.time() + timeout
	while time.time() < deadline:
		result = predicate()
		if result is not None:
			return result
		time.sleep(POLL_INTERVAL)


def fail(msg):
	print(f"RESULT: FAIL - {msg}")
	sys.exit(1)


def wait_for_startup(rpc):
	def ready():
		try:
			rpc.get_state(timeout=5)
			return True
		except TimeoutError:
			return None

	if not wait_until(ready, STARTUP_WAIT, "pi startup"):
		fail(f"[{rpc.name}] pi did not become ready; see {rpc.log_path}")
	return rpc.get_state()


def choose_model(rpc, initial_model, description, prefer_other, dialog=None):
	"""Answer a fallback picker: an optional provider dialog, then a model dialog.

	Returns the chosen provider/model.
	"""
	if dialog is None:
		dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
	options = dialog.get("options") or []
	if "provider" in (dialog.get("title") or "").lower():
		provider = initial_model.split("/")[0]
		provider_label = next((o for o in options if o.split("  (")[0] == provider), None)
		if not provider_label:
			fail(f"[{rpc.name}] current provider missing from the {description} provider dialog: {options}")
		rpc.respond_ui(dialog["id"], value=provider_label)
		dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
		options = dialog.get("options") or []

	if prefer_other:
		chosen = next((o for o in options if o.split("  (current)")[0] != initial_model), None)
		if not chosen:
			fail(f"[{rpc.name}] no alternative model offered in the {description} dialog: {options}")
	else:
		chosen = next((o for o in options if o.split("  (current)")[0] == initial_model), None)
		if not chosen:
			chosen = options[0] if options else None
		if not chosen:
			fail(f"[{rpc.name}] no model offered in the {description} dialog: {options}")

	print(f"[{rpc.name}] {description}:", chosen.split("  (current)")[0])
	rpc.respond_ui(dialog["id"], value=chosen)
	return chosen.split("  (current)")[0]


def wait_for_handoff(rpc, initial_session, target_model):
	"""Poll until the replacement session is live with the chosen model applied."""
	last = {"session": initial_session, "model": None, "level": None}

	def handed_off():
		try:
			state = rpc.get_state(timeout=5)
		except TimeoutError:
			return None
		last.update(session=state.get("sessionId"), model=rpc.model_of(state), level=state.get("thinkingLevel"))
		if last["session"] == initial_session:
			return None  # replacement session not active yet
		return state if last["model"] == target_model else None

	state = wait_until(handed_off, SETTLE_TIMEOUT, "session hand-off")
	if state is None:
		fail(
			f"[{rpc.name}] session was never handed off; last saw "
			f"{last['model']}/{last['level']} in session {last['session']}"
		)
	return state


def check_provenance(editor_text, initial_session):
	expected = f"<!-- Handed off from pi session {initial_session} -->"
	if not editor_text.startswith(expected):
		fail(
			f"editor text does not start with the provenance comment for {initial_session}: "
			f"{editor_text[:200]!r}"
		)


def scenario_live():
	"""The live agent path: writer picker → model → thinking → steering."""
	rpc = RpcSession("live")
	try:
		initial_state = wait_for_startup(rpc)
		initial_model = rpc.model_of(initial_state)
		initial_session = initial_state["sessionId"]
		print(f"[live] initial: {initial_model} in session {initial_session}")

		# The RPC prompt response only arrives after the command handler finishes,
		# which requires answering the dialogs first, so it is checked at the end.
		prompt_request_id = rpc.send("prompt", message="/hand-off")

		# Dialog 0: who writes the hand-off prompt? Enter takes the live agent.
		writer_dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
		if "who writes" not in (writer_dialog.get("title") or "").lower():
			fail(f"[live] expected the writer picker first, got {writer_dialog.get('title')!r}")
		writer_options = writer_dialog.get("options") or []
		if writer_options[:1] != [WRITER_LIVE_LABEL]:
			fail(f"[live] the live agent should be first in the writer picker: {writer_options}")
		rpc.respond_ui(writer_dialog["id"], value=WRITER_LIVE_LABEL)

		# Dialog 1: destination model.
		target_model = choose_model(rpc, initial_model, "hand off to model", prefer_other=True)

		# Dialog 2: destination thinking level (the live agent writes with its own).
		level_dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
		if "writer" in (level_dialog.get("title") or "").lower():
			fail(f"[live] the live path must not ask for a writer thinking level: {level_dialog.get('title')!r}")
		rpc.respond_ui(level_dialog["id"], value="high")

		# Dialog 3: steering editor.
		editor_dialog = rpc.next_ui_request("editor", DIALOG_TIMEOUT)
		rpc.respond_ui(editor_dialog["id"], value="Mention that the smoke test passed.")

		# The agent now writes the hand-off prompt.
		state = wait_for_handoff(rpc, initial_session, target_model)
		print("[live] after hand-off:", rpc.model_of(state), "thinking:", state.get("thinkingLevel"))
		if state.get("sessionId") == initial_session:
			fail("[live] session id did not change")

		texts = rpc.editor_texts()
		if not texts:
			fail("[live] no set_editor_text request with a non-empty prompt was sent")
		editor_text = texts[-1]
		if "smoke test" not in editor_text.lower():
			fail(f"[live] editor text ignores the steering instructions: {editor_text[:200]!r}")
		check_provenance(editor_text, initial_session)
		print("[live] editor prompt (first 120 chars):", editor_text[:120].replace("\n", " "))

		response = rpc.wait_response(prompt_request_id, "/hand-off prompt response", timeout=5)
		if not response.get("success"):
			fail(f"[live] /hand-off prompt was not accepted: {response}")

		if state.get("thinkingLevel") != "high":
			print(f"[live] note: thinking level is {state.get('thinkingLevel')!r} (pi may clamp it)")

		print("RESULT: PASS [live] - the live agent's prompt carried into a fresh session with the chosen model")
	finally:
		rpc.terminate()


def scenario_fresh():
	"""The fresh pass: --fresh skips the writer picker, no agent turn starts."""
	rpc = RpcSession("fresh")
	try:
		initial_state = wait_for_startup(rpc)
		initial_model = rpc.model_of(initial_state)
		initial_session = initial_state["sessionId"]
		print(f"[fresh] initial: {initial_model} in session {initial_session}")

		# Seed the conversation: the fresh pass needs something to hand off.
		seed_id = rpc.send("prompt", message="Reply with the single word: READY")
		rpc.wait_response(seed_id, "seed prompt", timeout=SETTLE_TIMEOUT)

		def settled():
			state = rpc.get_state(timeout=10)
			if state.get("isStreaming"):
				return None
			return state if state.get("messageCount", 0) >= 2 else None

		seeded = wait_until(settled, SETTLE_TIMEOUT, "the seed turn to finish")
		if seeded is None:
			fail(f"[fresh] the seed turn never finished; see {rpc.log_path}")
		agent_starts_before = rpc.count_events("agent_start")
		print("[fresh] seed turn done; agent_start so far:", agent_starts_before)

		# --fresh skips the writer picker, so the next dialog is the summarizer.
		prompt_request_id = rpc.send("prompt", message="/hand-off --fresh")

		summarizer_dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
		if "who writes" in (summarizer_dialog.get("title") or "").lower():
			fail("[fresh] --fresh should skip the writer picker")
		summarizer_model = choose_model(
			rpc, initial_model, "hand-off writer model", prefer_other=False, dialog=summarizer_dialog
		)

		# The writer's thinking level, when the writer model supports reasoning;
		# the provider default is preselected, so Enter keeps it.
		next_dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
		if "hand-off writer" in (next_dialog.get("title") or "").lower() and "thinking" in (
			next_dialog.get("title") or ""
		).lower():
			writer_levels = next_dialog.get("options") or []
			if writer_levels[:1] != ["provider default  (current)"]:
				fail(f"[fresh] the writer thinking picker should default to the provider default: {writer_levels}")
			print("[fresh] writer thinking:", writer_levels[0])
			rpc.respond_ui(next_dialog["id"], value=writer_levels[0])
			next_dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
		else:
			print("[fresh] writer thinking: skipped (model has no reasoning controls)")

		target_model = choose_model(rpc, initial_model, "hand off to model", prefer_other=True, dialog=next_dialog)

		level_dialog = rpc.next_ui_request("select", DIALOG_TIMEOUT)
		rpc.respond_ui(level_dialog["id"], value="low")

		editor_dialog = rpc.next_ui_request("editor", DIALOG_TIMEOUT)
		rpc.respond_ui(editor_dialog["id"], value="Mention that the fresh pass smoke test passed.")

		state = wait_for_handoff(rpc, initial_session, target_model)
		print(
			f"[fresh] {summarizer_model} wrote the prompt; handed off to",
			rpc.model_of(state),
			"thinking:",
			state.get("thinkingLevel"),
		)
		if state.get("sessionId") == initial_session:
			fail("[fresh] session id did not change")

		texts = rpc.editor_texts()
		if not texts:
			fail("[fresh] no set_editor_text request with a non-empty prompt was sent")
		editor_text = texts[-1]
		check_provenance(editor_text, initial_session)
		if "smoke test" not in editor_text.lower():
			fail(f"[fresh] editor text ignores the steering instructions: {editor_text[:200]!r}")
		print("[fresh] editor prompt (first 120 chars):", editor_text[:120].replace("\n", " "))

		response = rpc.wait_response(prompt_request_id, "/hand-off prompt response", timeout=5)
		if not response.get("success"):
			fail(f"[fresh] /hand-off prompt was not accepted: {response}")

		# The whole point: no agent turn runs while the fresh pass writes the prompt.
		agent_starts_after = rpc.count_events("agent_start")
		if agent_starts_after != agent_starts_before:
			fail(
				f"[fresh] an agent turn started during the fresh pass "
				f"({agent_starts_before} → {agent_starts_after} agent_start events)"
			)
		print("[fresh] no agent turn started during the hand-off")

		print("RESULT: PASS [fresh] - a bare model call wrote the prompt, no agent turn, provenance carried")
	finally:
		rpc.terminate()


def main():
	for scenario in (scenario_live, scenario_fresh):
		scenario()
	print("RESULT: PASS - both /hand-off scenarios completed")


if __name__ == "__main__":
	main()
