import Anthropic from '@anthropic-ai/sdk';

const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

interface LLMCallOptions {
  system?: string;
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
}

interface LLMCallResult {
  content: Anthropic.ContentBlock[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costEstimate: number;
  model: string;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export async function callLLM(opts: LLMCallOptions, retries = 3): Promise<LLMCallResult> {
  const model = DEFAULT_MODEL;
  const start = Date.now();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const params: Anthropic.MessageCreateParams = {
        model,
        max_tokens: opts.maxTokens ?? 4096,
        messages: opts.messages,
      };
      if (opts.system) params.system = opts.system;
      if (opts.tools) params.tools = opts.tools;
      if (opts.toolChoice) params.tool_choice = opts.toolChoice;

      const response = await getClient().messages.create(params);
      const latencyMs = Date.now() - start;
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const costEstimate = (inputTokens / 1_000_000) * COST_PER_M_INPUT + (outputTokens / 1_000_000) * COST_PER_M_OUTPUT;

      console.log(JSON.stringify({
        llm_call: true, model,
        input_tokens: inputTokens, output_tokens: outputTokens,
        latency_ms: latencyMs, cost_estimate_usd: costEstimate.toFixed(6),
      }));

      return { content: response.content, inputTokens, outputTokens, latencyMs, costEstimate, model };
    } catch (err: any) {
      if (attempt < retries && (err?.status === 429 || err?.status === 529 || err?.status >= 500)) {
        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000);
        console.warn(`LLM call attempt ${attempt + 1} failed (${err?.status}), retrying in ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('LLM call failed after retries');
}

export function extractTextFromResponse(result: LLMCallResult): string {
  for (const block of result.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

export function extractToolUseFromResponse(result: LLMCallResult): any {
  for (const block of result.content) {
    if (block.type === 'tool_use') return block.input;
  }
  return null;
}

export { DEFAULT_MODEL };
export type { LLMCallOptions, LLMCallResult };
