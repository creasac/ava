# Third-party notices

## Pocket TTS

Pocket TTS was created by Kyutai. The Pocket TTS model weights are licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) and are downloaded from [KevinAHM/pocket-tts-onnx revision `58a6d00`](https://huggingface.co/KevinAHM/pocket-tts-onnx/commit/58a6d00cf13d239b6748cb0769f35c580a8f606c). ava does not claim endorsement by Kyutai.

The browser inference worker and streaming worklet are adapted from [KevinAHM/pocket-tts-web revision `d0c0c79`](https://huggingface.co/spaces/KevinAHM/pocket-tts-web/commit/d0c0c79b7712256a32d691c67f20b8ae2e020d00), licensed under Apache License 2.0. ava changes include revision-pinned remote model caching, automatic native voices for five language bundles, omission of the voice-cloning encoder, bounded current-reading retention, and direct Float32 streaming to an AudioWorklet. A copy of the Apache license is provided at `pocket/Apache-2.0-LICENSE.txt`.

The predefined voice states are downloaded from [Kyutai's no-voice-cloning model revision `e041936`](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/commit/e041936c75475d350b405bc870bcf7c22da4e9e6), licensed under Creative Commons Attribution 4.0.

The vendored `pocket/sentencepiece.js` retains its embedded third-party copyright and license notices.

## ONNX Runtime Web

ava loads [ONNX Runtime Web 1.20.0](https://www.npmjs.com/package/onnxruntime-web/v/1.20.0) from jsDelivr. ONNX Runtime is licensed under the [MIT License](https://github.com/microsoft/onnxruntime/blob/v1.20.0/LICENSE).
