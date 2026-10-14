"""Tests for export_session.py redaction.  Run: /usr/bin/python3 -I scripts/test_export_session.py"""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('export_session', HERE / 'export_session.py')
ex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ex)


class Credentials(unittest.TestCase):
    def gone(self, text, *secrets):
        out = ex.redact(text)
        for s in secrets:
            self.assertNotIn(s, out, out)
        return out

    def test_json_secret_keys(self):
        for key in ('password', 'pass', 'pin', 'passwd', 'secret', 'token', 'Password',
                    'camera_password', 'api_key'):
            out = self.gone(f'{{"{key}": "s3cr3t-value", "user": "admin"}}', 's3cr3t-value')
            self.assertIn('"user": "admin"', out)
            self.assertIn('REDACTED', out)

    def test_json_value_with_escaped_quote(self):
        self.gone('{"password": "ab\\"cd-tail9"}', 'tail9')

    def test_escaped_json(self):
        self.gone('x = "{\\"password\\": \\"hunter22\\", \\"a\\": 1}"', 'hunter22')

    def test_authorization_headers(self):
        self.gone('Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNz')
        self.gone('Authorization: Bearer abc123def456', 'abc123def456')
        self.gone('-H "Authorization: Bearer abc123def456"', 'abc123def456')
        out = self.gone('Authorization: Digest username="bob", realm="x", nonce="n0nce9", '
                        'response="r3sp0nse"', 'bob', 'n0nce9', 'r3sp0nse')
        self.assertIn('Digest REDACTED', out)

    def test_bearer_anywhere(self):
        self.gone('curl with Bearer 9f8e7d6c5b4a3921 now', '9f8e7d6c5b4a3921')

    def test_tokens_block_keys(self):
        text = '{"auth": {"tokens": {"a1b2c3d4e5f6": "operator", "ffee00112233": "viewer"}}}'
        out = self.gone(text, 'a1b2c3d4e5f6', 'ffee00112233')
        self.assertIn('operator', out)
        self.assertIn('viewer', out)
        self.gone('{\\"tokens\\": {\\"a1b2c3d4e5f6\\": \\"operator\\"}}', 'a1b2c3d4e5f6')

    def test_url_userinfo(self):
        out = self.gone('rtsp://admin:p@ss:w0rd@10.0.0.5/stream and http://u:pw1@host/x',
                        'p@ss', 'w0rd', 'pw1')
        self.assertIn('@10.0.0.5/stream', out)

    def test_raw_dict_keys_and_values(self):
        rec = {'auth': {'tokens': {'a1b2c3d4e5f6': 'operator'}}, 'password': 'hunter2', 'n': 1}
        out = json.dumps(ex.redact_deep(rec))
        self.assertNotIn('a1b2c3d4e5f6', out)
        self.assertNotIn('hunter2', out)
        self.assertIn('operator', out)

    def test_negative_ordinary_prose(self):
        for text in (
            'The password field is hidden in the panel.',
            'Set a PIN to protect it; tokens are listed in the config.',
            'Bearer authentication is supported. Bearer tokens too.',
            'Authorization header is optional.',
            'See https://example.org/docs for details',
            '"pin": 4, "max_tokens": 100',
            'uses ${TOKEN} here',
        ):
            self.assertEqual(ex.redact(text), text)

    def test_existing_rules_still_work(self):
        out = ex.redact('/Users/jane/x 172.16.16.9 a@b.com')
        self.assertEqual(out, '/Users/OPERATOR/x 192.0.2.9 REDACTED@EXAMPLE.COM')

    def test_no_redact_flag(self):
        self.assertEqual(ex.redact('{"password": "x"}', enabled=False), '{"password": "x"}')
        rec = {'password': 'x'}
        self.assertEqual(ex.redact_deep(rec, enabled=False), rec)

    def test_cli_no_redact(self):
        record = {'type': 'user',
                  'message': {'role': 'user', 'content': 'cfg {"password": "hunter2"}'}}
        with tempfile.TemporaryDirectory() as d:
            src = pathlib.Path(d, 't.jsonl')
            src.write_text(json.dumps(record) + '\n')
            for flag, expect in (([], False), (['--no-redact'], True)):
                out = pathlib.Path(d, 'o' + str(expect))
                subprocess.run([sys.executable, '-I', str(HERE / 'export_session.py'),
                                str(src), str(out), '--no-images', *flag],
                               check=True, capture_output=True)
                for name in ('transcript.md', 'session.jsonl'):
                    self.assertEqual('hunter2' in (out / name).read_text(), expect, name)


if __name__ == '__main__':
    unittest.main()
