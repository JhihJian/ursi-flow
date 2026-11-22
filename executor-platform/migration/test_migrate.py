import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4

from migrate import Refused, migrate


class Migration(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.src = Path(tmp.name) / 'work'
        self.dst = Path(tmp.name) / 'platform'
        self.src.mkdir(mode=0o700)
        (self.src / 'work.lock').touch()
        self.id, self.directory = str(uuid4()), str(uuid4())
        self.files = self.src / 'directories' / self.directory
        self.files.mkdir(parents=True)
        (self.files / 'AGENTS.md').write_text('approved', encoding='utf-8')
        (self.files / 'skills').mkdir()
        (self.files / 'mcp.json').write_text('{}')
        self.db = {'configPatches': {self.id: {'id': self.id, 'name': 'agent', 'directoryId': self.directory}},
                   'directories': {self.directory: {'id': self.directory, 'rules': {
                       'fixed': ['AGENTS.md', 'skills', 'mcp.json'], 'json_objects': ['mcp.json']}}},
                   'workPatches': {'private': {'name': 'business-only'}}}

    def save(self):
        (self.src / 'work.json').write_text(json.dumps(self.db))

    def test_export(self):
        self.save()
        source = (self.src / 'work.json').read_bytes()
        self.assertEqual(migrate(self.src, self.dst)['configPackages'], 1)
        self.assertFalse(self.dst.exists())
        migrate(self.src, self.dst, True)
        self.assertEqual(source, (self.src / 'work.json').read_bytes())
        self.assertEqual((self.dst / 'work.lock').read_bytes(), b'platform.json')
        self.assertEqual((self.dst / 'directories' / self.directory / 'AGENTS.md').read_text(), 'approved')
        self.assertNotIn('workPatches', json.loads((self.dst / 'platform.json').read_bytes()))
        with self.assertRaises(Refused):
            migrate(self.src, self.dst, True)

    def test_active_attempt(self):
        self.db['executorAttempts'] = {str(uuid4()): {'result': {'status': 'running'}}}
        self.save()
        with self.assertRaises(Refused):
            migrate(self.src, self.dst, True)
        self.assertFalse(self.dst.exists())

    def test_link(self):
        self.save()
        (self.files / 'skills' / 'bad').symlink_to(self.src / 'work.json')
        with self.assertRaises(Refused):
            migrate(self.src, self.dst, True)
        self.assertFalse(self.dst.exists())
