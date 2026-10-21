import { describe, expect, it } from 'vitest';
import { toOpenAIWireMessages } from '../src/provider/openai.js';
import { toAnthropicWireMessages } from '../src/provider/anthropic.js';
import type { ChatMessage } from '../src/provider/types.js';

const parts: ChatMessage['parts'] = [
  { type: 'text', text: '看图' },
  { type: 'image', mimeType: 'image/png', dataBase64: 'AAAA' },
];

describe('provider content parts (ZS3.5)', () => {
  it('maps user parts to OpenAI image_url content array', () => {
    const wire = toOpenAIWireMessages([{ role: 'user', content: '看图', parts }]) as Array<{
      content: unknown;
    }>;
    expect(wire[0]?.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('keeps string content when parts are absent', () => {
    const wire = toOpenAIWireMessages([{ role: 'user', content: 'hi' }]) as Array<{
      content: unknown;
    }>;
    expect(wire[0]?.content).toBe('hi');
  });

  it('maps user parts to Anthropic text + image blocks', () => {
    const wire = toAnthropicWireMessages([{ role: 'user', content: '看图', parts }]) as Array<{
      content: unknown;
    }>;
    expect(wire[0]?.content).toEqual([
      { type: 'text', text: '看图' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
    ]);
  });
});
