import { type ModelChunk, type ModelProvider, type ModelRequest, type ModelResponse, type ToolCall } from '@agentforge-oss/core';

/**
 * A minimal deterministic ModelProvider for examples and local demos —
 * with optional scripted tool calls. Define it in your own code:
 * @agentforge-oss/models no longer ships a built-in mock, because agents
 * should never fake intelligence by default.
 */
export class ScriptedModel implements ModelProvider {
  readonly provider = 'scripted';
  readonly model = 'scripted-1';
  private index = 0;
  constructor(private readonly steps: Array<{ content?: string; toolCalls?: ToolCall[] }> = []) {}
  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const step = this.steps[this.index % this.steps.length] ?? { content: 'scripted reply' };
    const content = step.content ?? '';
    const toolCalls = step.toolCalls;
    this.index += 1;
    return { id: `scripted-${this.index}`, content, toolCalls, finishReason: toolCalls?.length ? 'tool_calls' : 'stop', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const response = await this.generate(request);
    for (const token of response.content.split(/(\s+)/)) yield { id: response.id, delta: token };
    yield { id: response.id, delta: '', done: true, usage: response.usage };
  }
}
