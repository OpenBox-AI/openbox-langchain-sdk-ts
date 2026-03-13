/**
 * OpenBox LangChain SDK — Streaming Token Buffer (Phase 3)
 *
 * Accumulates streamed LLM tokens per run_id so that governance can evaluate
 * the full completion once streaming ends (handleLLMEnd fires with the full
 * LLMResult even for streaming models in LangChain >= 0.2).
 *
 * This module provides a per-run token accumulator that the callback handler
 * can use to build rich streaming telemetry.
 */

export interface StreamingBuffer {
  runId: string;
  tokens: string[];
  startTime: number;
  model?: string;
}

export class StreamingTokenBuffer {
  private readonly buffers = new Map<string, StreamingBuffer>();

  start(runId: string, model?: string): void {
    this.buffers.set(runId, {
      runId,
      tokens: [],
      startTime: Date.now(),
      model,
    });
  }

  addToken(runId: string, token: string): void {
    const buf = this.buffers.get(runId);
    if (buf) buf.tokens.push(token);
  }

  getAccumulated(runId: string): string {
    return this.buffers.get(runId)?.tokens.join("") ?? "";
  }

  getBuffer(runId: string): StreamingBuffer | undefined {
    return this.buffers.get(runId);
  }

  clear(runId: string): void {
    this.buffers.delete(runId);
  }

  get size(): number {
    return this.buffers.size;
  }
}

export const globalStreamingBuffer = new StreamingTokenBuffer();
