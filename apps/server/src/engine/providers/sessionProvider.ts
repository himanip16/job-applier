import type { Provider, ProviderContext, ProviderOutput } from './types.js';

/**
 * SessionProvider checks if the human answered this field earlier in the same run.
 * This is the highest priority source since it represents explicit user intent.
 */
export const SessionProvider: Provider = {
  name: 'SessionProvider',
  provide(context: ProviderContext): ProviderOutput {
    const { field, ctx } = context;
    const fromSession = ctx.sessionAnswers.get(field.id);
    if (fromSession) {
      return {
        kind: 'answer',
        answer: fromSession,
      };
    }
    return null;
  },
};
