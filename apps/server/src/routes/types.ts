export type RequireProfile = (
  req: { headers: { cookie?: string } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => Promise<{ id: string } | null>;
