#!/usr/bin/python3
"""Install and control reversible Brave media-aware transparency."""
import argparse
from contextlib import contextmanager
import json
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parent
PLUGIN = BASE / 'plugin/HyprWindowShade.so'
SHADER = BASE / 'media-backgrounds.frag'
EXTENSION = BASE / 'extension'
FLAGS = Path.home() / '.config/brave-flags.conf'
NATIVE = Path.home() / '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/local.brave_media_transparency.json'
COMMIT = 'efb50993780079460b0cbed1363e2166a2de1d9f'


def extension_flags(text, adding):
    lines = text.splitlines()
    found = False
    result = []
    for line in lines:
        if line.strip().startswith('--load-extension='):
            prefix, paths = line.split('=', 1)
            entries = [entry for entry in paths.split(',') if entry and entry != str(EXTENSION)]
            if adding and not found:
                entries.append(str(EXTENSION))
                found = True
            if entries:
                result.append(prefix + '=' + ','.join(entries))
        else:
            result.append(line)
    if adding and not found:
        result.append('--load-extension=' + str(EXTENSION))
    return '\n'.join(result) + '\n'


def install():
    identifier = (BASE / 'extension-id').read_text().strip()
    manifest = {'name': 'local.brave_media_transparency', 'description': 'Local opt-in media transparency bridge',
                'path': str(BASE / 'native_host.py'), 'type': 'stdio',
                'allowed_origins': ['chrome-extension://' + identifier + '/']}
    if NATIVE.exists() and json.loads(NATIVE.read_text()).get('path') != manifest['path']:
        raise RuntimeError('A different native host uses this name; leaving it alone.')
    text = FLAGS.read_text() if FLAGS.exists() else ''
    updated = extension_flags(text, True)
    if updated != text:
        FLAGS.parent.mkdir(parents=True, exist_ok=True)
        if FLAGS.exists():
            shutil.copy2(FLAGS, FLAGS.with_name(FLAGS.name + '.bak.' + str(time.time_ns())))
        FLAGS.write_text(updated)
    NATIVE.parent.mkdir(parents=True, exist_ok=True)
    NATIVE.write_text(json.dumps(manifest, indent=2) + '\n')


def ctl(*args):
    result = subprocess.run(['hyprctl', *args], text=True, capture_output=True, timeout=15)
    output = result.stdout.strip()
    if result.returncode or (args[0] in ('eval', 'plugin') and output != 'ok'):
        raise RuntimeError(output or result.stderr.strip() or 'hyprctl failed')
    return output


def loaded():
    return any(p['name'] == 'HyprWindowShade' for p in json.loads(ctl('-j', 'plugin', 'list')))


def state_path():
    runtime = Path(os.environ.get('XDG_RUNTIME_DIR', '/run/user/' + str(os.getuid())))
    if not runtime.is_dir() or runtime.stat().st_uid != os.getuid():
        raise RuntimeError('No current-user desktop runtime directory is available.')
    os.environ['XDG_RUNTIME_DIR'] = str(runtime)
    signature = os.environ.get('HYPRLAND_INSTANCE_SIGNATURE', '')
    def available(value):
        return bool(value and '/' not in value and (runtime / 'hypr' / value / '.socket.sock').is_socket())
    explicit_valid = False
    if signature and '/' not in signature:
        try:
            json.loads(ctl('-j', 'version'))
            explicit_valid = True
        except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired):
            pass
    if not explicit_valid:
        instances = json.loads(ctl('-j', 'instances'))
        candidates = [item['instance'] for item in instances
                      if isinstance(item, dict) and available(item.get('instance', ''))
                      and Path('/proc/' + str(item.get('pid', 0))).exists()
                      and Path('/proc/' + str(item.get('pid', 0))).stat().st_uid == os.getuid()]
        if len(candidates) != 1:
            raise RuntimeError('Cannot identify one current-user Hyprland session.')
        signature = candidates[0]
        os.environ['HYPRLAND_INSTANCE_SIGNATURE'] = signature
    root = runtime / 'brave-media-transparency'
    root.mkdir(mode=0o700, exist_ok=True)
    return root / (signature + '.json')


def owns(state, owner=None):
    if not state.exists():
        return False
    value = json.loads(state.read_text())
    if (not isinstance(value, dict) or value.get('plugin') != str(PLUGIN)
            or set(value) not in ({'plugin'}, {'plugin', 'owner'})
            or ('owner' in value and (not isinstance(value['owner'], str)
                                     or len(value['owner']) != 32
                                     or any(char not in '0123456789abcdef' for char in value['owner'])))):
        raise RuntimeError('Compositor ownership state does not match this installation.')
    return owner is None or value.get('owner') == owner


@contextmanager
def session_lock(state):
    # The same lock covers plugin lifetime and native-port mutations. A checked
    # owner cannot lose its lease between validation and a compositor request.
    with state.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


@contextmanager
def owned_session(state, owner):
    if state is None:
        yield False
        return
    with session_lock(state):
        yield owns(state, owner)


def write_state(state, owner=None):
    value = {'plugin': str(PLUGIN)}
    if owner is not None:
        value['owner'] = owner
    temporary = state.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(state)


def configure(enabled, owner=None, state=None):
    state = state or state_path()
    with session_lock(state):
        if enabled:
            turn_on(state)
            if owner is not None and not owns(state, owner):
                # A replacement port takes over all window channels together.
                # Revoke the prior port's masks before acknowledging the claim.
                ctl('eval', 'hl.plugin.HyprWindowShade.mediareset("all")')
                write_state(state, owner)
        elif owner is None or owns(state, owner):
            turn_off(state)
    return state


def is_enabled():
    state = state_path()
    with session_lock(state):
        return owns(state)


def turn_off(state):
    if owns(state) and loaded():
        ctl('eval', 'hl.plugin.HyprWindowShade.mediareset("all")')
        ctl('eval', 'hl.plugin.HyprWindowShade.classshader("brave-browser", "clear")')
        ctl('plugin', 'unload', str(PLUGIN))
    state.unlink(missing_ok=True)


def turn_on(state):
    if json.loads(ctl('-j', 'version'))['commit'] != COMMIT:
        raise RuntimeError('Rebuild this trial for your updated Hyprland before enabling it.')
    if loaded() and not owns(state):
        raise RuntimeError('Another HyprWindowShade plugin is loaded; leaving it alone.')
    if not loaded():
        ctl('plugin', 'load', str(PLUGIN))
        write_state(state)
    try:
        ctl('eval', 'hl.plugin.HyprWindowShade.classshader("brave-browser", ' + json.dumps(str(SHADER)) + ')')
    except Exception:
        turn_off(state)
        raise


def remove():
    if FLAGS.exists():
        FLAGS.write_text(extension_flags(FLAGS.read_text(), False))
    if NATIVE.exists() and json.loads(NATIVE.read_text()).get('path') == str(BASE / 'native_host.py'):
        NATIVE.unlink()
    for name in ('brave-transparency', 'brave-media-transparency'):
        path = Path.home() / '.local/bin' / name
        if path.exists() and 'brave-media-transparency' in path.read_text():
            path.unlink()
    shutil.rmtree(BASE)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'on', 'off', 'status', 'remove'))
    args = parser.parse_args()
    if args.action == 'install':
        install()
        print('Extension prepared for your next Brave restart; no browser was restarted.')
        return
    state = state_path()
    if args.action == 'on':
        install()
        configure(True)
        print('Compositor ready. The extension toolbar switch enables transparency globally and remembers it across browser restarts.')
    elif args.action in ('off', 'remove'):
        configure(False)
        if args.action == 'remove':
            remove()
            print('Media transparency trial removed; restart Brave when convenient to unload its extension.')
        else:
            print('Brave transparency OFF; original rendering restored.')
    else:
        print('Media-aware compositor ' + ('READY (global extension switch controls activation)' if owns(state) and loaded() else 'OFF'))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.TimeoutExpired, OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
