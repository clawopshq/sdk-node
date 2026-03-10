import { describe, it, expect } from 'vitest';
import type { STT, TTS, LLM, SpeechEvent, LLMChunk, Session } from '../../src/agent/pipeline/base.js';

/**
 * Tests for base pipeline interfaces – verifying that custom implementations
 * can satisfy the STT, TTS, LLM, and Session protocols.
 */

describe('Pipeline base interfaces', () => {
  describe('STT protocol compliance', () => {
    it('accepts a custom STT implementation with transcribe()', () => {
      const customSTT: STT = {
        async *transcribe(
          _audioStream: AsyncIterable<Buffer>,
          _options?: { language?: string; sampleRate?: number },
        ): AsyncGenerator<SpeechEvent> {
          yield { type: 'interim', transcript: 'hello' };
          yield { type: 'final', transcript: 'hello world' };
        },
      };
      expect(customSTT.transcribe).toBeInstanceOf(Function);
    });

    it('custom STT yields correct SpeechEvent shapes', async () => {
      const customSTT: STT = {
        async *transcribe() {
          yield { type: 'interim', transcript: 'part' };
          yield { type: 'final', transcript: 'partial result' };
        },
      };

      const events: SpeechEvent[] = [];
      const fakeStream = (async function* () {
        yield Buffer.from('audio');
      })();

      for await (const ev of customSTT.transcribe(fakeStream)) {
        events.push(ev);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'interim', transcript: 'part' });
      expect(events[1]).toEqual({ type: 'final', transcript: 'partial result' });
    });
  });

  describe('TTS protocol compliance', () => {
    it('accepts a custom TTS implementation with synthesize()', () => {
      const customTTS: TTS = {
        async *synthesize(
          _text: string | AsyncIterable<string>,
          _options?: { voice?: string; sampleRate?: number },
        ): AsyncGenerator<Buffer> {
          yield Buffer.from('audio-chunk');
        },
      };
      expect(customTTS.synthesize).toBeInstanceOf(Function);
    });

    it('custom TTS yields Buffer chunks', async () => {
      const customTTS: TTS = {
        async *synthesize(text: string | AsyncIterable<string>) {
          if (typeof text === 'string') {
            yield Buffer.from(text);
          }
        },
      };

      const chunks: Buffer[] = [];
      for await (const chunk of customTTS.synthesize('hello')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].toString()).toBe('hello');
    });

    it('TTS synthesize accepts AsyncIterable<string> input', async () => {
      const customTTS: TTS = {
        async *synthesize(text: string | AsyncIterable<string>) {
          if (typeof text !== 'string') {
            for await (const chunk of text) {
              yield Buffer.from(chunk);
            }
          }
        },
      };

      const textStream = (async function* () {
        yield 'hello ';
        yield 'world';
      })();

      const chunks: Buffer[] = [];
      for await (const chunk of customTTS.synthesize(textStream)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
    });
  });

  describe('LLM protocol compliance', () => {
    it('accepts a custom LLM implementation with generate()', () => {
      const customLLM: LLM = {
        async *generate(): AsyncGenerator<LLMChunk> {
          yield { type: 'text', text: 'hello' };
          yield { type: 'done' };
        },
      };
      expect(customLLM.generate).toBeInstanceOf(Function);
    });

    it('custom LLM yields text and done chunks', async () => {
      const customLLM: LLM = {
        async *generate() {
          yield { type: 'text', text: 'Hi ' };
          yield { type: 'text', text: 'there' };
          yield { type: 'done' };
        },
      };

      const chunks: LLMChunk[] = [];
      for await (const chunk of customLLM.generate([])) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'text', text: 'Hi ' });
      expect(chunks[2]).toEqual({ type: 'done' });
    });

    it('custom LLM can yield tool_call chunks', async () => {
      const customLLM: LLM = {
        async *generate() {
          yield {
            type: 'tool_call',
            toolCall: { id: 'tc1', name: 'search', arguments: '{"q":"test"}' },
          };
          yield { type: 'done' };
        },
      };

      const chunks: LLMChunk[] = [];
      for await (const chunk of customLLM.generate([])) {
        chunks.push(chunk);
      }

      expect(chunks[0].type).toBe('tool_call');
      expect(chunks[0].toolCall!.name).toBe('search');
    });
  });

  describe('Session protocol compliance', () => {
    it('accepts a custom Session implementation', () => {
      const customSession: Session = {
        async start() {},
        feedAudio(_audio: Buffer) {},
        async stop() {},
      };

      expect(customSession.start).toBeInstanceOf(Function);
      expect(customSession.feedAudio).toBeInstanceOf(Function);
      expect(customSession.stop).toBeInstanceOf(Function);
    });
  });
});
