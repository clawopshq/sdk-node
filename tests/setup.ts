// Test environment defaults — provider keys must be present for Realtime
// session constructors that fail-fast on missing keys.
process.env['OPENAI_API_KEY'] ??= 'test-openai-key';
