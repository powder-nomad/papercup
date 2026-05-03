// Roll-up barrel for the voice + extension stack. Most consumers should
// prefer the named subpath imports (`@papercup/voice-stack/vad`, etc.) for
// clearer dependency tracking and tree-shaking, but this gives you a single
// import surface when you really want it.

export { SileroVad } from "./vad/silero.js";
export { WhisperSidecar } from "./stt/whisper.js";
export { createTts } from "./tts/index.js";
export type { TtsEngine, SynthesisResult } from "./tts/index.js";
export { stereo48kS16ToMono16kF32 } from "./audio/resample.js";
export { mono24kS16ToStereo48kS16 } from "./audio/upsample.js";
export { ExtensionManager } from "./extensions/manager.js";
export type { Extension, ExtensionStatus } from "./extensions/manager.js";
export { ExtensionMcpServer } from "./extensions/mcp-server.js";
