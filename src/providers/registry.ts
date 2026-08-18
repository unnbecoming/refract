import type { ApiSurface } from '../config.js';
import { parseAnthropicRequest, parseAnthropicResponse, AnthropicStreamParser } from './anthropic.js';
import { parseOpenAIChatRequest, parseOpenAIChatResponse, OpenAIChatStreamParser } from './openai-chat.js';
import { parseOpenAIResponsesRequest, parseOpenAIResponsesResponse, OpenAIResponsesStreamParser } from './openai-responses.js';
import type { ParsedProviderRequest, ParsedProviderResponse, ProviderStreamParser } from './types.js';

export function parseProviderRequest(surface: ApiSurface, body: unknown): ParsedProviderRequest {
  if (surface === 'messages') return parseAnthropicRequest(body);
  if (surface === 'chat_completions') return parseOpenAIChatRequest(body);
  return parseOpenAIResponsesRequest(body);
}

export function parseProviderResponse(surface: ApiSurface, body: unknown): ParsedProviderResponse {
  if (surface === 'messages') return parseAnthropicResponse(body);
  if (surface === 'chat_completions') return parseOpenAIChatResponse(body);
  return parseOpenAIResponsesResponse(body);
}

export function createProviderStreamParser(surface: ApiSurface): ProviderStreamParser {
  if (surface === 'messages') return new AnthropicStreamParser();
  if (surface === 'chat_completions') return new OpenAIChatStreamParser();
  return new OpenAIResponsesStreamParser();
}
