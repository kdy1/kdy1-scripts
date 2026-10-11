import importlib.util
from pathlib import Path
import tempfile
import unittest


def module(filename):
    spec = importlib.util.spec_from_file_location(filename.replace('-', '_'), Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


installer = module('prepare-claude-skills.py')
validator = module('validate-skill.py')


class SkillToolsTest(unittest.TestCase):
    def test_complete_copy_and_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / '.claude/skills'
            paths = installer.prepare(destination)
            self.assertEqual({Path(p).name for p in paths}, set(installer.SKILLS))
            validator.validate(destination / 'slop-fix-batch')
            self.assertTrue((destination / 'repair-pr/scripts/stack-coordination.mjs').is_file())
            with self.assertRaisesRegex(ValueError, 'already exists'):
                installer.prepare(destination)

    def test_conflict_in_last_dependency_prevents_any_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            sentinel = destination / installer.SKILLS[-1]
            sentinel.write_text('user content')
            with self.assertRaisesRegex(ValueError, 'already exists'):
                installer.prepare(destination)
            self.assertEqual(list(destination.iterdir()), [sentinel])
            self.assertEqual(sentinel.read_text(), 'user content')

    def test_dangling_link_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            link = destination / installer.SKILLS[0]
            link.symlink_to(destination / 'absent')
            with self.assertRaisesRegex(ValueError, 'already exists'):
                installer.prepare(destination)
            self.assertTrue(link.is_symlink())

    def test_missing_dependency_prevents_partial_install(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source'
            source.mkdir()
            destination = Path(directory) / 'destination'
            with self.assertRaisesRegex(ValueError, 'Missing dependency'):
                installer.prepare(destination, source)
            self.assertFalse(destination.exists())

    def test_metadata_rejects_implicit_invocation_in_either_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            installer.prepare(destination)
            skill = destination / 'slop-fix-batch'
            entry = skill / 'SKILL.md'
            original = entry.read_text()
            entry.write_text(original.replace('disable-model-invocation: true', 'disable-model-invocation: false'))
            with self.assertRaisesRegex(ValueError, 'Claude invocation'):
                validator.validate(skill)
            entry.write_text(original)
            policy = skill / 'agents/openai.yaml'
            policy.write_text(policy.read_text().replace('allow_implicit_invocation: false', 'allow_implicit_invocation: true'))
            with self.assertRaisesRegex(ValueError, 'Codex invocation'):
                validator.validate(skill)


if __name__ == '__main__':
    unittest.main()
