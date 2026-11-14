import assert from "node:assert/strict";
import test from "node:test";
import { getImageMime, getAudioMime, getDocumentMime } from "./file-types.ts";

test("MIME lookup only accepts explicitly mapped extensions", () => {
  assert.equal(getImageMime("image.png"), "image/png");
  assert.equal(getAudioMime("audio.mp3"), "audio/mpeg");
  assert.equal(getDocumentMime("manual.pdf"), "application/pdf");
  for (const ext of ["constructor", "__proto__", "toString", "valueOf"]) {
    assert.equal(getImageMime("file." + ext), null);
    assert.equal(getAudioMime("file." + ext), null);
    assert.equal(getDocumentMime("file." + ext), null);
  }
});
