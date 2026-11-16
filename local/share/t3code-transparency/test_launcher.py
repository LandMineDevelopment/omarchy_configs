import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('launcher', Path(__file__).with_name('launcher.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

MAIN_SOURCE = '''minWidth: 840; minHeight: 620;
new electron.BrowserWindow(options);
execTarget: process.env.APPIMAGE?.trim() || process.execPath,
const execTarget = getOrElse(environment.appImagePath, () => process.execPath);
'''


def archive(path, files):
    header = {'files': {}}
    offset = 0
    for name, data in files.items():
        entry = header
        parts = name.split('/')
        for part in parts[:-1]:
            entry = entry['files'].setdefault(part, {'files': {}})
        entry['files'][parts[-1]] = {'size': len(data), 'offset': str(offset),
                                  'integrity': launcher.integrity(data)}
        offset += len(data)
    header['files']['native.node'] = {'size': 123, 'unpacked': True}
    header['files']['alias'] = {'link': 'unchanged.txt'}
    raw = json.dumps(header, separators=(',', ':')).encode()
    payload = struct.pack('<I', len(raw)) + raw + bytes(-len(raw) % 4)
    pickle = struct.pack('<I', len(payload)) + payload
    path.write_bytes(struct.pack('<2I', 4, len(pickle)) + pickle + b''.join(files.values()))
    return header


class LauncherTests(unittest.TestCase):
    def test_repack_preserves_unmodified_files_and_native_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'app.asar'
            original = archive(path, {launcher.MAIN: MAIN_SOURCE.encode(),
                                     'unchanged.txt': b'untouched\x00binary'})
            launcher.patch_archive(path)
            with path.open('rb') as f:
                header, base = launcher.read_header(f)
                mapping = dict(launcher.entries(header))
                self.assertEqual(mapping['native.node'], original['files']['native.node'])
                self.assertEqual(mapping['alias'], original['files']['alias'])
                for name, entry in mapping.items():
                    if 'offset' not in entry:
                        continue
                    f.seek(base + int(entry['offset']))
                    data = f.read(entry['size'])
                    self.assertEqual(launcher.integrity(data), entry['integrity'])
                    if name == 'unchanged.txt':
                        self.assertEqual(data, b'untouched\x00binary')
                    if name == launcher.MAIN:
                        self.assertIn(b'createWindow(electron, options)', data)
                    if name == launcher.HOOK:
                        self.assertEqual(data, (launcher.ROOT / 'local-transparency.cjs').read_bytes())

    def test_incompatible_release_leaves_archive_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'app.asar'
            archive(path, {launcher.MAIN: b'unsupported future release'})
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                launcher.patch_archive(path)
            self.assertEqual(path.read_bytes(), before)

    def test_duplicate_constructor_fails_closed(self):
        with self.assertRaises(ValueError):
            launcher.patch_main(MAIN_SOURCE + 'new electron.BrowserWindow(options)')

    def test_url_handler_changes_fail_closed(self):
        with self.assertRaises(ValueError):
            launcher.patch_main(MAIN_SOURCE.replace('const execTarget', 'const changed'))

    def test_incompatible_version_launches_official_app_without_cache_environment(self):
        with patch.object(launcher.sys, 'argv', ['launcher', 't3code://app/welcome']), \
             patch.object(launcher, 'prepare', side_effect=ValueError('new release')), \
             patch.dict(os.environ, {'APPDIR': '/old', 'ELECTRON_RUN_AS_NODE': '1'}), \
             patch.object(launcher.os, 'execve', side_effect=SystemExit) as execute:
            with self.assertRaises(SystemExit):
                launcher.main()
            executable, args, env = execute.call_args.args
            self.assertEqual(executable, str(launcher.SOURCE))
            self.assertEqual(args, [str(launcher.SOURCE), 't3code://app/welcome'])
            self.assertNotIn('APPDIR', env)
            self.assertNotIn('ELECTRON_RUN_AS_NODE', env)

    def test_patched_launch_keeps_official_update_target_and_forwards_urls(self):
        cached = Path('/isolated/cache/squashfs-root')
        with patch.object(launcher.sys, 'argv', ['launcher', 't3code://app/welcome']), \
             patch.object(launcher, 'prepare', return_value=cached), \
             patch.object(launcher.os, 'execve', side_effect=SystemExit) as execute:
            with self.assertRaises(SystemExit):
                launcher.main()
            executable, args, env = execute.call_args.args
            self.assertEqual(executable, str(cached / 'AppRun'))
            self.assertEqual(args[1:], ['t3code://app/welcome'])
            self.assertEqual(env['APPIMAGE'], str(launcher.SOURCE))
            self.assertEqual(env['APPDIR'], str(cached))
            self.assertEqual(env['T3CODE_TRANSPARENCY_LAUNCHER'], str(launcher.LAUNCHER))

    def test_native_launch_strips_appimage_install_flags_and_node_mode(self):
        with patch.dict(os.environ, {'APPDIR': '/old', 'APPIMAGE': '/old/image',
                                    'APPIMAGE_EXIT_AFTER_INSTALL': '1',
                                    'APPIMAGE_SILENT_INSTALL': '1',
                                    'ELECTRON_RUN_AS_NODE': '1',
                                    'LD_LIBRARY_PATH': '/old/libs',
                                    'T3CODE_HOME': '/same/history', 'SSH_AUTH_SOCK': '/same/ssh'}):
            clean = launcher.clean_environment()
            for key in ('APPDIR', 'APPIMAGE', 'APPIMAGE_EXIT_AFTER_INSTALL',
                        'APPIMAGE_SILENT_INSTALL', 'ELECTRON_RUN_AS_NODE', 'LD_LIBRARY_PATH'):
                self.assertNotIn(key, clean)
            self.assertEqual(clean['T3CODE_HOME'], '/same/history')
            self.assertEqual(clean['SSH_AUTH_SOCK'], '/same/ssh')


if __name__ == '__main__':
    unittest.main()
