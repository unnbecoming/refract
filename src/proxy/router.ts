import type { ApiSurface, Provider, RefractConfig } from '../config.js';

interface RouteDefinition {
  provider: Provider;
  surface: ApiSurface;
  pathname: string;
}

export interface MatchedRoute extends RouteDefinition {
  origin: URL;
  pathAndQuery: string;
}

export type RouteResult =
  | { kind: 'matched'; route: MatchedRoute }
  | { kind: 'rejected'; status: 400 | 404 | 405; code: 'invalid_target' | 'route_not_found' | 'method_not_allowed' };

export const ROUTES: readonly RouteDefinition[] = [
  { provider: 'anthropic', surface: 'messages', pathname: '/v1/messages' },
  { provider: 'openai', surface: 'chat_completions', pathname: '/v1/chat/completions' },
  { provider: 'openai', surface: 'responses', pathname: '/v1/responses' },
];

export function resolveRoute(method: string | undefined, target: string | undefined, config: RefractConfig): RouteResult {
  if (!target || !target.startsWith('/') || target.startsWith('//')) {
    return { kind: 'rejected', status: 400, code: 'invalid_target' };
  }
  const queryAt = target.indexOf('?');
  const pathname = queryAt === -1 ? target : target.slice(0, queryAt);
  const definition = ROUTES.find((route) => route.pathname === pathname);
  if (!definition) return { kind: 'rejected', status: 404, code: 'route_not_found' };
  if (method !== 'POST') return { kind: 'rejected', status: 405, code: 'method_not_allowed' };
  return {
    kind: 'matched',
    route: {
      ...definition,
      origin: config.upstreams[definition.provider],
      pathAndQuery: target,
    },
  };
}
