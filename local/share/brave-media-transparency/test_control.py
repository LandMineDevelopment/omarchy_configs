import importlib.util
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch
import json
import os
spec=importlib.util.spec_from_file_location('control',Path(__file__).with_name('control.py'))
control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
class FlagsTest(unittest.TestCase):
 def test_preserves_existing_extensions_and_other_flags(self):
  text='# mine\n--load-extension=/one,/two\n--restore-last-session\n'
  installed=control.extension_flags(text,True)
  self.assertIn('--load-extension=/one,/two,'+str(control.EXTENSION),installed)
  self.assertEqual(control.extension_flags(installed,False),text)
 def test_repeated_install_does_not_duplicate(self):
  a=control.extension_flags('--foo\n',True)
  self.assertEqual(control.extension_flags(a,True),a)
 def test_uninstall_preserves_later_user_changes(self):
  a=control.extension_flags('--load-extension=/one\n',True)+'--my-new-flag\n'
  self.assertEqual(control.extension_flags(a,False),'--load-extension=/one\n--my-new-flag\n')
 def test_uninstall_only_trial_line(self):
  self.assertEqual(control.extension_flags('--foo\n--load-extension='+str(control.EXTENSION)+'\n',False),'--foo\n')
class LifecycleTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory()
  self.addCleanup(self.tmp.cleanup)
  self.state=Path(self.tmp.name)/'session.json'
  self.calls=[]
  self.present=False
 def ctl(self,*args):
  self.calls.append(args)
  if args==('-j','version'):return json.dumps({'commit':control.COMMIT})
  if args[:2]==('plugin','load'):self.present=True
  if args[:2]==('plugin','unload'):self.present=False
  return 'ok'
 def test_enable_is_idempotent_and_disable_unloads_owned_plugin(self):
  with patch.object(control,'ctl',self.ctl),patch.object(control,'loaded',lambda:self.present):
   control.turn_on(self.state)
   control.turn_on(self.state)
   self.assertTrue(control.owns(self.state))
   self.assertEqual(sum(c[:2]==('plugin','load') for c in self.calls),1)
   control.turn_off(self.state)
   self.assertFalse(self.state.exists())
   self.assertFalse(self.present)
   self.assertIn(('eval','hl.plugin.HyprWindowShade.mediareset("all")'),self.calls)
 def test_explicit_working_session_does_not_require_socket_filename(self):
  runtime=Path(self.tmp.name)
  with patch.dict(os.environ,{'XDG_RUNTIME_DIR':str(runtime),'HYPRLAND_INSTANCE_SIGNATURE':'long-but-valid'},clear=False),patch.object(control,'ctl',return_value=json.dumps({'commit':control.COMMIT})) as ctl:
   self.assertEqual(control.state_path(),runtime/'brave-media-transparency/long-but-valid.json')
   ctl.assert_called_once_with('-j','version')
 def test_ambiguous_or_missing_session_fails(self):
  with patch.dict(os.environ,{'XDG_RUNTIME_DIR':self.tmp.name,'HYPRLAND_INSTANCE_SIGNATURE':''},clear=False),patch.object(control,'ctl',return_value='[]'),self.assertRaises(RuntimeError):
   control.state_path()
 def test_version_mismatch_never_loads(self):
  with patch.object(control,'ctl',return_value=json.dumps({'commit':'new-version'})),self.assertRaises(RuntimeError):
   control.turn_on(self.state)
  self.assertFalse(self.state.exists())
 def test_unowned_loaded_plugin_is_untouched(self):
  with patch.object(control,'ctl',self.ctl),patch.object(control,'loaded',return_value=True):
   with self.assertRaises(RuntimeError):control.turn_on(self.state)
   control.turn_off(self.state)
  self.assertEqual(self.calls,[('-j','version')])
 def test_shader_failure_rolls_back_loaded_plugin(self):
  def failing(*args):
   if args[0]=='eval' and 'classshader' in args[-1] and 'clear' not in args[-1]:
    raise RuntimeError('shader failed')
   return self.ctl(*args)
  with patch.object(control,'ctl',failing),patch.object(control,'loaded',lambda:self.present):
   with self.assertRaises(RuntimeError):control.turn_on(self.state)
  self.assertFalse(self.state.exists())
  self.assertFalse(self.present)
 def test_corrupt_ownership_state_never_unloads(self):
  self.state.write_text(json.dumps({'plugin':'some-other-plugin'}))
  with patch.object(control,'ctl',self.ctl),self.assertRaises(RuntimeError):
   control.turn_off(self.state)
  self.assertEqual(self.calls,[])
 def test_replacement_port_claim_revokes_old_masks_and_ignores_old_disable(self):
  old,new='a'*32,'b'*32
  with patch.object(control,'ctl',self.ctl),patch.object(control,'loaded',lambda:self.present),patch.object(control,'state_path',return_value=self.state):
   control.configure(True,owner=old)
   control.configure(True,owner=new,state=self.state)
   before=list(self.calls)
   control.configure(False,owner=old,state=self.state)
   self.assertEqual(self.calls,before)
   self.assertTrue(control.owns(self.state,new))
   self.assertFalse(control.owns(self.state,old))
   self.assertTrue(self.present)
   self.assertEqual(sum(c==('eval','hl.plugin.HyprWindowShade.mediareset("all")') for c in self.calls),2)
   control.configure(False,owner=new,state=self.state)
   self.assertFalse(self.present)
   self.assertFalse(self.state.exists())
 def test_cli_control_can_disable_the_current_port_unconditionally(self):
  with patch.object(control,'ctl',self.ctl),patch.object(control,'loaded',lambda:self.present),patch.object(control,'state_path',return_value=self.state):
   control.configure(True,owner='a'*32)
   control.configure(False)
   self.assertFalse(self.present)
   self.assertFalse(self.state.exists())
 def test_legacy_state_is_owned_by_installation_but_not_a_port(self):
  self.state.write_text(json.dumps({'plugin':str(control.PLUGIN)}))
  self.assertTrue(control.owns(self.state))
  self.assertFalse(control.owns(self.state,'a'*32))
 def test_corrupt_port_token_or_extra_keys_never_unload(self):
  for owner in ('', 'a'*31, 'g'*32, None, 123):
   with self.subTest(owner=owner):
    self.state.write_text(json.dumps({'plugin':str(control.PLUGIN),'owner':owner}))
    with patch.object(control,'ctl',self.ctl),self.assertRaises(RuntimeError):
     control.configure(False,state=self.state)
  self.state.write_text(json.dumps({'plugin':str(control.PLUGIN),'owner':'a'*32,'extra':True}))
  with patch.object(control,'ctl',self.ctl),self.assertRaises(RuntimeError):
   control.configure(False,state=self.state)
  self.assertEqual(self.calls,[])
if __name__=='__main__':unittest.main()
