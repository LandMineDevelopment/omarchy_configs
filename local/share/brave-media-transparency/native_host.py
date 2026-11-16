#!/usr/bin/python3
"""Fail-closed local bridge between a media-mask extension and HyprWindowShade.

No network, profile writes, shell commands, or page-content logging. A snapshot
can authorize only one unambiguously identified, mapped Brave window.
The compositor owns mask expiration; this process clears masks on EOF or errors.
"""
import json
from contextlib import nullcontext
import math
import re
import secrets
import struct
import subprocess
import sys
import time
from urllib.parse import urlsplit
from theme_palette import ThemePaletteCache

MAX_FRAME = 65536
MAX_RECTS = 128
MAX_CSV = 8192
ADDRESS = re.compile(r"0x[0-9a-fA-F]{1,16}\Z")
STABLE_ID = re.compile(r"[0-9a-fA-F]{1,16}\Z")


class InvalidMessage(ValueError):
    pass


class DisabledError(RuntimeError):
    pass


class PhysicalIdentityError(RuntimeError):
    pass


def read_exact(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        part = stream.read(size - len(chunks))
        if not part:
            if not chunks:
                return None
            raise InvalidMessage("truncated frame")
        chunks.extend(part)
    return bytes(chunks)


def read_message(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    length = struct.unpack("<I", header)[0]
    if not 0 < length <= MAX_FRAME:
        raise InvalidMessage("invalid frame length")
    payload = read_exact(stream, length)
    if payload is None:
        raise InvalidMessage("truncated frame")
    try:
        result = json.loads(payload.decode("utf-8"))
    except (UnicodeError, ValueError):
        raise InvalidMessage("invalid JSON") from None
    if not isinstance(result, dict):
        raise InvalidMessage("message must be an object")
    return result


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def valid_window_id(value):
    return type(value) is int and 0 < value <= 2147483647


def validate_snapshot(message):
    expected = {"type", "title", "focused", "outerWidth", "outerHeight", "rects", "capturedAt", "deviceScale", "windowId"}
    if set(message) != expected or message["type"] != "snapshot":
        raise InvalidMessage("invalid snapshot schema")
    if not number(message["capturedAt"]):
        raise InvalidMessage("invalid sampling time")
    if not number(message["deviceScale"]) or not 0.25 <= message["deviceScale"] <= 8:
        raise InvalidMessage("invalid browser device scale")
    title = message["title"]
    if not isinstance(title, str) or not title or len(title.encode("utf-8")) > 2048:
        raise InvalidMessage("invalid title")
    if any(ord(char) < 32 for char in title):
        raise InvalidMessage("invalid title")
    if not valid_window_id(message["windowId"]):
        raise InvalidMessage("invalid browser window identity")
    if type(message["focused"]) is not bool:
        raise InvalidMessage("invalid focus state")
    for key in ("outerWidth", "outerHeight"):
        if type(message[key]) is not int or not 32 <= message[key] <= 16384:
            raise InvalidMessage("invalid dimensions")
    rects = message["rects"]
    if not isinstance(rects, list) or len(rects) > MAX_RECTS:
        raise InvalidMessage("invalid rectangles")
    formatted = []
    for rect in rects:
        if not isinstance(rect, list) or len(rect) != 4:
            raise InvalidMessage("invalid rectangle")
        if any(not number(value) or not 0 <= value <= 1 for value in rect):
            raise InvalidMessage("invalid rectangle coordinates")
        x, y, width, height = rect
        if width <= 0 or height <= 0 or x + width > 1.000001 or y + height > 1.000001:
            raise InvalidMessage("invalid rectangle bounds")
        formatted.extend(format(float(value), ".7f") for value in rect)
    csv = ",".join(formatted)
    if len(csv) > MAX_CSV:
        raise InvalidMessage("too many rectangle coordinates")
    return csv


def validate_native_ui(message):
    expected = {"type", "url", "title", "focused", "outerWidth", "outerHeight", "capturedAt", "windowId"}
    if set(message) != expected or message["type"] != "native-ui":
        raise InvalidMessage("invalid native UI schema")
    value = message["url"]
    if not isinstance(value, str) or len(value) > 4096 or any(ord(char) < 32 for char in value):
        raise InvalidMessage("invalid native UI URL")
    try:
        url = urlsplit(value)
        allowed = url.scheme in ("chrome", "brave") and url.netloc in (
            "settings", "extensions", "flags", "history", "downloads", "bookmarks")
    except ValueError:
        allowed = False
    if not allowed:
        raise InvalidMessage("unsupported native UI URL")
    # Reuse all common timestamp, window, title and bound checks. No page can
    # supply media rectangles or scale through this browser-metadata policy.
    normalized = dict(message)
    normalized.pop("url")
    normalized.update(type="snapshot", deviceScale=1, rects=[])
    return validate_snapshot(normalized)


def lua_bytes(value):
    """Encode UTF-8 with fixed-width Lua decimal escapes, never source text."""
    return chr(34) + "".join("\\" + format(byte, "03d") for byte in value.encode("utf-8")) + chr(34)


def default_runner(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=0.4).stdout


class Bridge:
    def __init__(self, runner=default_runner, clock=time.time, configure=None, enabled=None):
        self.runner = runner
        self.clock = clock
        self.last_capture = {}
        self.associations = {}
        self.identities = {}
        self.retired_windows = set()
        self.ownership_state = None
        self.ownership_token = secrets.token_hex(16)
        self.ownership_guard = None
        if configure is None or enabled is None:
            import control
            if configure is None:
                def configure_current_session(value):
                    state = control.configure(value, owner=self.ownership_token,
                                              state=self.ownership_state)
                    # Session lookup and the exact-version guard belong to the
                    # configure handshake, not to every scroll-frame update.
                    self.ownership_state = state if value else None
                configure = configure_current_session
                self.ownership_guard = lambda: control.owned_session(self.ownership_state, self.ownership_token)
            if enabled is None:
                def current_port_enabled():
                    with control.owned_session(self.ownership_state, self.ownership_token) as current:
                        return current
                enabled = current_port_enabled
        self.configure_plugin = configure
        self.plugin_enabled = enabled
        self.configured = False
        self.theme_palette = ThemePaletteCache()
        self.applied_palette = None

    def evaluate(self, expression, stale_ok=False):
        guard = self.ownership_guard() if self.ownership_guard is not None else nullcontext(True)
        with guard as current:
            if not current:
                if stale_ok:
                    return False
                raise DisabledError('disabled')
            output = self.runner(["hyprctl", "eval", expression])
        # hyprctl can report Lua errors while returning a successful exit status.
        if output.strip() == "media window identity changed":
            raise PhysicalIdentityError("physical browser window changed")
        if output.strip() != "ok":
            raise RuntimeError("compositor rejected request")

    def palette(self):
        palette = self.theme_palette.get()
        color = palette['background'].lstrip('#')
        components = tuple(int(color[index:index + 2], 16) / 255 for index in (0, 2, 4))
        canvas = (*components, palette['opacity'])
        if self.configured and canvas != self.applied_palette:
            values = ','.join(format(value, '.9g') for value in canvas)
            self.evaluate(f'hl.plugin.HyprWindowShade.mediapalette({values})')
            self.applied_palette = canvas
        return palette

    def reset(self, window_id=None, forget_identity=False):
        if window_id is None:
            self.associations.clear()
            self.last_capture.clear()
            self.identities.clear()
            self.retired_windows.clear()
            self.evaluate('hl.plugin.HyprWindowShade.mediareset("all")', stale_ok=True)
        else:
            association = self.associations.pop(window_id, None)
            self.last_capture.pop(window_id, None)
            if forget_identity:
                self.identities.pop(window_id, None)
                self.retired_windows.discard(window_id)
            if association is not None:
                self.evaluate(f'hl.plugin.HyprWindowShade.mediareset("{association[1][0]}")', stale_ok=True)

    def dimensions(self, window, snapshot, monitors):
        monitor_id = window.get('monitor')
        if type(monitor_id) is not int or not isinstance(monitors, list):
            raise InvalidMessage('unknown monitor scale')
        candidates = [monitor for monitor in monitors if isinstance(monitor, dict)
                      and monitor.get('id') == monitor_id]
        if len(candidates) != 1:
            raise InvalidMessage('unknown monitor scale')
        scale = candidates[0].get('scale')
        if not number(scale) or not 0.25 <= scale <= 8:
            raise InvalidMessage('invalid monitor scale')
        if snapshot['type'] == 'native-ui':
            size = window.get('size')
            if not isinstance(size, list) or len(size) != 2 or any(not number(value) or value <= 0 for value in size):
                raise InvalidMessage('invalid native surface dimensions')
            # Chrome bounds are device-independent and can use a fractional
            # browser scale. Infer its uniform conversion from the actual
            # native surface, then require both axes to agree. Monitor scale
            # bounds the inferred device scale; no DOM DPR is injected/read.
            factor = size[0] / snapshot['outerWidth']
            if not 0.25 <= factor * scale <= 8 or abs(snapshot['outerHeight'] * factor - size[1]) > 2:
                raise InvalidMessage('native UI bounds disagree with surface')
        else:
            factor = snapshot['deviceScale'] / scale
        dimensions = [round(snapshot[key] * factor) for key in ('outerWidth', 'outerHeight')]
        if any(not 32 <= dimension <= 16384 for dimension in dimensions):
            raise InvalidMessage('invalid scaled dimensions')
        return dimensions

    def matching(self, window, snapshot, monitors):
        if not isinstance(window, dict) or window.get("class") != "brave-browser":
            return False
        if not window.get("mapped") or window.get("hidden") or window.get("xwayland") or window.get("visible") is False:
            return False
        if window.get("title") not in (snapshot["title"], snapshot["title"] + " - Brave"):
            return False
        try:
            width, height = self.dimensions(window, snapshot, monitors)
        except InvalidMessage:
            return False
        size = window.get("size")
        return (isinstance(size, list) and len(size) == 2
                and all(number(value) for value in size)
                and abs(size[0] - width) <= 2
                and abs(size[1] - height) <= 2)

    @staticmethod
    def stable_id(window):
        value = window.get("stableId")
        if value is None:
            return None
        if not isinstance(value, str) or not STABLE_ID.fullmatch(value) or int(value, 16) == 0:
            raise InvalidMessage("invalid stable compositor identity")
        return format(int(value, 16), "x")

    def identify(self, snapshot):
        window_id = snapshot['windowId']
        if window_id in self.retired_windows:
            raise InvalidMessage("physical browser window no longer exists")
        monitors = json.loads(self.runner(["hyprctl", "-j", "monitors"]))
        clients = json.loads(self.runner(["hyprctl", "-j", "clients"]))
        if not isinstance(clients, list):
            raise InvalidMessage("invalid compositor clients")
        identity = self.identities.get(window_id)
        if identity is not None:
            stable_id, address = identity
            owners = [client for client in clients if isinstance(client, dict) and client.get('address') == address]
            if len(owners) != 1 or self.stable_id(owners[0]) != stable_id:
                self.identities.pop(window_id, None)
                self.retired_windows.add(window_id)
                raise InvalidMessage("physical browser window no longer exists")
            window = owners[0]
            if not self.matching(window, snapshot, monitors):
                raise InvalidMessage("bound browser window page or geometry changed")
        else:
            matches = [client for client in clients if self.matching(client, snapshot, monitors)]
            if len(matches) == 1:
                window = matches[0]
            elif len(matches) > 1 and snapshot['focused']:
                # Only initial ambiguity needs a focus query. A browser's focus
                # flag alone never authorizes selecting a compositor window.
                active = json.loads(self.runner(["hyprctl", "-j", "activewindow"]))
                candidates = [client for client in matches if isinstance(active, dict) and client.get('address') == active.get('address')]
                if len(candidates) != 1 or not self.matching(active, snapshot, monitors):
                    raise InvalidMessage("no unambiguous active browser window")
                window = candidates[0]
            else:
                raise InvalidMessage("no unambiguous browser window")
            stable_id = self.stable_id(window)
        address = window.get("address", "")
        if not isinstance(address, str) or not ADDRESS.fullmatch(address):
            raise InvalidMessage("invalid compositor address")
        # The native publish revalidates class/visibility/title/dimensions and
        # stable identity on every update, including the steady one-eval path.
        return address, window["title"], self.dimensions(window, snapshot, monitors), stable_id

    def fresh(self, message):
        captured = message["capturedAt"]
        age = self.clock() * 1000 - captured
        if not -50 <= age <= 250 or captured < self.last_capture.get(message["windowId"], 0):
            raise InvalidMessage("stale media snapshot")

    def handle(self, message):
        if set(message) == {'type', 'enabled'} and message['type'] == 'configure':
            if type(message['enabled']) is not bool:
                raise InvalidMessage('invalid configure setting')
            self.associations.clear()
            self.last_capture.clear()
            self.identities.clear()
            self.retired_windows.clear()
            self.configured = False
            self.applied_palette = None
            self.configure_plugin(message['enabled'])
            self.configured = message['enabled']
            return True
        try:
            active = self.configured and self.plugin_enabled()
        except Exception:
            self.associations.clear()
            self.last_capture.clear()
            self.identities.clear()
            self.retired_windows.clear()
            self.configured = False
            raise
        if not active:
            self.associations.clear()
            self.last_capture.clear()
            self.identities.clear()
            self.retired_windows.clear()
            self.configured = False
            raise DisabledError('disabled')
        if (message.get("type") == "invalidate" and set(message) <= {"type", "reason", "windowId"}
                and ("reason" not in message or isinstance(message["reason"], str)
                     and len(message["reason"]) <= 128)):
            window_id = message.get("windowId")
            if "windowId" in message and not valid_window_id(window_id):
                raise InvalidMessage("invalid browser window identity")
            self.reset(window_id, forget_identity=message.get("reason") == "window-closed")
            return False
        window_id = message.get("windowId")
        window_id = window_id if valid_window_id(window_id) else None
        try:
            native_ui = message.get('type') == 'native-ui'
            csv = validate_native_ui(message) if native_ui else validate_snapshot(message)
            if window_id not in self.associations and window_id not in self.identities and len(set(self.associations) | set(self.identities) | self.retired_windows) >= 128:
                raise InvalidMessage("too many browser windows")
            self.fresh(message)
            metadata = (message['type'], message.get('url'), message['title'], message['outerWidth'], message['outerHeight'], message.get('deviceScale'))
            # The compositor validates actual visibility/title/surface dimensions on
            # every publish. Retain only the established target mapping while
            # browser metadata is unchanged; rejected publishes revoke it.
            association = self.associations.get(window_id)
            target = (association[1] if association is not None
                      and association[0] == metadata else self.identify(message))
            address, title, (width, height), stable_id = target
            if native_ui and stable_id is None:
                raise InvalidMessage('native UI requires stable physical window identity')
            # A native window belongs to only one Chrome channel. In particular,
            # a hidden browser window's delayed title/size snapshot must never
            # borrow another window's live mask owner.
            if any(owner != window_id and binding[1][0] == address
                   for owner, binding in self.associations.items()) or any(
                       owner != window_id and identity[1] == address for owner, identity in self.identities.items()):
                raise InvalidMessage("browser window already belongs to another channel")
            self.fresh(message)
            if association is not None and association[1][0] != address:
                self.reset(window_id)
            guard = f',"{stable_id}"' if stable_id is not None else ''
            expression = ('hl.plugin.HyprWindowShade.mediarects('
                          f'"{address}","{csv}",{width},{height},{lua_bytes(title)}{guard})')
            self.associations[window_id] = (metadata, target)
            self.evaluate(expression)
            if stable_id is not None:
                self.identities[window_id] = (stable_id, address)
            self.last_capture[window_id] = message["capturedAt"]
            return True
        except Exception as exc:
            if isinstance(exc, PhysicalIdentityError) and window_id is not None:
                self.identities.pop(window_id, None)
                self.retired_windows.add(window_id)
            self.reset(window_id)
            raise


def main(input_stream=None, output_stream=None, bridge=None):
    input_stream = input_stream or sys.stdin.buffer
    output_stream = output_stream or sys.stdout.buffer
    bridge = bridge or Bridge()
    try:
        while True:
            message = read_message(input_stream)
            if message is None:
                break
            try:
                accepted = bridge.handle(message)
                reply = {"accepted": accepted}
                if message.get('type') == 'configure':
                    reply['enabled'] = bridge.configured
                if accepted and bridge.configured:
                    reply['palette'] = bridge.palette()
            except DisabledError:
                reply = {'accepted': False, 'enabled': False, 'error': 'disabled'}
            except InvalidMessage as exc:
                reply = {'accepted': False, 'error': str(exc)}
            except (ValueError, RuntimeError, subprocess.SubprocessError, OSError) as exc:
                reply = {'accepted': False, 'error': ('configure-failed' if message.get('type') == 'configure'
                                                    else 'compositor-unavailable')}
                if message.get('type') == 'configure' and isinstance(exc, RuntimeError):
                    text = str(exc)
                    if 'Hyprland ABI mismatch' in text:
                        reply['detail'] = 'Hyprland ABI mismatch; rebuild the plugin against the running Hyprland and dependency versions.'
                    elif 'Hyprland ABI hash unavailable' in text:
                        reply['detail'] = 'Hyprland ABI hash unavailable; plugin initialization was refused.'
                    elif 'updated Hyprland' in text:
                        reply['detail'] = 'Hyprland changed; rebuild the plugin before enabling.'
                    elif 'Another HyprWindowShade' in text:
                        reply['detail'] = 'Another compositor plugin owns this name.'
                    elif 'Hyprland session' in text or 'runtime directory' in text:
                        reply['detail'] = 'No unambiguous current-user Hyprland session is available.'
            response = json.dumps(reply, separators=(",", ":")).encode("utf-8")
            output_stream.write(struct.pack("<I", len(response)) + response)
            output_stream.flush()
    except (InvalidMessage, OSError):
        print("Native bridge stopped: invalid or interrupted input.", file=sys.stderr)
    finally:
        try:
            if bridge.configured:
                bridge.reset()
        except (ValueError, RuntimeError, subprocess.SubprocessError, OSError):
            # Plugin-side expiry still fails closed if IPC is unavailable.
            print("Native bridge could not clear masks; compositor expiry applies.", file=sys.stderr)


if __name__ == "__main__":
    main()
