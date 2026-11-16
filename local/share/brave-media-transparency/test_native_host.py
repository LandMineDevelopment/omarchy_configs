import io
import json
import struct
import time
import unittest
import tempfile
import threading
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
from native_host import Bridge, DisabledError, InvalidMessage, MAX_FRAME, lua_bytes, main, read_message, validate_snapshot, validate_native_ui


def snapshot(**changes):
    result = dict(type="snapshot", windowId=1, title="A tab", focused=True, outerWidth=1000,
                  outerHeight=700, deviceScale=1, capturedAt=time.time() * 1000, rects=[[.1, .2, .4, .3]])
    result.update(changes)
    return result


def window(**changes):
    result = dict(address="0xabcd", mapped=True, hidden=False, xwayland=False,
                  fullscreen=0, fullscreenClient=0, monitor=0, size=[1000, 700],
                  **{"class": "brave-browser", "title": "A tab - Brave"})
    result.update(changes)
    return result


def native_ui(**changes):
    result = snapshot()
    result.pop('rects'); result.pop('deviceScale')
    result.update(type='native-ui', url='chrome://settings/')
    result.update(changes)
    return result


class FakeRunner:
    def __init__(self, active=None, clients=None, latest=None, monitors=None):
        self.active = window() if active is None else active
        self.clients = [self.active] if clients is None else clients
        self.latest = self.active if latest is None else latest
        self.monitors = [{"id": 0, "scale": 1}] if monitors is None else monitors
        self.active_calls = 0
        self.calls = []

    def __call__(self, args):
        self.calls.append(args)
        if args == ["hyprctl", "-j", "activewindow"]:
            self.active_calls += 1
            return json.dumps(self.active if self.active_calls == 1 else self.latest)
        if args == ["hyprctl", "-j", "monitors"]:
            return json.dumps(self.monitors)
        if args == ["hyprctl", "-j", "clients"]:
            return json.dumps(self.clients)
        return "ok"

    @property
    def evals(self):
        return [call[2] for call in self.calls if call[1] == "eval"]


def make_bridge(runner, clock=time.time):
    bridge = Bridge(runner, clock, configure=lambda enabled: None, enabled=lambda: True)
    bridge.handle({'type': 'configure', 'enabled': True})
    return bridge


class ProtocolTests(unittest.TestCase):
    def test_native_ui_authorization_uses_exact_internal_origin_not_title(self):
        for scheme in ('chrome', 'brave'):
            for host in ('settings', 'extensions', 'flags', 'history', 'downloads', 'bookmarks'):
                self.assertEqual(validate_native_ui(native_ui(url=f'{scheme}://{host}/subpage?q=1#section')), '')
        for url in ('https://settings/', 'https://evil.test/chrome://settings/', 'chrome://settings.evil/',
                    'chrome://evil@settings/', 'chrome://settings:80/', 'chrome://newtab/',
                    'chrome://devtools/', 'chrome://pdf/', 'brave://wallet/', 'chrome-extension://id/settings/'):
            with self.subTest(url=url), self.assertRaises(InvalidMessage):
                validate_native_ui(native_ui(url=url, title='Settings'))
        for changes in ({'rects':[]}, {'deviceScale':1}, {'focused':1}, {'outerWidth':True}, {'capturedAt':float('nan')}):
            with self.subTest(changes=changes), self.assertRaises(InvalidMessage):
                validate_native_ui(native_ui(**changes))
    def test_omarchy_canvas_updates_only_when_color_or_app_opacity_changes(self):
        runner = FakeRunner()
        bridge = make_bridge(runner)
        values = {'background':'#000000','foreground':'#e6e6e6','accent':'#ffdd80',
                  'selection':'#404040','selectionForeground':'#e6e6e6','opacity':.5}
        bridge.theme_palette.get = lambda: dict(values)
        self.assertEqual(bridge.palette(), values)
        self.assertEqual(runner.evals, ['hl.plugin.HyprWindowShade.mediapalette(0,0,0,0.5)'])
        values['accent'] = '#aaccff'
        self.assertEqual(bridge.palette()['accent'], '#aaccff')
        self.assertEqual(len(runner.evals), 1)
        values.update(background='#ff0000', opacity=.6)
        bridge.palette()
        self.assertEqual(runner.evals[-1], 'hl.plugin.HyprWindowShade.mediapalette(1,0,0,0.6)')
        bridge.handle({'type':'configure','enabled':True})
        bridge.palette()
        self.assertEqual(len(runner.evals), 3, 'a new configure reapplies palette after native reload')

    def test_framing_and_eof(self):
        message = snapshot()
        data = json.dumps(message).encode()
        stream = io.BytesIO(struct.pack("<I", len(data)) + data)
        self.assertEqual(read_message(stream), message)
        self.assertIsNone(read_message(stream))

    def test_rejects_bad_frames(self):
        for data in (b"a", struct.pack("<I", 0), struct.pack("<I", MAX_FRAME + 1),
                     struct.pack("<I", 2) + b"{", struct.pack("<I", 2) + b"[]"):
            with self.subTest(data=data), self.assertRaises(InvalidMessage):
                read_message(io.BytesIO(data))

    def test_rejects_unsafe_numbers_and_schema(self):
        cases = [snapshot(rects=[[float("nan"), 0, .1, .1]]),
                 snapshot(rects=[[True, 0, .1, .1]]),
                 snapshot(rects=[[0, 0, 1.1, .1]]),
                 snapshot(rects=[[.9, 0, .2, .1]]),
                 snapshot(rects=[[0, 0, 0, .1]]),
                 snapshot(rects=[[0, 0, .1, .1]] * 129),
                 snapshot(outerWidth=True), snapshot(focused=1),
                 snapshot(deviceScale=True), snapshot(deviceScale=float("nan")),
                 snapshot(deviceScale=0), snapshot(deviceScale=20),
                 snapshot(windowId=True), snapshot(windowId=0), snapshot(windowId=-1),
                 snapshot(title="bad\ntext"), snapshot(extra="anything")]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(InvalidMessage):
                validate_snapshot(case)

    def test_zero_media_is_valid(self):
        self.assertEqual(validate_snapshot(snapshot(rects=[])), "")

    def test_title_encoder_never_exposes_lua_source(self):
        encoded = lua_bytes("\"\\\n'); evil(); -- ☃")
        self.assertRegex(encoded, r'^"(?:\\[0-9]{3})*"$')
        self.assertNotIn("evil", encoded)


class MappingTests(unittest.TestCase):
    def test_native_ui_derives_fractional_bounds_from_monitor_and_native_surface(self):
        runner=FakeRunner(active=window(stableId='1a', size=[2042,1116]), monitors=[{'id':0,'scale':1.25}])
        bridge=make_bridge(runner)
        self.assertTrue(bridge.handle(native_ui(outerWidth=1720,outerHeight=940)))
        self.assertIn(',"",2042,1116,',runner.evals[-1])
        self.assertTrue(runner.evals[-1].endswith(',"1a")'))
        before=len(runner.calls)
        self.assertTrue(bridge.handle(native_ui(outerWidth=1720,outerHeight=940,focused=False)))
        self.assertEqual(len(runner.calls)-before,1,'steady policy only publishes; plugin validates live identity')

    def test_native_ui_rejects_missing_lifetime_bad_aspect_or_scale(self):
        for candidate, bounds, monitors in (
            (window(),{},None),
            (window(stableId='1a',size=[1000,800]),{},None),
            (window(stableId='1a'),{},[{'id':0,'scale':20}]),
        ):
            runner=FakeRunner(active=candidate,monitors=monitors)
            with self.assertRaises(InvalidMessage): make_bridge(runner).handle(native_ui(**bounds))
            self.assertFalse(any('mediarects' in expression for expression in runner.evals))

    def test_native_ui_keeps_prior_physical_binding_with_duplicate_titles(self):
        runner=FakeRunner(active=window(stableId='1a'))
        bridge=make_bridge(runner);bridge.handle(snapshot())
        bridge.handle({'type':'invalidate','windowId':1,'reason':'navigation'})
        runner.clients=[window(stableId='1a',title='Settings - Brave'),window(address='0xbcde',stableId='2b',title='Settings - Brave')]
        self.assertTrue(bridge.handle(native_ui(title='Settings',focused=False)))
        self.assertIn('mediarects("0xabcd"',runner.evals[-1])
        runner.clients[0]['stableId']='3c'
        bridge.handle({'type':'invalidate','windowId':1,'reason':'navigation'})
        with self.assertRaises(InvalidMessage):bridge.handle(native_ui(title='Settings'))
        self.assertIn(1,bridge.retired_windows)

    def test_rejected_native_ui_clears_only_its_existing_owner(self):
        runner=FakeRunner(clients=[window(stableId='1a'),window(address='0xbcde',stableId='2b',title='Other - Brave')])
        bridge=make_bridge(runner)
        bridge.handle(snapshot());bridge.handle(snapshot(windowId=2,title='Other',focused=False))
        with self.assertRaises(InvalidMessage):bridge.handle(native_ui(url='https://evil.test/',title='Settings'))
        self.assertNotIn(1,bridge.associations);self.assertIn(2,bridge.associations)
        self.assertEqual(runner.evals[-1],'hl.plugin.HyprWindowShade.mediareset("0xabcd")')
    def test_valid_window_updates_only_identified_address(self):
        runner = FakeRunner()
        bridge = make_bridge(runner)
        self.assertTrue(bridge.handle(snapshot()))
        self.assertEqual(len(runner.evals), 1)
        self.assertTrue(runner.evals[0].startswith('hl.plugin.HyprWindowShade.mediarects("0xabcd",'))
        self.assertIn(',1000,700,"\\065', runner.evals[0])

    def test_steady_snapshots_only_publish_and_check_ownership(self):
        import control
        runner = FakeRunner()
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'session.json'
            state.write_text(json.dumps({'plugin': str(control.PLUGIN)}))
            with patch.object(control, 'state_path', return_value=state) as resolve, patch.object(control, 'loaded', return_value=True), patch.object(control, 'ctl', return_value=json.dumps({'commit':control.COMMIT})):
                bridge = Bridge(runner)
                bridge.handle({'type': 'configure', 'enabled': True})
                self.assertTrue(bridge.handle(snapshot()))
                runner.calls.clear()
                self.assertTrue(bridge.handle(snapshot(rects=[[.1, .3, .4, .3]])))
                self.assertEqual(len(runner.calls), 1)
                self.assertEqual(runner.calls[0][1], 'eval')
                self.assertIn('mediarects', runner.calls[0][2])
                resolve.assert_called_once_with()
                self.assertTrue(control.owns(state, bridge.ownership_token))

    def test_changed_metadata_renews_identification(self):
        cases = [dict(title='New tab'), dict(outerWidth=1001),
                 dict(outerHeight=701), dict(deviceScale=1.001)]
        for changes in cases:
            runner = FakeRunner()
            bridge = make_bridge(runner)
            bridge.handle(snapshot())
            runner.calls.clear()
            if 'title' in changes:
                runner.active['title'] = changes['title'] + ' - Brave'
            self.assertTrue(bridge.handle(snapshot(**changes)))
            self.assertEqual(len(runner.calls), 3)
            self.assertEqual(sum(call == ['hyprctl', '-j', 'clients'] for call in runner.calls), 1)

    def test_invalidation_renews_identification(self):
        runner = FakeRunner()
        bridge = make_bridge(runner)
        bridge.handle(snapshot())
        bridge.handle({'type': 'invalidate', 'reason': 'navigation'})
        self.assertEqual(bridge.associations, {})
        runner.calls.clear()
        bridge.handle(snapshot())
        self.assertEqual(len(runner.calls), 3)

    def test_native_identity_rejection_revokes_cache_without_retry(self):
        runner = FakeRunner()
        reject = [False]
        def run(args):
            result = runner(args)
            return 'media window changed during update' if reject[0] and 'mediarects' in args[-1] else result
        bridge = make_bridge(run)
        bridge.handle(snapshot())
        runner.calls.clear()
        reject[0] = True
        with self.assertRaises(RuntimeError):
            bridge.handle(snapshot())
        self.assertEqual(bridge.associations, {})
        self.assertEqual(len(runner.calls), 2)
        self.assertTrue(all(call[1] == 'eval' for call in runner.calls))
        reject[0] = False
        runner.calls.clear()
        bridge.handle(snapshot())
        self.assertEqual(len(runner.calls), 3)

    def test_configure_error_revokes_cached_association(self):
        runner = FakeRunner()
        bridge = make_bridge(runner)
        bridge.handle(snapshot())
        def fail(enabled):
            raise RuntimeError('configure failed')
        bridge.configure_plugin = fail
        with self.assertRaises(RuntimeError):
            bridge.handle({'type': 'configure', 'enabled': True})
        self.assertEqual(bridge.associations, {})
        self.assertFalse(bridge.configured)

    def test_stale_and_malformed_snapshots_revoke_cache(self):
        for invalid in (snapshot(capturedAt=0), snapshot(rects=[[float('nan'), 0, .1, .1]])):
            runner = FakeRunner()
            bridge = make_bridge(runner)
            bridge.handle(snapshot())
            runner.calls.clear()
            with self.assertRaises(InvalidMessage):
                bridge.handle(invalid)
            self.assertEqual(bridge.associations, {})
            self.assertEqual(runner.evals, ['hl.plugin.HyprWindowShade.mediareset("0xabcd")'])

    def test_fractional_monitor_and_browser_device_scales(self):
        runner = FakeRunner(active=window(size=[1016, 1116]), monitors=[{'id': 0, 'scale': 1.25}])
        bridge = make_bridge(runner)
        self.assertTrue(bridge.handle(snapshot(outerWidth=856, outerHeight=940, deviceScale=1.484375)))
        self.assertIn(',1016,1116,', runner.evals[-1])

    def test_fullscreen_and_maximized_masks_use_exact_scaled_geometry(self):
        # Native Hyprland fullscreen/maximized and client-requested F11 states
        # all retain title/class/visibility/geometry ownership checks.
        for native, client in ((1, 0), (2, 0), (0, 1), (0, 2), (2, 2)):
            with self.subTest(native=native, client=client):
                runner = FakeRunner(active=window(fullscreen=native, fullscreenClient=client,
                                                  size=[2048, 1120]),
                                    monitors=[{'id': 0, 'scale': 1.25}])
                bridge = make_bridge(runner)
                self.assertTrue(bridge.handle(snapshot(outerWidth=2048, outerHeight=1120,
                                                       deviceScale=1.25)))
                self.assertIn(',2048,1120,', runner.evals[-1])

    def test_fullscreen_rejects_stale_geometry_and_preserves_other_owner(self):
        runner = FakeRunner(clients=[window(), window(address='0xbcde', title='Second - Brave')])
        bridge = make_bridge(runner)
        bridge.handle(snapshot())
        bridge.handle(snapshot(windowId=2, title='Second', focused=False))
        runner.clients[0].update(fullscreen=2, fullscreenClient=2, size=[2048, 1120])
        runner.calls.clear()
        # A fresh browser sample with changed but still incorrect geometry must
        # identify again and fail closed instead of authorizing the new frame.
        with self.assertRaises(InvalidMessage):
            bridge.handle(snapshot(outerWidth=2040, outerHeight=1120))
        self.assertEqual(set(bridge.associations), {2})
        self.assertEqual(runner.evals, ['hl.plugin.HyprWindowShade.mediareset("0xabcd")'])
        self.assertTrue(bridge.handle(snapshot(outerWidth=2048, outerHeight=1120)))
        self.assertEqual(set(bridge.associations), {1, 2})

    def test_matching_browser_and_monitor_scale_preserves_dimensions(self):
        runner = FakeRunner(monitors=[{'id': 0, 'scale': 2}])
        self.assertTrue(make_bridge(runner).handle(snapshot(deviceScale=2)))
        self.assertIn(',1000,700,', runner.evals[-1])

    def test_spoofed_or_unknown_scale_fails_closed(self):
        for runner, message in [(FakeRunner(), snapshot(deviceScale=2)),
                                (FakeRunner(monitors=[]), snapshot()),
                                (FakeRunner(monitors=[{'id': 0, 'scale': 0}]), snapshot()),
                                (FakeRunner(monitors=[{'id': 1, 'scale': 1}]), snapshot()),
                                (FakeRunner(monitors=[{'id': 0, 'scale': 1}, {'id': 0, 'scale': 1}]), snapshot())]:
            with self.subTest(message=message), self.assertRaises(InvalidMessage):
                make_bridge(runner).handle(message)
            self.assertEqual(runner.evals, [])

    def test_mismatch_ambiguity_and_injection_reset(self):
        cases = [FakeRunner(active=window(title="Other - Brave")),
                 FakeRunner(active=window(size=[999, 600])),
                 FakeRunner(active=window(size=[1003, 700])),
                 FakeRunner(active=window(hidden=True)),
                 FakeRunner(active=window(xwayland=True)),
                 FakeRunner(active=window(address='0x123";evil()')),
                 FakeRunner(active={}, clients=[window(), window(address="0xbcde")]),
                 FakeRunner(active=window(visible=False))]
        for runner in cases:
            with self.subTest(runner=runner), self.assertRaises(InvalidMessage):
                make_bridge(runner).handle(snapshot())
            self.assertEqual(runner.evals, [])

    def test_verified_identity_survives_navigation_to_duplicate_new_tab_titles(self):
        runner = FakeRunner(clients=[window(stableId='1a'), window(address='0xbcde', stableId='2b', title='Second - Brave')])
        bridge = make_bridge(runner)
        bridge.handle(snapshot())
        bridge.handle(snapshot(windowId=2,title='Second',focused=False))
        bridge.handle({'type':'invalidate','windowId':1,'reason':'navigation'})
        bridge.handle({'type':'invalidate','windowId':2,'reason':'tab-changed'})
        self.assertEqual(bridge.associations,{})
        self.assertEqual(bridge.identities,{1:('1a','0xabcd'),2:('2b','0xbcde')})
        for client in runner.clients: client['title']='New Tab - Brave'
        runner.calls.clear()
        bridge.handle(snapshot(title='New Tab'))
        bridge.handle(snapshot(windowId=2,title='New Tab',focused=False))
        self.assertIn('mediarects("0xabcd"',runner.evals[0])
        self.assertTrue(runner.evals[0].endswith(',"1a")'))
        self.assertIn('mediarects("0xbcde"',runner.evals[1])
        self.assertTrue(runner.evals[1].endswith(',"2b")'))
        runner.calls.clear()
        bridge.handle(snapshot(title='New Tab'))
        self.assertEqual(len(runner.calls),1)

    def test_bound_window_temporarily_mismatching_never_rebinds_other_match(self):
        runner = FakeRunner(clients=[window(stableId='1a'),window(address='0xbcde',stableId='2b',title='Second - Brave')])
        bridge=make_bridge(runner)
        bridge.handle(snapshot())
        bridge.handle({'type':'invalidate','windowId':1,'reason':'title-changed'})
        runner.clients[0]['title']='Loading - Brave'
        runner.clients[1]['title']='New Tab - Brave'
        runner.calls.clear()
        with self.assertRaises(InvalidMessage): bridge.handle(snapshot(title='New Tab'))
        self.assertEqual(bridge.identities[1],('1a','0xabcd'))
        self.assertEqual(runner.evals,[])
        runner.clients[0]['title']='New Tab - Brave'
        self.assertTrue(bridge.handle(snapshot(title='New Tab')))
        self.assertIn('mediarects("0xabcd"',runner.evals[-1])

    def test_page_invalidations_preserve_identity_during_state_and_geometry_mismatches(self):
        for changes in ({'hidden':True},{'mapped':False},{'visible':False},
                        {'size':[1100,700]},{'class':'other-app'}):
            with self.subTest(changes=changes):
                runner=FakeRunner(active=window(stableId='1a'))
                bridge=make_bridge(runner)
                bridge.handle(snapshot())
                bridge.handle({'type':'invalidate','windowId':1,'reason':'geometry-changed'})
                runner.clients=[window(stableId='1a',**changes),
                                window(address='0xbcde',stableId='2b')]
                with self.assertRaises(InvalidMessage): bridge.handle(snapshot())
                self.assertEqual(bridge.identities[1],('1a','0xabcd'))
                runner.clients[0]=window(stableId='1a')
                self.assertTrue(bridge.handle(snapshot()))
                self.assertIn('mediarects("0xabcd"',runner.evals[-1])

    def test_removed_or_reused_stable_identity_retires_channel_until_close(self):
        for missing in (True,False):
            runner=FakeRunner(active=window(stableId='1a'))
            bridge=make_bridge(runner)
            bridge.handle(snapshot())
            bridge.handle({'type':'invalidate','windowId':1,'reason':'navigation'})
            runner.clients=[] if missing else [window(stableId='3c')]
            with self.assertRaises(InvalidMessage): bridge.handle(snapshot())
            self.assertEqual(bridge.identities,{})
            self.assertIn(1,bridge.retired_windows)
            runner.clients=[window(stableId='3c')]
            runner.calls.clear()
            with self.assertRaises(InvalidMessage): bridge.handle(snapshot())
            self.assertEqual(runner.calls,[])
            bridge.handle({'type':'invalidate','windowId':1,'reason':'window-closed'})
            self.assertTrue(bridge.handle(snapshot()))
            self.assertEqual(bridge.identities[1],('3c','0xabcd'))

    def test_native_stable_guard_rejection_retires_fastpath_owner(self):
        runner=FakeRunner(active=window(stableId='1a'))
        reject=[False]
        def run(args):
            result=runner(args)
            return 'media window identity changed' if reject[0] and 'mediarects' in args[-1] else result
        bridge=make_bridge(run)
        bridge.handle(snapshot())
        runner.calls.clear(); reject[0]=True
        with self.assertRaises(RuntimeError): bridge.handle(snapshot())
        self.assertEqual(bridge.identities,{})
        self.assertIn(1,bridge.retired_windows)
        self.assertEqual(len(runner.calls),2)
        runner.calls.clear(); reject[0]=False
        with self.assertRaises(InvalidMessage): bridge.handle(snapshot())
        self.assertEqual(runner.calls,[])

    def test_initial_duplicate_titles_require_verified_desktop_focus(self):
        clients=[window(stableId='1a'),window(address='0xbcde',stableId='2b')]
        runner=FakeRunner(active=clients[1],clients=clients)
        bridge=make_bridge(runner)
        with self.assertRaises(InvalidMessage): bridge.handle(snapshot(focused=False))
        self.assertEqual(bridge.identities,{})
        self.assertTrue(bridge.handle(snapshot(focused=True)))
        self.assertEqual(bridge.identities[1],('2b','0xbcde'))
        runner=FakeRunner(active=window(**{'class':'terminal'}),clients=clients)
        with self.assertRaises(InvalidMessage): make_bridge(runner).handle(snapshot(focused=True))

    def test_window_close_and_global_reset_forget_verified_identity(self):
        runner=FakeRunner(active=window(stableId='1a'))
        bridge=make_bridge(runner)
        bridge.handle(snapshot())
        bridge.handle({'type':'invalidate','windowId':1,'reason':'window-closed'})
        self.assertEqual(bridge.identities,{})
        bridge.handle(snapshot())
        bridge.reset()
        self.assertEqual(bridge.identities,{})
        self.assertEqual(bridge.retired_windows,set())

    def test_invalid_or_absent_stable_ids_never_claim_persistent_identity(self):
        for value in ('', '0', '0x1a', '1g', 'a'*17, True):
            with self.subTest(value=value),self.assertRaises(InvalidMessage):
                make_bridge(FakeRunner(active=window(stableId=value))).handle(snapshot())
        bridge=make_bridge(FakeRunner())
        bridge.handle(snapshot())
        self.assertEqual(bridge.identities,{})

    def test_changed_window_clears_only_old_target(self):
        runner = FakeRunner()
        bridge = make_bridge(runner)
        bridge.handle(snapshot())
        runner.clients = [window(address="0xbcde", title="New tab - Brave")]
        runner.calls.clear()
        bridge.handle(snapshot(title="New tab"))
        self.assertEqual(runner.evals[0], 'hl.plugin.HyprWindowShade.mediareset("0xabcd")')
        self.assertEqual(bridge.associations[1][1][0], "0xbcde")

    def test_unfocused_windows_keep_independent_masks_and_clocks(self):
        runner = FakeRunner(clients=[window(), window(address="0xbcde", title="Second - Brave")])
        bridge = make_bridge(runner, clock=lambda: 1000)
        bridge.handle(snapshot(capturedAt=1000000))
        bridge.handle(snapshot(windowId=2, title="Second", focused=False, capturedAt=999950))
        self.assertEqual(set(bridge.associations), {1, 2})
        runner.calls.clear()
        bridge.handle(snapshot(focused=False, capturedAt=1000000))
        self.assertEqual(len(runner.calls), 1)
        bridge.handle({'type': 'invalidate', 'windowId': 2, 'reason': 'minimized'})
        self.assertEqual(set(bridge.associations), {1})
        self.assertEqual(runner.evals[-1], 'hl.plugin.HyprWindowShade.mediareset("0xbcde")')

    def test_local_rejection_preserves_other_window(self):
        runner = FakeRunner(clients=[window(), window(address="0xbcde", title="Second - Brave")])
        bridge = make_bridge(runner)
        bridge.handle(snapshot())
        bridge.handle(snapshot(windowId=2, title="Second", focused=False))
        runner.calls.clear()
        with self.assertRaises(InvalidMessage):
            bridge.handle(snapshot(windowId=2, title="Second", capturedAt=0))
        self.assertEqual(set(bridge.associations), {1})
        self.assertEqual(runner.evals, ['hl.plugin.HyprWindowShade.mediareset("0xbcde")'])
        runner.calls.clear()
        bridge.handle(snapshot())
        self.assertEqual(len(runner.calls), 1)

    def test_unbound_channel_cannot_overwrite_or_clear_existing_native_owner(self):
        runner = FakeRunner()
        bridge = make_bridge(runner)
        bridge.handle(snapshot())
        runner.calls.clear()
        with self.assertRaisesRegex(InvalidMessage, "another channel"):
            bridge.handle(snapshot(windowId=2, focused=False))
        self.assertEqual(set(bridge.associations), {1})
        self.assertEqual(runner.evals, [])
        runner.calls.clear()
        bridge.handle(snapshot())
        self.assertEqual(len(runner.calls), 1)

    def test_rebinding_channel_rejection_clears_only_its_previous_owner(self):
        runner = FakeRunner(clients=[window(), window(address="0xbcde", title="Second - Brave")])
        bridge = make_bridge(runner)
        bridge.handle(snapshot())
        bridge.handle(snapshot(windowId=2, title="Second", focused=False))
        # Its original native window is now hidden. A delayed browser snapshot
        # happens to describe the first window's title and dimensions instead.
        runner.clients = [window(), window(address="0xbcde", title="Second - Brave", hidden=True)]
        runner.calls.clear()
        with self.assertRaisesRegex(InvalidMessage, "another channel"):
            bridge.handle(snapshot(windowId=2, focused=False))
        self.assertEqual(set(bridge.associations), {1})
        self.assertEqual(runner.evals, ['hl.plugin.HyprWindowShade.mediareset("0xbcde")'])
        runner.calls.clear()
        bridge.handle(snapshot())
        self.assertEqual(len(runner.calls), 1)

    def test_invalid_targeted_identity_never_becomes_global_invalidation(self):
        runner = FakeRunner()
        bridge = make_bridge(runner)
        bridge.handle(snapshot())
        runner.calls.clear()
        with self.assertRaises(InvalidMessage):
            bridge.handle({'type': 'invalidate', 'windowId': False})
        self.assertEqual(set(bridge.associations), {1})
        self.assertEqual(runner.calls, [])

    def test_invalidation_clears_even_without_focus(self):
        runner = FakeRunner(active={})
        self.assertFalse(make_bridge(runner).handle({"type": "invalidate", "reason": "scroll"}))
        self.assertEqual(len(runner.calls), 1)

    def test_stale_snapshots_never_reach_compositor(self):
        runner = FakeRunner()
        bridge = make_bridge(runner, clock=lambda: 1000)
        for captured in (999000, 1000100):
            with self.assertRaises(InvalidMessage):
                bridge.handle(snapshot(capturedAt=captured))
        self.assertTrue(all("mediareset" in expression for expression in runner.evals))

    def test_snapshot_expiring_during_ipc_is_rejected(self):
        runner = FakeRunner()
        times = iter([1000, 1000.3])
        bridge = make_bridge(runner, clock=lambda: next(times))
        with self.assertRaises(InvalidMessage):
            bridge.handle(snapshot(capturedAt=1000000))
        self.assertEqual(runner.evals, [])

    def test_configure_load_disable_and_restart(self):
        runner = FakeRunner()
        changes = []
        bridge = Bridge(runner, configure=changes.append, enabled=lambda: bool(changes[-1]))
        with self.assertRaises(DisabledError):
            bridge.handle(snapshot())
        self.assertTrue(bridge.handle({'type': 'configure', 'enabled': True}))
        self.assertTrue(bridge.handle(snapshot()))
        self.assertTrue(bridge.handle({'type': 'configure', 'enabled': False}))
        with self.assertRaises(DisabledError):
            bridge.handle(snapshot())
        self.assertEqual(changes, [True, False])

    def test_cli_off_disables_connected_host(self):
        runner = FakeRunner()
        enabled = [True]
        bridge = Bridge(runner, configure=lambda value: None, enabled=lambda: enabled[0])
        bridge.handle({'type': 'configure', 'enabled': True})
        enabled[0] = False
        with self.assertRaises(DisabledError):
            bridge.handle(snapshot())
        self.assertEqual(runner.calls, [])

    def test_configure_failure_surfaces_protocol_error(self):
        def configure(enabled):
            raise RuntimeError('rebuild required')
        bridge = Bridge(FakeRunner(), configure=configure, enabled=lambda: False)
        packet = json.dumps({'type': 'configure', 'enabled': True}).encode()
        output = io.BytesIO()
        main(io.BytesIO(struct.pack('<I', len(packet)) + packet), output, bridge)
        self.assertEqual(read_message(io.BytesIO(output.getvalue())),
                         {'accepted': False, 'error': 'configure-failed'})
        self.assertFalse(bridge.configured)

    def test_abi_loader_rejection_preserves_rebuild_reason_without_private_path(self):
        cases = (
            ('[HyprWindowShade] Hyprland ABI mismatch; rebuild the plugin against the running Hyprland and dependency versions.',
             'Hyprland ABI mismatch; rebuild the plugin against the running Hyprland and dependency versions.'),
            ('[HyprWindowShade] Hyprland ABI hash unavailable; refusing plugin initialization.',
             'Hyprland ABI hash unavailable; plugin initialization was refused.'),
        )
        for error, detail in cases:
            with self.subTest(error=error):
                # Exact loadPluginInternal rejection shape from the installed
                # Hyprland commit, including our production runtime_error.
                loader_error = ('Plugin /private/user/plugin/HyprWindowShade.so could not be loaded: '
                                'plugin crashed/threw in main: ' + error)
                def configure(enabled):
                    raise RuntimeError(loader_error)
                runner = FakeRunner()
                bridge = Bridge(runner, configure=configure, enabled=lambda: False)
                packet = json.dumps({'type': 'configure', 'enabled': True}).encode()
                output = io.BytesIO()
                main(io.BytesIO(struct.pack('<I', len(packet)) + packet), output, bridge)
                response = read_message(io.BytesIO(output.getvalue()))
                self.assertEqual(response, {'accepted': False, 'error': 'configure-failed', 'detail': detail})
                self.assertFalse(bridge.configured)
                self.assertEqual(runner.calls, [])
                self.assertNotIn('/private/user', json.dumps(response))

    def test_updated_hyprland_rejection_keeps_existing_actionable_detail(self):
        def configure(enabled):
            raise RuntimeError('Rebuild this trial for your updated Hyprland before enabling it.')
        bridge = Bridge(FakeRunner(), configure=configure, enabled=lambda: False)
        packet = json.dumps({'type': 'configure', 'enabled': True}).encode()
        output = io.BytesIO()
        main(io.BytesIO(struct.pack('<I', len(packet)) + packet), output, bridge)
        self.assertEqual(read_message(io.BytesIO(output.getvalue())), {
            'accepted': False, 'error': 'configure-failed',
            'detail': 'Hyprland changed; rebuild the plugin before enabling.'})
        self.assertFalse(bridge.configured)

    def test_unrecognized_loader_error_does_not_expose_private_diagnostics(self):
        def configure(enabled):
            raise RuntimeError('Plugin /private/user/plugin/HyprWindowShade.so could not be loaded: undefined symbol: private_symbol')
        bridge = Bridge(FakeRunner(), configure=configure, enabled=lambda: False)
        packet = json.dumps({'type': 'configure', 'enabled': True}).encode()
        output = io.BytesIO()
        main(io.BytesIO(struct.pack('<I', len(packet)) + packet), output, bridge)
        self.assertEqual(read_message(io.BytesIO(output.getvalue())),
                         {'accepted': False, 'error': 'configure-failed'})
        self.assertFalse(bridge.configured)

    def test_eof_always_clears(self):
        runner = FakeRunner()
        data = json.dumps(snapshot()).encode()
        output = io.BytesIO()
        main(io.BytesIO(struct.pack("<I", len(data)) + data), output, make_bridge(runner))
        self.assertTrue(read_message(io.BytesIO(output.getvalue()))["accepted"])
        self.assertEqual(runner.evals[-1], 'hl.plugin.HyprWindowShade.mediareset("all")')

    def test_plain_lua_rejection_is_not_acknowledged(self):
        runner = FakeRunner()
        original = runner.__call__
        def run(args):
            result = original(args)
            return "media window changed during update" if "mediarects" in args[-1] else result
        with self.assertRaises(RuntimeError):
            make_bridge(run).handle(snapshot())
        self.assertEqual(runner.evals[-1], 'hl.plugin.HyprWindowShade.mediareset("0xabcd")')

    def test_compositor_lua_error_fails_closed(self):
        runner = FakeRunner()
        original = runner.__call__
        def run(args):
            result = original(args)
            return "Lua error: function unavailable" if "mediarects" in args[-1] else result
        bridge = make_bridge(run)
        with self.assertRaises(RuntimeError):
            bridge.handle(snapshot())
        self.assertEqual(runner.evals[-1], 'hl.plugin.HyprWindowShade.mediareset("0xabcd")')


class PortOwnershipTests(unittest.TestCase):
    """Exercise real port leases against a fake compositor, never the desktop."""
    def setUp(self):
        import control
        self.control = control
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.state = Path(directory) / 'session.json'
        self.present = False
        self.native_calls = []
        self.masks = {}
        self.mapping = FakeRunner(active=window(stableId='1a'))
        self.stack.enter_context(patch.object(control, 'state_path', return_value=self.state))
        self.stack.enter_context(patch.object(control, 'ctl', side_effect=self.ctl))
        self.stack.enter_context(patch.object(control, 'loaded', side_effect=lambda: self.present))

    def mutate(self, expression):
        self.native_calls.append(expression)
        if 'mediarects(' in expression:
            address, rects = expression.split('(', 1)[1].split(',', 1)
            self.masks[address] = rects
        elif 'mediareset("all")' in expression:
            self.masks.clear()
        elif 'mediareset(' in expression:
            self.masks.pop(expression.split('(', 1)[1].split(')', 1)[0], None)

    def ctl(self, *args):
        if args == ('-j', 'version'):
            return json.dumps({'commit':self.control.COMMIT})
        if args[:2] == ('plugin', 'load'):
            self.present = True
        elif args[:2] == ('plugin', 'unload'):
            self.present = False
            self.native_calls.append('unload')
        elif args[0] == 'eval':
            self.mutate(args[1])
        return 'ok'

    def runner(self, args):
        if args[1] == 'eval':
            self.mutate(args[2])
            return 'ok'
        return self.mapping(args)

    def configured_bridge(self, runner=None):
        bridge = Bridge(runner or self.runner)
        bridge.handle({'type':'configure', 'enabled':True})
        bridge.handle(snapshot())
        return bridge

    def replace(self):
        bridge = self.configured_bridge()
        bridge.handle(snapshot(rects=[[.3, .4, .2, .1]]))
        return bridge

    def test_old_eof_and_late_off_preserve_new_masks_current_eof_clears(self):
        old = self.configured_bridge()
        new = self.replace()
        current_masks = dict(self.masks)
        before = list(self.native_calls)
        main(io.BytesIO(), io.BytesIO(), old)
        self.assertEqual(self.native_calls, before, 'old EOF cannot reset the new port')
        old.handle({'type':'configure', 'enabled':False})
        self.assertEqual(self.native_calls, before, 'old delayed OFF cannot unload the new port')
        self.assertEqual(self.masks, current_masks)
        self.assertTrue(self.present)
        self.assertTrue(self.control.owns(self.state, new.ownership_token))
        main(io.BytesIO(), io.BytesIO(), new)
        self.assertEqual(self.native_calls[-1], 'hl.plugin.HyprWindowShade.mediareset("all")')
        self.assertEqual(self.masks, {})
        self.assertTrue(self.present, 'EOF revokes masks without changing the global setting')

    def test_old_publication_palette_and_targeted_reset_cannot_mutate_replacement(self):
        old = self.configured_bridge()
        self.replace()
        current_masks = dict(self.masks)
        before = list(self.native_calls)
        with self.assertRaises(DisabledError):
            old.palette()
        old.reset(1)
        with self.assertRaises(DisabledError):
            old.handle(snapshot())
        self.assertEqual(self.native_calls, before)
        self.assertEqual(self.masks, current_masks)

    def test_replacement_between_enabled_check_and_publish_is_rechecked_under_lock(self):
        old = self.configured_bridge()
        original_enabled = old.plugin_enabled
        new = []
        def hand_off_after_check():
            was_enabled = original_enabled()
            new.append(self.replace())
            return was_enabled
        old.plugin_enabled = hand_off_after_check
        with self.assertRaises(DisabledError):
            old.handle(snapshot())
        self.assertTrue(self.control.owns(self.state, new[0].ownership_token))
        self.assertIn('0.3000000,0.4000000,0.2000000,0.1000000', next(iter(self.masks.values())))
        self.assertIn('mediarects(', self.native_calls[-1], 'stale failure cleanup cannot clear the replacement')

    def test_never_configured_port_cannot_turn_off_current_owner(self):
        new = self.replace()
        before = list(self.native_calls)
        Bridge(self.runner).handle({'type':'configure', 'enabled':False})
        self.assertEqual(self.native_calls, before)
        self.assertTrue(self.control.owns(self.state, new.ownership_token))

    def test_replacement_waits_for_in_progress_publication_before_claiming(self):
        entered, release, started, claimed = (threading.Event() for _ in range(4))
        errors = []
        sequence = []
        def blocked_runner(args):
            if args[1] == 'eval' and 'mediarects(' in args[2]:
                entered.set()
                if not release.wait(3):
                    raise RuntimeError('test publication timed out')
                result = self.runner(args)
                sequence.append('published')
                return result
            return self.runner(args)
        old = Bridge(blocked_runner)
        old.handle({'type':'configure', 'enabled':True})
        new = Bridge(self.runner)
        def publish():
            try:
                old.handle(snapshot())
            except BaseException as exc:
                errors.append(exc)
        def claim():
            started.set()
            try:
                new.handle({'type':'configure', 'enabled':True})
                sequence.append('claimed')
                claimed.set()
            except BaseException as exc:
                errors.append(exc)
        publisher = threading.Thread(target=publish)
        replacement = threading.Thread(target=claim)
        publisher.start()
        try:
            self.assertTrue(entered.wait(2))
            replacement.start()
            self.assertTrue(started.wait(2))
            self.assertFalse(claimed.wait(.05), 'replacement must not invalidate a checked in-flight owner')
        finally:
            release.set()
            publisher.join(3)
            if replacement.ident is not None:
                replacement.join(3)
        self.assertFalse(publisher.is_alive())
        self.assertFalse(replacement.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(sequence, ['published', 'claimed'])
        self.assertTrue(self.control.owns(self.state, new.ownership_token))
        self.assertEqual(self.masks, {}, 'claim revokes preceding port masks before new publication')


if __name__ == "__main__":
    unittest.main()
