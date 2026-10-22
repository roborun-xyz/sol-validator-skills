import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sfdp', Path(__file__).parents[1] / 'scripts/check_sfdp.py')
sfdp = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = sfdp
spec.loader.exec_module(sfdp)

KEYS = {'mainnetBetaPubkey': '11111111111111111111111111111111',
        'testnetPubkey': 'So11111111111111111111111111111111111111112'}

def fleet():
    return {'version': 1, 'groups': {'example': KEYS}, 'hosts': []}

class FleetTests(unittest.TestCase):
    def load(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fleet.json'
            path.write_text(json.dumps(data))
            return sfdp.load_fleet(str(path))

    def test_pairs_must_match_both_identities(self):
        wrong = {**KEYS, 'testnetPubkey': KEYS['mainnetBetaPubkey'], 'state': 'Approved'}
        self.assertIsNone(sfdp.find_participant([wrong], KEYS))
        right = {**KEYS, 'state': 'Approved'}
        self.assertEqual(sfdp.find_participant([right], KEYS), right)
        with self.assertRaisesRegex(RuntimeError, 'Ambiguous'):
            sfdp.find_participant([right, right], KEYS)

    def test_fleet_validation_and_no_private_default(self):
        self.assertEqual(self.load(fleet()), ({'example': KEYS}, []))
        for data in [{}, {**fleet(), 'version': True}, {**fleet(), 'rpcUrl': 'secret'}, {**fleet(), 'groups': {}},
                     {**fleet(), 'groups': {'example': {**KEYS, 'testnetPubkey': ['bad']}}}]:
            with self.assertRaises(ValueError): self.load(data)
        with self.assertRaisesRegex(ValueError, 'ONBOARDING_REQUIRED'):
            sfdp.load_fleet('/nonexistent/sfdp-test.json')

    def test_ssh_option_injection_and_identity_drift_rejected(self):
        host = dict(group='example', cluster='mainnet-beta', host='my-validator', rpc_port=8899,
                    client='agave', expected_identity=KEYS['mainnetBetaPubkey'], vote_account='', role='primary')
        self.assertEqual(len(self.load({**fleet(), 'hosts': [host]})[1]), 1)
        self.assertEqual(self.load({**fleet(), 'hosts': [{**host, 'client': 'firedancer-full'}]})[1][0].client, 'firedancer-full')
        for patch_fields in [{'host': '-oProxyCommand=evil'}, {'rpc_port': True},
                             {'expected_identity': KEYS['testnetPubkey']}, {'client': 'typo'}, {'client': 'frankendancer'}]:
            with self.assertRaises(ValueError): self.load({**fleet(), 'hosts': [{**host, **patch_fields}]})

    def test_empty_requirements_do_not_pass(self):
        with patch.object(sfdp, 'load_fleet', return_value=({'example': KEYS}, [])), \
             patch.object(sfdp, 'fetch_json', return_value={'data': []}):
            with self.assertRaisesRegex(RuntimeError, 'required-version'):
                sfdp.collect(argparse.Namespace(fleet='fixture',api_only=True,timeout=1,current_only=False))
        self.assertFalse(sfdp.check_version('3.0.0', {}, 'agave')[0])

    def test_malformed_versions_cannot_pass(self):
        for version in ['unknown', '', '3.x.0', '3.0.0 garbage', None]:
            with self.assertRaises(ValueError): sfdp.compare_versions(version, '3.0.0')
        self.assertEqual(sfdp.compare_versions('3.0.0+build.1','3.0.0'), 0)

    def test_version_boundaries_and_prerelease(self):
        requirement = {'agave_min_version': '3.0.0', 'agave_max_version': '3.1.0'}
        for version in ['3.0.0','3.1.0']: self.assertTrue(sfdp.check_version(version,requirement,'agave')[0])
        for version in ['3.0.0-rc.1','3.1.1']: self.assertFalse(sfdp.check_version(version,requirement,'agave')[0])

def mainnet_rows():
    base = {'cluster': 'mainnet-beta', 'agave_min_version': '4.3.2', 'agave_max_version': None,
            'firedancer_min_version': '0.1300.0', 'firedancer_max_version': None,
            'firedancer_full_max_version': None, 'inherited_from_prev_epoch': False}
    return [{**base, 'epoch': epoch, 'firedancer_full_min_version': '26.10.2' if epoch < 1067 else '26.10.4'}
            for epoch in (1064, 1065, 1066, 1067)]

class FullFiredancerTests(unittest.TestCase):
    def run_live(self, client, version, current_only=False):
        host = sfdp.ValidatorCheck(group='example', cluster='mainnet-beta', host='primary', rpc_port=8899,
                                   client=client, expected_identity=KEYS['mainnetBetaPubkey'],
                                   vote_account='', role='primary')
        def fetch(url, timeout):
            if 'participants' in url:
                return [{**KEYS, 'state': 'Approved'}]
            return {'data': mainnet_rows() if 'mainnet-beta' in url else [{**mainnet_rows()[0], 'cluster': 'testnet'}]}
        answers = {'getHealth': 'ok', 'getIdentity': {'identity': KEYS['mainnetBetaPubkey']},
                   'getVersion': {'solana-core': version}}
        with patch.object(sfdp, 'load_fleet', return_value=({'example': KEYS}, [host])), \
             patch.object(sfdp, 'fetch_json', side_effect=fetch), \
             patch.object(sfdp, 'ssh_rpc', side_effect=lambda h, p, method, t: answers[method]):
            return sfdp.collect(argparse.Namespace(fleet='fixture', api_only=False, timeout=1, current_only=current_only))

    def test_full_firedancer_uses_full_bounds_and_sees_upcoming_bump(self):
        data = self.run_live('firedancer-full', '26.10.3')
        check = data['checks'][0]
        self.assertEqual({r['epoch']: r['passed'] for r in check['requirements']},
                         {1064: True, 1065: True, 1066: True, 1067: False})
        self.assertEqual(check['requirements'][-1]['min_version'], '26.10.4')
        self.assertFalse(check['ok'])
        self.assertTrue(sfdp.has_failures(data, False))
        self.assertEqual(data['requirement_changes']['mainnet-beta'],
                         [{'epoch': 1067, 'changes': {'firedancer_full_min_version': {'from': '26.10.2', 'to': '26.10.4'}}}])

    def test_current_only_reports_upcoming_failure_without_enforcing(self):
        check = self.run_live('firedancer-full', '26.10.3', current_only=True)['checks'][0]
        self.assertTrue(check['ok'])
        upcoming = check['requirements'][-1]
        self.assertEqual((upcoming['epoch'], upcoming['passed'], upcoming['enforced']), (1067, False, False))
        self.assertTrue(self.run_live('firedancer-full', '26.10.4', current_only=True)['checks'][0]['ok'])

    def test_frankendancer_client_with_calver_version_does_not_silently_pass(self):
        data = self.run_live('firedancer', '26.10.3', current_only=True)
        check = data['checks'][0]
        self.assertTrue(all(r['passed'] for r in check['requirements']))  # 26.10.3 >= 0.1300.0
        self.assertFalse(check['ok'])
        self.assertRegex(check['warnings'][0], 'firedancer-full')
        self.assertTrue(sfdp.has_failures(data, False))
        self.assertTrue(self.run_live('firedancer', '0.1300.1')['checks'][0]['ok'])

    def test_full_client_validation_and_bounds(self):
        self.assertEqual(sfdp.client_bounds(mainnet_rows()[3], 'firedancer-full'), ('26.10.4', None))
        self.assertEqual(sfdp.client_bounds(mainnet_rows()[3], 'firedancer'), ('0.1300.0', None))
        self.assertFalse(sfdp.check_version('26.10.3', {'firedancer_min_version': '0.1300.0'}, 'firedancer-full')[0])
        self.assertIsNotNone(sfdp.client_mismatch_warning('0.1300.0', 'firedancer-full'))
        self.assertIsNone(sfdp.client_mismatch_warning('4.3.2', 'jito-agave'))

if __name__ == '__main__': unittest.main()
