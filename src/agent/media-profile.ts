/** Select before prewarm; PCM is signed 16-bit little-endian mono, not RTP L16. */
export enum MediaProfile {
  MULAW_8000 = 'mulaw_8000',
  PCM_S16LE_16000 = 'pcm_s16le_16000',
}
const PROFILES = Object.freeze({
  [MediaProfile.MULAW_8000]: Object.freeze({sampleRate: 8000, frameBytes: 160, silenceByte: 0xff, encoding: 'audio/x-mulaw'}),
  [MediaProfile.PCM_S16LE_16000]: Object.freeze({sampleRate: 16000, frameBytes: 640, silenceByte: 0, encoding: 'audio/pcm;encoding=signed-integer;bits=16;endianness=little'}),
});
export function mediaContract(profile: MediaProfile) {
  const contract = PROFILES[profile];
  if (!contract) throw new Error('Unsupported media profile');
  return contract;
}
export function validateMediaFormat(profile: MediaProfile, format: Record<string, unknown>) {
  const expected = mediaContract(profile);
  if ((format['encoding'] ?? 'audio/x-mulaw') !== expected.encoding ||
      (format['sampleRate'] ?? 8000) !== expected.sampleRate || (format['channels'] ?? 1) !== 1) {
    throw new Error('Media format does not match selected profile');
  }
}
