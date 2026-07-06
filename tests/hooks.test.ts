import { describe, expect, it } from 'vitest';
import {
  applyPiiRedaction,
  extractLastUserMessage,
  extractPromptFromMessages,
  extractResponseMetadata,
} from '../src/hooks';

describe('extractLastUserMessage', () => {
  it('finds a tuple-form human message', () => {
    const messages = [
      ['system', 'You are a helpful assistant.'],
      ['human', 'Hello there'],
    ];
    expect(extractLastUserMessage(messages)).toBe('Hello there');
  });

  it('finds an object-form user message', () => {
    const messages = [{ type: 'ai', content: 'ignored' }, { role: 'user', content: 'Hi' }];
    expect(extractLastUserMessage(messages)).toBe('Hi');
  });

  it('returns the most recent human message when there are several', () => {
    const messages = [
      ['human', 'first'],
      ['ai', 'reply'],
      ['human', 'second'],
    ];
    expect(extractLastUserMessage(messages)).toBe('second');
  });

  it('returns null when there is no human/user message', () => {
    expect(extractLastUserMessage([['system', 'x'], ['ai', 'y']])).toBeNull();
  });
});

describe('extractPromptFromMessages', () => {
  it('joins all human/user content with newlines', () => {
    const messages = [
      ['system', 'ignored'],
      ['human', 'line one'],
      ['ai', 'ignored'],
      ['human', 'line two'],
    ];
    expect(extractPromptFromMessages(messages)).toBe('line one\nline two');
  });

  it('extracts text parts from array-form content', () => {
    const messages = [
      { type: 'human', content: [{ type: 'text', text: 'part a' }, { type: 'image', url: 'x' }] },
    ];
    expect(extractPromptFromMessages(messages)).toBe('part a');
  });

  it('returns an empty string for non-array input', () => {
    expect(extractPromptFromMessages(null as unknown as unknown[])).toBe('');
  });
});

describe('applyPiiRedaction', () => {
  it('replaces the last tuple-form human message content in place', () => {
    const messages: unknown[] = [
      ['human', 'my email is a@b.com'],
    ];
    applyPiiRedaction(messages, [{ prompt: '[REDACTED]' }]);
    expect(messages[0]).toEqual(['human', '[REDACTED]']);
  });

  it('replaces the last object-form human message content in place', () => {
    const messages: unknown[] = [
      { type: 'human', content: 'my email is a@b.com' },
    ];
    applyPiiRedaction(messages, '[REDACTED]');
    expect((messages[0] as { content: string }).content).toBe('[REDACTED]');
  });

  it('is a no-op when redactedInput carries no usable text', () => {
    const messages: unknown[] = [['human', 'original']];
    applyPiiRedaction(messages, {});
    expect(messages[0]).toEqual(['human', 'original']);
  });
});

describe('extractResponseMetadata', () => {
  it('pulls model, token usage, and completion text off an AI message', () => {
    const response = {
      content: 'hello world',
      response_metadata: { model_name: 'gpt-4o' },
      usage_metadata: { input_tokens: 10, output_tokens: 5 },
      tool_calls: [],
    };
    expect(extractResponseMetadata(response)).toEqual({
      llm_model: 'gpt-4o',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      completion: 'hello world',
      has_tool_calls: false,
    });
  });

  it('unwraps a .message wrapper and joins array-form content', () => {
    const response = {
      message: {
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
        tool_calls: [{ name: 'search' }],
      },
    };
    const meta = extractResponseMetadata(response);
    expect(meta.completion).toBe('a b');
    expect(meta.has_tool_calls).toBe(true);
  });
});
