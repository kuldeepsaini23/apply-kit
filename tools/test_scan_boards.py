"""Run: python -m unittest tools/test_scan_boards.py"""
import importlib.util, pathlib, unittest

spec = importlib.util.spec_from_file_location("scan", pathlib.Path(__file__).with_name("scan-boards.py"))
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)

job = lambda loc, title="Software Engineer": {"title": title, "location": loc}


class Fits(unittest.TestCase):
    def test_india_and_open_remote_kept(self):
        for loc in ["Bengaluru", "Remote", "Remote (Global)", "Remote, Global", "Remote - India", "Remote, APAC", "Anywhere", "Gurugram / Remote", "Bengaluru / San Francisco"]:
            self.assertTrue(scan.fits(job(loc)), loc)

    def test_remote_tied_to_another_country_dropped(self):
        for loc in ["Remote - Ireland", "Remote, Poland", "Remote (Spain)", "Remote - Brazil", "Remote US", "Remote - EMEA", "Remote / Australia", "Asia | South Korea"]:
            self.assertFalse(scan.fits(job(loc)), loc)


if __name__ == "__main__":
    unittest.main()
