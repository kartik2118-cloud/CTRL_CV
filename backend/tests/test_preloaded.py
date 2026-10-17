"""
Unit tests for preloaded video transcript and lyrics module.
"""
import unittest
from app.preloaded import get_preloaded_segments, normalize_video_id, PRELOADED_VIDEOS


class TestPreloadedVideos(unittest.TestCase):
    def test_normalize_video_id(self):
        self.assertEqual(normalize_video_id("dQw4w9WgXcQ"), "dQw4w9WgXcQ")
        self.assertEqual(normalize_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ")
        self.assertEqual(normalize_video_id("https://youtu.be/dQw4w9WgXcQ?t=10"), "dQw4w9WgXcQ")
        self.assertIsNone(normalize_video_id(None))

    def test_rick_astley_verse_1(self):
        # 18.5 - 22.8: "We're no strangers to love"
        segs = get_preloaded_segments("dQw4w9WgXcQ", chunk_start=18.5, duration=2.5, target_lang="hi")
        self.assertIsNotNone(segs)
        self.assertGreaterEqual(len(segs), 1)
        first = segs[0]
        self.assertEqual(first["text"], "We're no strangers to love")
        self.assertEqual(first["translation"], "हम प्यार से अनजान नहीं हैं")

    def test_rick_astley_chorus_marathi(self):
        # 43.2 - 47.3: "Never gonna give you up, never gonna let you down"
        segs = get_preloaded_segments("dQw4w9WgXcQ", chunk_start=43.5, duration=2.5, target_lang="mr")
        self.assertIsNotNone(segs)
        first = segs[0]
        self.assertIn("Never gonna give you up", first["text"])
        self.assertEqual(first["translation"], "तुला कधीही सोडणार नाही, कधीही निराश करणार नाही")

    def test_unregistered_video_returns_none(self):
        segs = get_preloaded_segments("some_random_id_123", chunk_start=10.0, duration=2.5)
        self.assertIsNone(segs)


if __name__ == "__main__":
    unittest.main()
